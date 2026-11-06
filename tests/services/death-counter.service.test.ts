import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeathCounterService,
  MAX_NAME_LENGTH,
  normalizeName,
} from '../../src/services/death-counter.service';

/**
 * Tests for the SQLite death counters.
 *
 * Each test gets its own temp data dir via KEVBOT_DATA_DIR, so the real
 * data/kevbot.db the live bot writes is never touched. That isolation is why
 * the service resolves its path per call instead of caching it at import time.
 */

let tempDir: string;
const originalDataDir = process.env.KEVBOT_DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-death-'));
  process.env.KEVBOT_DATA_DIR = tempDir;
});

afterEach(() => {
  DeathCounterService.close();
  if (originalDataDir === undefined) delete process.env.KEVBOT_DATA_DIR;
  else process.env.KEVBOT_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('normalizeName', () => {
  it('trims, collapses inner whitespace, and lowercases the key', () => {
    expect(normalizeName('  Big   Bob  ')).toEqual({ key: 'big bob', name: 'Big Bob' });
  });

  it('keeps the original casing for display', () => {
    expect(normalizeName('Matthew').name).toBe('Matthew');
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(() => normalizeName('   ')).toThrow(/name is required/i);
  });

  it(`rejects a name longer than ${MAX_NAME_LENGTH} characters`, () => {
    expect(() => normalizeName('a'.repeat(MAX_NAME_LENGTH + 1))).toThrow(/characters or fewer/);
  });
});

describe('increment', () => {
  it('creates a character at 1 death', () => {
    expect(DeathCounterService.increment('Matthew')).toEqual({ name: 'Matthew', deaths: 1 });
  });

  it('accumulates across calls', () => {
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');
    expect(DeathCounterService.increment('Matthew')).toEqual({ name: 'Matthew', deaths: 3 });
  });

  it('treats names case-insensitively as one character', () => {
    DeathCounterService.increment('Matthew');
    const second = DeathCounterService.increment('matthew');
    expect(second).toEqual({ name: 'matthew', deaths: 2 });
    expect(DeathCounterService.list()).toHaveLength(1);
  });

  it('updates the display name to the most recent casing', () => {
    DeathCounterService.increment('matthew');
    DeathCounterService.increment('MATTHEW');
    expect(DeathCounterService.get('matthew')).toEqual({ name: 'MATTHEW', deaths: 2 });
  });

  it('stores user input literally instead of interpolating it into SQL', () => {
    // Parameterized statements should make this just a weird character name.
    const hostile = "a' OR '1'='1";
    expect(DeathCounterService.increment(hostile)).toEqual({ name: hostile, deaths: 1 });
    expect(DeathCounterService.list()).toEqual([{ name: hostile, deaths: 1 }]);
  });
});

describe('get', () => {
  it('returns null for a character that was never recorded', () => {
    expect(DeathCounterService.get('Nobody')).toBeNull();
  });

  it('does not create a row just by looking a name up', () => {
    DeathCounterService.get('Nobody');
    expect(DeathCounterService.list()).toEqual([]);
  });

  it('returns the current total', () => {
    DeathCounterService.increment('Kevin');
    DeathCounterService.increment('Kevin');
    expect(DeathCounterService.get('KEVIN')).toEqual({ name: 'Kevin', deaths: 2 });
  });
});

describe('list', () => {
  it('returns an empty array before anyone has died', () => {
    expect(DeathCounterService.list()).toEqual([]);
  });

  it('orders by deaths descending', () => {
    DeathCounterService.increment('Kevin');
    DeathCounterService.increment('Kevin');
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');

    expect(DeathCounterService.list()).toEqual([
      { name: 'Matthew', deaths: 3 },
      { name: 'Kevin', deaths: 2 },
    ]);
  });

  it('breaks ties by name, case-insensitively', () => {
    DeathCounterService.increment('carol');
    DeathCounterService.increment('Alice');
    DeathCounterService.increment('bob');

    expect(DeathCounterService.list().map((c) => c.name)).toEqual(['Alice', 'bob', 'carol']);
  });
});

describe('persistence', () => {
  it('keeps counts after the database handle is closed and reopened', () => {
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');
    expect(fs.existsSync(path.join(tempDir, 'kevbot.db'))).toBe(true);

    DeathCounterService.close();

    expect(DeathCounterService.get('Matthew')).toEqual({ name: 'Matthew', deaths: 2 });
  });
});

describe('isolation', () => {
  it('does not touch the real data/kevbot.db', () => {
    // Guards the reason KEVBOT_DATA_DIR exists: without it these tests would
    // write to the database the live bot is using.
    const realPath = path.resolve(__dirname, '../../data/kevbot.db');
    const before = fs.existsSync(realPath) ? fs.readFileSync(realPath, 'utf8') : null;

    DeathCounterService.increment('Matthew');
    DeathCounterService.list();

    const after = fs.existsSync(realPath) ? fs.readFileSync(realPath, 'utf8') : null;
    expect(after).toBe(before);
  });
});
