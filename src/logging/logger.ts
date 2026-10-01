import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

/**
 * Central app logger. Writes every line to the console AND appends it to a
 * log file (logs/kevbot.log by default), so behavior that only used to show
 * up in a terminal — scans, kicks, aborted purges — is preserved on disk.
 *
 * Configuration (.env):
 *   LOG_LEVEL  one of debug | info | warn | error (default: info)
 *   LOG_FILE   full path override (default: <project>/logs/kevbot.log)
 *
 * Config is read lazily on every call: dotenv may be loaded after this
 * module is imported, and tests may change it at runtime.
 *
 * Usage:
 *   import { log } from '../logging/logger';
 *   log.info('Purge started', { guildId, targetCount });
 *   log.error('Purge aborted', err);   // stack included for Errors
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

class Logger {
  // Directory of the currently-active log file; we only mkdir when it changes.
  private activeDir: string | null = null;

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

    const text = Logger.format(args);
    const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${text}`;

    CONSOLE_METHODS[level](line);

    let filePath: string;
    try {
      filePath = Logger.logFilePath();
      const dir = path.dirname(filePath);
      if (this.activeDir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        this.activeDir = dir;
      }
      fs.appendFileSync(filePath, line + '\n');
    } catch (err) {
      console.error('[logger] failed to write log file:', err);
    }
  }

  private static currentMinWeight(): number {
    const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
    return (raw in LEVEL_WEIGHT ? LEVEL_WEIGHT[raw as LogLevel] : LEVEL_WEIGHT.info);
  }

  private static logFilePath(): string {
    const override = process.env.LOG_FILE;
    if (override && override.trim()) return override.trim();
    return path.resolve(__dirname, '../../logs/kevbot.log');
  }

  /** Console-style formatting; a lone Error carries its full stack. */
  private static format(args: unknown[]): string {
    if (args.length === 1 && args[0] instanceof Error) {
      return (args[0] as Error).stack ?? String(args[0]);
    }
    return util.format(...args);
  }
}

export const log = new Logger();
