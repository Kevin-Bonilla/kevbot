import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CounterService } from '../../src/services/counter.service';

/**
 * Tests for the persistent counter behind `!counter`.
 *
 * Each test gets its own temp data dir via KEVBOT_DATA_DIR, so the real
 * data/counter.json — which is tracked in git and shared with the running bot —
 * is never read or written. That isolation is the whole reason the service
 * resolves its path per call instead of caching it at import time.
 */

let tempDir: string;
const originalDataDir = process.env.KEVBOT_DATA_DIR;

function seedCounter(count: number): void {
  fs.writeFileSync(path.join(tempDir, 'counter.json'), JSON.stringify({ count }, null, 2));
}

function readCounter(): number {
  return JSON.parse(fs.readFileSync(path.join(tempDir, 'counter.json'), 'utf8')).count;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-counter-'));
  process.env.KEVBOT_DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.KEVBOT_DATA_DIR;
  else process.env.KEVBOT_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getCount', () => {
  it('returns the persisted value', () => {
    seedCounter(7);
    expect(CounterService.getCount()).toBe(7);
  });

  it('returns 0 for a freshly seeded counter', () => {
    seedCounter(0);
    expect(CounterService.getCount()).toBe(0);
  });
});

describe('increment', () => {
  it('returns the new value and persists it', () => {
    seedCounter(4);
    expect(CounterService.increment()).toBe(5);
    expect(readCounter()).toBe(5);
  });

  it('accumulates across successive calls', () => {
    seedCounter(0);
    expect(CounterService.increment()).toBe(1);
    expect(CounterService.increment()).toBe(2);
    expect(CounterService.increment()).toBe(3);
    expect(readCounter()).toBe(3);
  });

  it('is visible to getCount immediately after', () => {
    seedCounter(10);
    CounterService.increment();
    expect(CounterService.getCount()).toBe(11);
  });

  it('reads fresh state rather than a cached copy', () => {
    // The regression this guards: an earlier version cached the parsed JSON in
    // a static field, so an external write (a second process, a manual edit)
    // was invisible and the next increment silently overwrote it.
    seedCounter(1);
    expect(CounterService.getCount()).toBe(1);

    fs.writeFileSync(path.join(tempDir, 'counter.json'), JSON.stringify({ count: 99 }));

    expect(CounterService.getCount()).toBe(99);
    expect(CounterService.increment()).toBe(100);
    expect(readCounter()).toBe(100);
  });

  it('preserves other keys in the file', () => {
    // Writing back the whole object means an unrelated field must survive.
    fs.writeFileSync(
      path.join(tempDir, 'counter.json'),
      JSON.stringify({ count: 1, updatedBy: 'kev' }, null, 2)
    );
    CounterService.increment();
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, 'counter.json'), 'utf8'));
    expect(raw).toEqual({ count: 2, updatedBy: 'kev' });
  });
});

describe('isolation', () => {
  it('does not touch the real data/counter.json', () => {
    // Guards the reason KEVBOT_DATA_DIR exists at all: without it these tests
    // would rewrite the tracked counter the live bot is using.
    const realPath = path.resolve(__dirname, '../../data/counter.json');
    const before = fs.existsSync(realPath) ? fs.readFileSync(realPath, 'utf8') : null;

    seedCounter(0);
    CounterService.increment();
    CounterService.increment();

    const after = fs.existsSync(realPath) ? fs.readFileSync(realPath, 'utf8') : null;
    expect(after).toBe(before);
  });
});
