import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InactiveUserService } from '../../src/services/purge-users.service';
import { WhitelistMalformedError, BlacklistMalformedError } from '../../src/errors';

/**
 * Tests for the pure, decision-making half of the purge: who ends up on the
 * kick list, and what happens when a list file is broken.
 *
 * These deliberately do NOT touch Discord. `getTargetsToKick` reads three JSON
 * files and returns a plan; that is where a mistake silently kicks the wrong
 * person, so it is the part worth pinning down.
 *
 * Every test points KEVBOT_DATA_DIR at a fresh temp dir, so the real
 * data/whitelisted_users.json and data/blacklisted_users.json are never read or
 * overwritten. That env var is read per call (see dataPath in the service), so
 * setting it in beforeEach is enough even though the module is imported above.
 */

let tempDir: string;
const originalDataDir = process.env.KEVBOT_DATA_DIR;

/** Write a list file into the temp data dir. Omit `contents` to write nothing. */
function writeList(name: string, contents?: string): void {
  if (contents === undefined) return;
  fs.writeFileSync(path.join(tempDir, name), contents);
}

function writeInactiveUsers(users: Array<{ username: string; id: string }>): void {
  fs.writeFileSync(
    path.join(tempDir, 'inactive_users.json'),
    JSON.stringify(users, null, 2)
  );
}

beforeEach(() => {
  // mkdtemp, not a fixed name: parallel workers each need their own directory,
  // and a shared name would let one test's whitelist leak into another's.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-test-'));
  process.env.KEVBOT_DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.KEVBOT_DATA_DIR;
  else process.env.KEVBOT_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getTargetsToKick — list precedence', () => {
  it('kicks every inactive user when both lists are absent', () => {
    writeInactiveUsers([
      { username: 'alice', id: '111111111111111111' },
      { username: 'bob', id: '222222222222222222' },
    ]);

    const { targets, skippedWhitelisted } = InactiveUserService.getTargetsToKick();

    expect(targets.map((t) => t.id).sort()).toEqual([
      '111111111111111111',
      '222222222222222222',
    ]);
    expect(skippedWhitelisted).toEqual([]);
  });

  it('skips an inactive user who is whitelisted', () => {
    writeInactiveUsers([
      { username: 'alice', id: '111111111111111111' },
      { username: 'bob', id: '222222222222222222' },
    ]);
    writeList('whitelisted_users.json', JSON.stringify([{ id: '111111111111111111', note: 'alice' }]));

    const { targets, skippedWhitelisted } = InactiveUserService.getTargetsToKick();

    expect(targets.map((t) => t.id)).toEqual(['222222222222222222']);
    expect(skippedWhitelisted).toEqual(['alice (111111111111111111)']);
  });

  it('kicks a blacklisted user even though they are whitelisted', () => {
    // The precedence rule that matters most: blacklist wins, and the override
    // is reported rather than applied quietly.
    writeInactiveUsers([{ username: 'alice', id: '111111111111111111' }]);
    writeList('whitelisted_users.json', JSON.stringify([{ id: '111111111111111111' }]));
    writeList('blacklisted_users.json', JSON.stringify([{ id: '111111111111111111' }]));

    const { targets, skippedWhitelisted, whitelistOverrides } = InactiveUserService.getTargetsToKick();

    expect(targets.map((t) => t.id)).toEqual(['111111111111111111']);
    expect(skippedWhitelisted).toEqual([]);
    expect(whitelistOverrides).toEqual(['alice (111111111111111111)']);
  });

  it('targets a blacklisted user the scan never flagged', () => {
    // An active member can still be force-targeted. The username is unknown
    // until the guild lookup, so it must be an explicit placeholder, never "".
    writeInactiveUsers([]);
    writeList('blacklisted_users.json', JSON.stringify([{ id: '999999999999999999' }]));

    const { targets } = InactiveUserService.getTargetsToKick();

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe('999999999999999999');
    expect(targets[0].username).toBe('unknown (999999999999999999)');
  });

  it('reports each target with reason "inactive"', () => {
    writeInactiveUsers([{ username: 'alice', id: '111111111111111111' }]);
    writeList('blacklisted_users.json', JSON.stringify([{ id: '111111111111111111' }]));

    const { targets } = InactiveUserService.getTargetsToKick();

    expect(targets[0].reason).toBe('inactive');
  });
});

describe('getWhitelistedUserIds — accepted formats', () => {
  it('accepts bare id strings and {id, note} objects together', () => {
    writeList('whitelisted_users.json', JSON.stringify([
      '111111111111111111',
      { id: '222222222222222222', note: 'admin, do not kick' },
    ]));

    expect(InactiveUserService.getWhitelistedUserIds()).toEqual([
      '111111111111111111',
      '222222222222222222',
    ]);
  });

  it('ignores entries whose id is not a numeric snowflake', () => {
    // A typo'd or placeholder id must not silently become a real exemption.
    writeList('whitelisted_users.json', JSON.stringify([
      { id: 'not-a-number' },
      { id: '111111111111111111' },
      { note: 'missing id entirely' },
      null,
      42,
    ]));

    expect(InactiveUserService.getWhitelistedUserIds()).toEqual(['111111111111111111']);
  });

  it('treats a missing file as an empty list', () => {
    // Missing = nobody declared protections. This is safe and must NOT throw.
    expect(InactiveUserService.getWhitelistedUserIds()).toEqual([]);
  });

  it('treats an empty JSON array as an empty list', () => {
    writeList('whitelisted_users.json', '[]');
    expect(InactiveUserService.getWhitelistedUserIds()).toEqual([]);
  });
});

describe('fail-closed behaviour', () => {
  // A broken list must ABORT, never degrade to "empty". Treating a malformed
  // whitelist as empty would unprotect everyone someone tried to save; treating
  // a malformed blacklist as empty would silently skip a target.

  it('throws WhitelistMalformedError when the whitelist is 0 bytes', () => {
    writeList('whitelisted_users.json', '');
    expect(() => InactiveUserService.getWhitelistedUserIds()).toThrow(WhitelistMalformedError);
  });

  it('throws WhitelistMalformedError on invalid JSON', () => {
    writeList('whitelisted_users.json', '{ not json');
    expect(() => InactiveUserService.getWhitelistedUserIds()).toThrow(WhitelistMalformedError);
  });

  it('throws WhitelistMalformedError when the whitelist is not an array', () => {
    writeList('whitelisted_users.json', '{"id":"111111111111111111"}');
    expect(() => InactiveUserService.getWhitelistedUserIds()).toThrow(WhitelistMalformedError);
  });

  it('throws BlacklistMalformedError when the blacklist is 0 bytes', () => {
    writeList('blacklisted_users.json', '');
    expect(() => InactiveUserService.getBlacklistedUserIds()).toThrow(BlacklistMalformedError);
  });

  it('throws BlacklistMalformedError on invalid JSON', () => {
    writeList('blacklisted_users.json', 'nope');
    expect(() => InactiveUserService.getBlacklistedUserIds()).toThrow(BlacklistMalformedError);
  });

  it('propagates a malformed whitelist out of getTargetsToKick', () => {
    // The abort has to happen at the point of decision, not be swallowed and
    // turned into an empty whitelist higher up.
    writeInactiveUsers([{ username: 'alice', id: '111111111111111111' }]);
    writeList('whitelisted_users.json', '');

    expect(() => InactiveUserService.getTargetsToKick()).toThrow(WhitelistMalformedError);
  });
});
