import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePurgeRoleId, canPurge, replyNoPermission } from '../../src/services/role-gate.service';

/**
 * Tests for the role gate that guards `!purgeDryRun`, `!purge` and
 * `!purge confirm`.
 *
 * This is a security boundary: it decides who may kick members out of a real
 * Discord server. The tests below pin the rules that matter —
 *   - an UNCONFIGURED gate denies everyone (fails closed, never open)
 *   - a user ID is not interchangeable with a role ID (different snowflake
 *     namespaces, so a user ID in PURGE_ROLE_ID can never match a role)
 *   - a malformed admin ID is ignored rather than locking the operator out
 *
 * The Discord objects are plain fakes rather than mocks of discord.js: the
 * gate only touches `author.id`, `guild.roles.cache.has/.find`, and
 * `member.roles.cache.has`, so a literal object exercises the same code path
 * with none of the library's machinery.
 */

const ROLE_ID = '1234567890123456789';   // 19 digits: a plausible snowflake
const OTHER_ROLE_ID = '9876543210987654321';
const USER_ID = '111111111111111111';     // also 18 digits
const OTHER_USER_ID = '222222222222222222';

const savedEnv = { ...process.env };

/** A guild whose roles.cache supports the .has/.find the gate calls. */
function fakeGuild(roleIds: string[] = [], roles: Array<{ id: string; name: string }> = []) {
  const all = roles.length ? roles : roleIds.map((id) => ({ id, name: `role-${id}` }));
  return {
    roles: {
      cache: {
        has: (id: string) => all.some((r) => r.id === id),
        find: (fn: (r: { id: string; name: string }) => boolean) => all.find(fn),
      },
    },
  };
}

function fakeMessage(opts: {
  authorId?: string;
  username?: string;
  guild?: unknown;
  memberRoleIds?: string[];
}) {
  return {
    author: { id: opts.authorId ?? USER_ID, username: opts.username ?? 'kev' },
    guild: opts.guild,
    member: { roles: { cache: { has: (id: string) => (opts.memberRoleIds ?? []).includes(id) } } },
    replies: [] as string[],
    async reply(text: string) { this.replies.push(text); },
  };
}

beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.PURGE_ROLE_ID;
  delete process.env.PURGE_ROLE_NAME;
  delete process.env.PURGE_ADMIN_IDS;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('resolvePurgeRoleId', () => {
  it('returns null without a guild (e.g. a DM)', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    expect(resolvePurgeRoleId(undefined)).toBeNull();
  });

  it('returns PURGE_ROLE_ID when that role exists in the guild', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    expect(resolvePurgeRoleId(fakeGuild([ROLE_ID]))).toBe(ROLE_ID);
  });

  it('ignores PURGE_ROLE_ID when the role is not in the guild', () => {
    // A stale role ID (deleted role, wrong server) must not authorize anyone.
    process.env.PURGE_ROLE_ID = ROLE_ID;
    expect(resolvePurgeRoleId(fakeGuild([OTHER_ROLE_ID]))).toBeNull();
  });

  it('falls back to PURGE_ROLE_NAME, matched case-insensitively', () => {
    process.env.PURGE_ROLE_NAME = 'Purge Admin';
    const guild = fakeGuild([], [{ id: ROLE_ID, name: 'purge admin' }]);
    expect(resolvePurgeRoleId(guild)).toBe(ROLE_ID);
  });

  it('returns null when no role config is set at all', () => {
    expect(resolvePurgeRoleId(fakeGuild([ROLE_ID]))).toBeNull();
  });
});

describe('canPurge — PURGE_ADMIN_IDS', () => {
  it('allows a user listed in PURGE_ADMIN_IDS', () => {
    process.env.PURGE_ADMIN_IDS = USER_ID;
    expect(canPurge(fakeMessage({ authorId: USER_ID, guild: fakeGuild([]) }))).toBe(true);
  });

  it('allows a listed user even when no role is configured', () => {
    // This is the path a solo operator actually takes: no role exists in the
    // guild at all, so the role branch would deny them.
    process.env.PURGE_ADMIN_IDS = `${OTHER_USER_ID}, ${USER_ID}`;
    expect(canPurge(fakeMessage({ authorId: USER_ID }))).toBe(true);
  });

  it('denies a user who is not listed', () => {
    process.env.PURGE_ADMIN_IDS = OTHER_USER_ID;
    expect(canPurge(fakeMessage({ authorId: USER_ID, guild: fakeGuild([]) }))).toBe(false);
  });

  it('does not treat a user ID as a role ID', () => {
    // The whole reason PURGE_ADMIN_IDS and PURGE_ROLE_ID are separate variables:
    // a user ID placed in PURGE_ROLE_ID can never match the guild role cache.
    process.env.PURGE_ROLE_ID = USER_ID;
    expect(canPurge(fakeMessage({ authorId: USER_ID, guild: fakeGuild([USER_ID]) }))).toBe(false);
  });

  it('ignores malformed entries instead of denying everyone', () => {
    // A stray comma or a typo must not lock the operator out of their own bot.
    process.env.PURGE_ADMIN_IDS = `not-an-id, ${USER_ID}, 12345`;
    expect(canPurge(fakeMessage({ authorId: USER_ID }))).toBe(true);
  });

  it('treats whitespace around IDs as insignificant', () => {
    process.env.PURGE_ADMIN_IDS = `  ${USER_ID}  ,  ${OTHER_USER_ID} `;
    expect(canPurge(fakeMessage({ authorId: OTHER_USER_ID }))).toBe(true);
  });
});

describe('canPurge — role membership', () => {
  it('allows a member holding the purge role', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const message = fakeMessage({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] });
    expect(canPurge(message)).toBe(true);
  });

  it('denies a member without the purge role', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const message = fakeMessage({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [OTHER_ROLE_ID] });
    expect(canPurge(message)).toBe(false);
  });

  it('denies when the author has no resolved member', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const message = fakeMessage({ guild: fakeGuild([ROLE_ID]) });
    delete (message as unknown as { member?: unknown }).member;
    expect(canPurge(message)).toBe(false);
  });
});

describe('canPurge — fails closed', () => {
  it('denies everyone when nothing is configured', () => {
    // The critical case: an unconfigured gate must fail CLOSED. If this ever
    // returns true, anyone in the channel can purge the server.
    expect(canPurge(fakeMessage({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] }))).toBe(false);
  });

  it('denies everyone when env vars are set but empty strings', () => {
    process.env.PURGE_ROLE_ID = '';
    process.env.PURGE_ROLE_NAME = '';
    process.env.PURGE_ADMIN_IDS = '   ';
    expect(canPurge(fakeMessage({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] }))).toBe(false);
  });

  it('denies when the message has no author id', () => {
    process.env.PURGE_ADMIN_IDS = USER_ID;
    const message = fakeMessage({ guild: fakeGuild([]) });
    (message as unknown as { author: unknown }).author = {};
    expect(canPurge(message)).toBe(false);
  });
});

describe('replyNoPermission', () => {
  it('reports missing access when a gate IS configured', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const message = fakeMessage({});
    return replyNoPermission(message as never, '!purge').then(() => {
      expect(message.replies).toHaveLength(1);
      expect(message.replies[0]).toContain('purge role');
      expect(message.replies[0]).toContain('!purge');
    });
  });

  it('reports that access is unconfigured when nothing is set', () => {
    // Distinguishing "you lack access" from "nobody configured this" saves the
    // operator a confusing dead end.
    const message = fakeMessage({});
    return replyNoPermission(message as never, '!purgeDryRun').then(() => {
      expect(message.replies[0]).toContain('not configured');
      expect(message.replies[0]).toContain('PURGE_ADMIN_IDS');
      expect(message.replies[0]).toContain('!purgeDryRun');
    });
  });

  it('treats a whitespace-only admin list as unconfigured', () => {
    process.env.PURGE_ADMIN_IDS = '  ';
    const message = fakeMessage({});
    return replyNoPermission(message as never).then(() => {
      expect(message.replies[0]).toContain('not configured');
    });
  });
});
