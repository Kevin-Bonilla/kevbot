import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log, logTarget } from '../../src/logging/logger';

/**
 * Tests for the JSON file format (LOG_FORMAT=json) and logTarget().
 *
 * JSON is the format the OCI Unified Monitoring Agent parses on the VM
 * (see deploy/oci-logging/README.md), so the properties asserted here are
 * load-bearing rather than cosmetic:
 *
 *   - one JSON object per line (a raw newline splits a record in two)
 *   - a `level` field to filter on in OCI Log Search
 *   - an Error's stack escaped INTO the record instead of spanning lines
 *   - the console copy staying text, because journald is read by people
 *
 * The text-format behaviour is pinned by logger.test.ts; this file covers the
 * mode that was added for OCI ingestion.
 */

let tempDir: string;
let logFile: string;
const savedEnv = { ...process.env };

let debugSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-json-'));
  logFile = path.join(tempDir, 'kevbot.log');
  process.env = {
    ...savedEnv,
    LOG_FILE: logFile,
    LOG_LEVEL: 'debug',
    LOG_FORMAT: 'json',
  };

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

function lines(): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

function record(index = 0): Record<string, any> {
  const line = lines()[index];
  if (line === undefined) throw new Error(`no log line at index ${index}`);
  return JSON.parse(line);
}

describe('json file format', () => {
  it('writes one JSON object per line with the fields OCI indexes', () => {
    log.info('hello');
    const entries = lines();
    expect(entries).toHaveLength(1);

    const rec = record();
    expect(rec.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(rec.level).toBe('info');
    expect(rec.service).toBe('kevbot');
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.host).toBe('string');
    expect(rec.msg).toBe('hello');
  });

  it('keeps the console copy as text even in json mode', () => {
    // journalctl is read by humans; only the file is machine-parsed.
    log.info('hello');
    expect(logSpy.mock.calls[0][0]).toMatch(/^\[[^\]]+\] \[INFO \] hello$/);
  });

  it('flattens extra arguments into msg', () => {
    log.info('kick', { id: '123' });
    expect(record().msg).toContain('123');
  });

  it('turns an Error into structured fields in a single line', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo';

    log.error('Command failed:', err);

    // One line, not one line per stack frame.
    expect(lines()).toHaveLength(1);

    const rec = record();
    expect(rec.level).toBe('error');
    expect(rec.msg).toBe('Command failed:');
    expect(rec.error).toMatchObject({ name: 'Error', message: 'boom' });
    // The stack survives, escaped inside the JSON string.
    expect(rec.error.stack).toContain('at foo');
    expect(rec.error.stack).toContain('\n');
  });

  it('uses the message as msg for a lone Error', () => {
    log.error(new Error('boom'));
    const rec = record();
    expect(rec.msg).toBe('boom');
    expect(rec.error.message).toBe('boom');
  });

  it('preserves errno codes, and omits the key when there is none', () => {
    const withCode = Object.assign(new Error('nope'), { code: 'EACCES' });
    log.error('file:', withCode);
    expect(record().error.code).toBe('EACCES');

    log.error('plain:', new Error('plain'));
    expect(record(1).error).not.toHaveProperty('code');
  });

  it('falls back to text for an unrecognized LOG_FORMAT', () => {
    process.env.LOG_FORMAT = 'yaml';
    log.info('fallback');
    expect(lines()[0]).toMatch(/^\[[^\]]+\] \[INFO \] fallback$/);
  });

  it('accepts LOG_FORMAT in any case', () => {
    process.env.LOG_FORMAT = '  JSON ';
    log.info('shouty');
    expect(record().msg).toBe('shouty');
  });

  it('applies LOG_LEVEL before serializing', () => {
    process.env.LOG_LEVEL = 'warn';
    log.info('dropped');
    expect(lines()).toHaveLength(0);

    log.warn('kept');
    expect(record().level).toBe('warn');
  });
});

describe('logTarget', () => {
  it('reports the effective level, format, and file', () => {
    process.env.LOG_LEVEL = 'warn';
    process.env.LOG_FORMAT = 'json';
    expect(logTarget()).toEqual({ level: 'warn', format: 'json', file: logFile });
  });

  it('resolves a relative LOG_FILE to an absolute path', () => {
    // The startup line has to name the real file the agent tails; a literal
    // relative path would be unhelpful in the OCI console.
    process.env.LOG_FILE = 'logs/relative.log';
    const target = logTarget();
    expect(path.isAbsolute(target.file)).toBe(true);
    expect(target.file).toBe(path.resolve('logs/relative.log'));
  });

  it('defaults to text when LOG_FORMAT is unset', () => {
    delete process.env.LOG_FORMAT;
    expect(logTarget().format).toBe('text');
  });

  it('falls back to info for an unknown LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'loud';
    expect(logTarget().level).toBe('info');
  });
});
