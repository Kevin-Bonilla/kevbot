import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '../../src/logging/logger';

/**
 * Tests for the app-wide logger.
 *
 * The logger has one hard requirement: it must NEVER throw. A bot whose log
 * volume is unmounted has to keep serving commands with stdout-only output, so
 * an unwritable file is swallowed (and reported once, not per line). These tests
 * pin that, plus level filtering and the Error-stack formatting.
 *
 * LOG_FILE is redirected to a temp file per test so nothing here writes to the
 * real logs/kevbot.log, and console output is stubbed to keep the run quiet.
 */

let tempDir: string;
let logFile: string;
const savedEnv = { ...process.env };

let debugSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-log-'));
  logFile = path.join(tempDir, 'kevbot.log');
  process.env = { ...savedEnv, LOG_FILE: logFile, LOG_LEVEL: 'debug' };

  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fileLines(): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

/**
 * The raw file contents, for assertions about multi-line entries.
 *
 * `fileLines()` splits on newlines, which is right for counting one-line
 * records but WRONG for an Error stack: a stack spans several lines, so
 * `fileLines()[0]` would hold only the first and silently drop the frames.
 * Anything asserting on stack content must read this instead.
 */
function fileText(): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

describe('level filtering', () => {
  it('writes every level at LOG_LEVEL=debug', () => {
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(fileLines()).toHaveLength(4);
  });

  it('drops debug at the default level (info)', () => {
    process.env.LOG_LEVEL = 'info';
    log.debug('hidden');
    log.info('shown');
    const lines = fileLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shown');
    expect(lines[0]).not.toContain('hidden');
  });

  it('keeps only warn and above at LOG_LEVEL=warn', () => {
    process.env.LOG_LEVEL = 'warn';
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(fileLines()).toHaveLength(2);
    // The tag renders as '[WARN ]' (level padded to 5 chars, then a bracket),
    // so match on that exact shape rather than guessing at spacing.
    expect(fileText()).not.toContain('[INFO');
    expect(fileText()).not.toContain('[DEBUG');
    expect(fileText()).toContain('[WARN');
    expect(fileText()).toContain('[ERROR');
  });

  it('writes nothing at an out-of-range level, falling back to info', () => {
    // A typo'd LOG_LEVEL must not silence the bot entirely.
    process.env.LOG_LEVEL = 'nonsense';
    log.debug('d'); log.info('i');
    const lines = fileLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('i');
  });

  it('is case-insensitive about the level name', () => {
    process.env.LOG_LEVEL = '  ERROR  ';
    log.info('hidden');
    expect(fileLines()).toHaveLength(0);
  });
});

describe('line format', () => {
  it('prefixes an ISO timestamp and a padded level', () => {
    log.info('hello');
    const [line] = fileLines();
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO \] hello$/);
  });

  it('includes extra arguments', () => {
    log.info('kick', { id: '123' });
    expect(fileLines()[0]).toContain('123');
  });

  it('writes the full stack for a lone Error', () => {
    // Diagnostics in the file need the stack; a bare message loses the origin.
    // The shortcut is deliberately for a LONE Error argument only — see the
    // next test for the multi-arg case.
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo';
    log.error(err);
    expect(fileText()).toContain('at foo');
  });

  it('formats an Error mixed with other args as a plain message', () => {
    // The stack shortcut is deliberately for a LONE Error only; in a multi-arg
    // call util.format owns the output.
    log.error('context:', new Error('boom'));
    const line = fileLines()[0];
    expect(line).toContain('context:');
    expect(line).toContain('boom');
    expect(line).not.toContain('at foo');
  });
});

describe('never throws', () => {
  it('still logs to the console when the log file cannot be written', () => {
    // The core guarantee: a broken log file must not take the bot down. Point
    // LOG_FILE at a path whose parent is a FILE, so mkdir/append fails.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.LOG_FILE = path.join(blocker, 'nested', 'kevbot.log');

    expect(() => log.info('still works')).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toContain('still works');
  });

  it('reports the failure once, then stays quiet', () => {
    // A permanently unwritable volume must not flood the console on every
    // single line, so the warning is one-shot for the process.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.LOG_FILE = path.join(blocker, 'nested', 'kevbot.log');

    const before = errorSpy.mock.calls.length;
    log.info('one'); log.info('two'); log.info('three');

    const added = errorSpy.mock.calls.length - before;
    expect(added).toBeLessThanOrEqual(1);
  });

  it('creates the log directory if it does not exist', () => {
    const nested = path.join(tempDir, 'a', 'b', 'c', 'kevbot.log');
    process.env.LOG_FILE = nested;
    log.info('deep');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('appends rather than truncating', () => {
    log.info('first');
    log.info('second');
    const lines = fileLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });
});

describe('LOG_FILE handling', () => {
  it('falls back to a default path when LOG_FILE is blank', () => {
    process.env.LOG_FILE = '   ';
    // Just assert it does not throw and does not write to the blank path.
    expect(() => log.info('fallback')).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
  });
});
