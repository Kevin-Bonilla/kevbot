import { describe, it, expect } from 'vitest';
import { KevbotError } from '../../src/errors/kevbot-error';
import {
  UserListMalformedError,
  WhitelistMalformedError,
  BlacklistMalformedError,
} from '../../src/errors/purge-errors';

/**
 * Tests for the error types behind the purge's fail-closed abort.
 *
 * The property that matters here is a DISCLOSURE one. These errors are caught in
 * src/commands/purge.ts and `message` is posted verbatim into a Discord channel
 * while `detail` goes to the log. The purge is role-gated, but an operator
 * running it is still in a channel other members can read, so `message` must
 * never name which list exists or which file backs it — otherwise posting an
 * error would tell the server that a blacklist exists and where to find it.
 */

describe('KevbotError', () => {
  it('sets name from the concrete subclass', () => {
    // this.name = new.target.name, so callers can branch on a type rather than
    // string-matching a message.
    class CustomError extends KevbotError {}
    expect(new CustomError('boom').name).toBe('CustomError');
    expect(new KevbotError('boom').name).toBe('KevbotError');
  });

  it('attaches an Error cause but ignores a non-Error cause', () => {
    const cause = new Error('root');
    expect(new KevbotError('boom', cause).cause).toBe(cause);
    expect(new KevbotError('boom', 'a string').cause).toBeUndefined();
  });

  it('is a real Error, so it survives throw/catch and instanceof', () => {
    const err = new KevbotError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(() => { throw err; }).toThrow(KevbotError);
  });
});

describe('UserListMalformedError', () => {
  it('keeps the list name and path out of the channel-facing message', () => {
    const err = new UserListMalformedError(
      'blacklist',
      '/opt/kevbot/data/blacklisted_users.json',
      'it must be a JSON array'
    );

    expect(err.message).not.toContain('blacklist');
    expect(err.message).not.toContain('blacklisted_users.json');
    expect(err.message).not.toContain('/opt/kevbot');
  });

  it('puts the diagnosis in detail, for the log only', () => {
    const err = new UserListMalformedError(
      'blacklist',
      '/opt/kevbot/data/blacklisted_users.json',
      'it must be a JSON array'
    );

    expect(err.detail).toContain('blacklist');
    expect(err.detail).toContain('/opt/kevbot/data/blacklisted_users.json');
  });

  it('says no one was kicked and points at the recovery step', () => {
    // The operator reading this in channel needs to know the purge was a no-op
    // and what to do next, without leaking which file is broken.
    const err = new UserListMalformedError('whitelist', '/x/y.json', 'shape');
    expect(err.message).toMatch(/aborted/i);
    expect(err.message).toMatch(/no one was kicked/i);
    expect(err.message).toContain('!purge');
  });

  it('includes the cause message in detail when given an Error', () => {
    const err = new UserListMalformedError('whitelist', '/x/y.json', 'shape', new Error('Unexpected token'));
    expect(err.detail).toContain('Unexpected token');
  });

  it('omits the cause suffix for a non-Error cause', () => {
    const err = new UserListMalformedError('whitelist', '/x/y.json', 'shape', 'not an error');
    expect(err.detail).not.toContain('not an error');
  });
});

describe('WhitelistMalformedError / BlacklistMalformedError', () => {
  it('both extend UserListMalformedError', () => {
    // One catch site in purge.ts handles either, which is why the shared base
    // exists.
    expect(new WhitelistMalformedError()).toBeInstanceOf(UserListMalformedError);
    expect(new BlacklistMalformedError()).toBeInstanceOf(UserListMalformedError);
  });

  it('are distinguishable from each other by type', () => {
    expect(new WhitelistMalformedError()).toBeInstanceOf(WhitelistMalformedError);
    expect(new WhitelistMalformedError()).not.toBeInstanceOf(BlacklistMalformedError);
    expect(new BlacklistMalformedError()).toBeInstanceOf(BlacklistMalformedError);
    expect(new BlacklistMalformedError()).not.toBeInstanceOf(WhitelistMalformedError);
  });

  it('carry the right name for logging', () => {
    expect(new WhitelistMalformedError().name).toBe('WhitelistMalformedError');
    expect(new BlacklistMalformedError().name).toBe('BlacklistMalformedError');
  });

  it('name their own list in detail', () => {
    expect(new WhitelistMalformedError().detail).toContain('whitelist');
    expect(new BlacklistMalformedError().detail).toContain('blacklist');
  });

  it('never disclose which list or file in the channel message', () => {
    // Same disclosure rule as the base class: the channel sees a generic abort.
    for (const err of [new WhitelistMalformedError(), new BlacklistMalformedError()]) {
      expect(err.message).not.toMatch(/whitelist|blacklist/i);
      expect(err.message).not.toMatch(/\.json/);
    }
  });
});
