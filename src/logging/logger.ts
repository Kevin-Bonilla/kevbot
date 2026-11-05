import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

/**
 * Central app logger. Writes every line to the console AND appends it to a
 * log file (logs/kevbot.log by default), so behavior that only used to show
 * up in a terminal — scans, kicks, aborted purges — is preserved on disk.
 *
 * Configuration (.env):
 *   LOG_LEVEL   one of debug | info | warn | error (default: info)
 *   LOG_FORMAT  text | json — serialization of the LOG FILE (default: text)
 *   LOG_FILE    full path override (default: <project>/logs/kevbot.log)
 *
 * Config is read lazily on every call: dotenv may be loaded after this
 * module is imported, and tests may change it at runtime.
 *
 * Why LOG_FORMAT exists: on the Oracle VM the file is the ingestion source for
 * the OCI Unified Monitoring Agent, which tails it and ships it to OCI Logging.
 * With `json`, each entry is one self-contained JSON object (`time`, `level`,
 * `msg`, ...) so OCI's JSON parser can index the fields and a stack trace stays
 * a single log record instead of a dozen disconnected lines. See
 * deploy/oci-logging/README.md.
 *
 * The console copy is always text, regardless of LOG_FORMAT: journald is read
 * by humans, and `journalctl -u kevbot` should stay legible.
 *
 * Usage:
 *   import { log } from '../logging/logger';
 *   log.info('Purge started', { guildId, targetCount });
 *   log.error('Purge aborted', err);   // stack included for Errors
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CONSOLE_METHODS: Record<LogLevel, (line: string) => void> = {
  debug: (l) => console.debug(l),
  info: (l) => console.log(l),
  warn: (l) => console.warn(l),
  error: (l) => console.error(l),
};

/** Constant field on every JSON record; makes OCI Log Search queries easy. */
const SERVICE_NAME = 'kevbot';

class Logger {
  // Directory of the currently-active log file; we only mkdir when it changes.
  private activeDir: string | null = null;
  // One-shot flag so a permanently unwritable log file cannot flood the console.
  private static warnedAboutFile = false;
  // os.hostname() is a syscall; resolve it once instead of on every line.
  private static cachedHost: string | null = null;

  debug(...args: unknown[]): void { this.write('debug', args); }
  info(...args: unknown[]): void { this.write('info', args); }
  warn(...args: unknown[]): void { this.write('warn', args); }
  error(...args: unknown[]): void { this.write('error', args); }

  /**
   * Logs one entry at `level`. Never throws: a broken or unwritable log
   * file must not take the bot down — the console copy goes out either way.
   */
  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < Logger.currentMinWeight()) return;

    // One timestamp for both copies, so the journald line and the file line
    // always agree and can be correlated.
    const at = new Date();
    const text = Logger.textLine(at, level, args);

    CONSOLE_METHODS[level](text);

    let filePath = '<unresolved>';
    try {
      filePath = Logger.logFilePath();
      const dir = path.dirname(filePath);
      if (this.activeDir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        this.activeDir = dir;
      }
      const line = Logger.currentFormat() === 'json' ? Logger.jsonLine(at, level, args) : text;
      fs.appendFileSync(filePath, line + '\n');
    } catch (err) {
      // A broken log file must not take the bot down, and must not spam the
      // console on every single line. Warn once with the cause (usually a
      // permissions problem on a mounted volume) then stay quiet.
      if (!Logger.warnedAboutFile) {
        Logger.warnedAboutFile = true;
        console.error(
          `[logger] cannot write log file (${filePath}): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Continuing without the file log; see stdout/journald.'
        );
      }
    }
  }

  /** `[2026-11-04T19:58:13.123Z] [INFO ] message` */
  private static textLine(at: Date, level: LogLevel, args: unknown[]): string {
    return `[${at.toISOString()}] [${level.toUpperCase().padEnd(5)}] ${Logger.format(args)}`;
  }

  /**
   * One JSON object per line, no inner newlines (stack traces are escaped),
   * which is what OCI Logging's JSON parser wants:
   *   {"time":"2026-11-04T19:58:13.123Z","level":"error","service":"kevbot",
   *    "host":"...","pid":42,"msg":"Command purge failed:",
   *    "error":{"name":"KevbotError","message":"...","stack":"..."}}
   */
  private static jsonLine(at: Date, level: LogLevel, args: unknown[]): string {
    // Pull an Error out of the arguments so it becomes structured fields
    // instead of being flattened into the message string.
    const error = args.find((a): a is Error => a instanceof Error);
    const rest = error ? args.filter((a) => a !== error) : args;
    const msg = rest.length > 0 ? util.format(...rest).trim() : (error?.message ?? '');

    const record: Record<string, unknown> = {
      time: at.toISOString(),
      level,
      service: SERVICE_NAME,
      host: Logger.hostname(),
      pid: process.pid,
      msg,
    };

    if (error) {
      record.error = {
        name: error.name,
        message: error.message,
        // errno-style codes (EPIPE, EACCES, ...) are the useful part of
        // filesystem/network failures, so keep them when present.
        code: (error as NodeJS.ErrnoException).code,
        stack: error.stack,
      };
    }

    return JSON.stringify(record);
  }

  private static hostname(): string {
    if (Logger.cachedHost === null) {
      try {
        Logger.cachedHost = os.hostname();
      } catch {
        Logger.cachedHost = 'unknown';
      }
    }
    return Logger.cachedHost;
  }

  private static currentLevel(): LogLevel {
    const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
    return (raw in LEVEL_WEIGHT ? raw : 'info') as LogLevel;
  }

  private static currentMinWeight(): number {
    return LEVEL_WEIGHT[Logger.currentLevel()];
  }

  private static currentFormat(): LogFormat {
    return (process.env.LOG_FORMAT ?? 'text').trim().toLowerCase() === 'json' ? 'json' : 'text';
  }

  private static logFilePath(): string {
    const override = process.env.LOG_FILE;
    // Resolve overrides: the startup line must name the real file the agent
    // has to tail, and the container's cwd is /app, so a relative
    // `logs/kevbot.log` is /app/logs/kevbot.log — not the literal string.
    if (override && override.trim()) return path.resolve(override.trim());
    return path.resolve(__dirname, '../../logs/kevbot.log');
  }

  /** Console-style formatting; a lone Error carries its full stack. */
  private static format(args: unknown[]): string {
    if (args.length === 1 && args[0] instanceof Error) {
      return (args[0] as Error).stack ?? String(args[0]);
    }
    return util.format(...args);
  }

  static target(): LogTarget {
    return {
      level: Logger.currentLevel(),
      format: Logger.currentFormat(),
      file: Logger.logFilePath(),
    };
  }
}

export interface LogTarget {
  level: LogLevel;
  /** Format of the log FILE; the console is always text. */
  format: LogFormat;
  /** Absolute path of the appended log file. */
  file: string;
}

/**
 * The effective logging configuration. Log it once at startup so the journal
 * and the OCI log both record which file the agent is supposed to be tailing —
 * the single most common reason "logs aren't showing up in OCI".
 */
export function logTarget(): LogTarget {
  return Logger.target();
}

export const log = new Logger();
