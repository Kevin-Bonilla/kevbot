import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { resolvePurgeRoleId, canPurge, replyNoPermission } from '../../src/services/role-gate.service';

/**
 * Tests for the role gate that guards `/purge dry-run` and `/purge preview`
 * (and therefore the Confirm button on a purge preview).
 *
 * This is a security boundary: it decides who may kick members out of a real
 * Discord server. The tests below pin the rules that matter —
 *   - an UNCONFIGURED gate denies everyone (fails closed, never open)
 *   - a user ID is not interchangeable with a role ID (different snowflake
 *     namespaces, so a user ID in PURGE_ROLE_ID can never match a role)
 *   - a malformed admin ID is ignored rather than locking the operator out
 *
 * The Discord objects are plain fakes rather than mocks of discord.js: the
 * gate only touches `user.id`, `user.username`, `guild.roles.cache.has/.find`,
 * and `member.roles.cache.has`, so a literal object exercises the same code
 * path with none of the library's machinery. The cast at the call sites is
 * the same pattern tests/commands/death.test.ts uses for fake interactions.
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

type ReplyPayload = string | { content: string; flags?: number };
type RecordedReply = { content: string; flags?: number; via: 'reply' | 'followUp' };

/** Minimal stand-in for the parts of an interaction the gate uses. */
function fakeInteraction(opts: {
  userId?: string | null;
  username?: string;
  guild?: unknown;
  memberRoleIds?: string[];
  deferred?: boolean;
}) {
  const replies: RecordedReply[] = [];
  const record = (payload: ReplyPayload, via: RecordedReply['via']) => {
    replies.push({
      content: typeof payload === 'string' ? payload : payload.content,
      flags: typeof payload === 'string' ? undefined : payload.flags,
      via,
    });
  };

  const interaction = {
    user: {
      id: opts.userId === null ? undefined : opts.userId ?? USER_ID,
      username: opts.username ?? 'kev',
    },
    guild: opts.guild,
    member: {
      roles: { cache: { has: (id: string) => (opts.memberRoleIds ?? []).includes(id) } },
    },
    replied: false,
    deferred: opts.deferred ?? false,
    replies,
    async reply(payload: ReplyPayload) {
      interaction.replied = true;
      record(payload, 'reply');
    },
    async followUp(payload: ReplyPayload) {
      record(payload, 'followUp');
    },
  };
  return interaction;
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
    expect(canPurge(fakeInteraction({ userId: USER_ID, guild: fakeGuild([]) }) as never)).toBe(true);
  });

  it('allows a listed user even when no role is configured', () => {
    // This is the path a solo operator actually takes: no role exists in the
    // guild at all, so the role branch would deny them.
    process.env.PURGE_ADMIN_IDS = `${OTHER_USER_ID}, ${USER_ID}`;
    expect(canPurge(fakeInteraction({ userId: USER_ID }) as never)).toBe(true);
  });

  it('denies a user who is not listed', () => {
    process.env.PURGE_ADMIN_IDS = OTHER_USER_ID;
    expect(canPurge(fakeInteraction({ userId: USER_ID, guild: fakeGuild([]) }) as never)).toBe(false);
  });

  it('does not treat a user ID as a role ID', () => {
    // The whole reason PURGE_ADMIN_IDS and PURGE_ROLE_ID are separate variables:
    // a user ID placed in PURGE_ROLE_ID can never match the guild role cache.
    process.env.PURGE_ROLE_ID = USER_ID;
    expect(
      canPurge(fakeInteraction({ userId: USER_ID, guild: fakeGuild([USER_ID]) }) as never)
    ).toBe(false);
  });

  it('ignores malformed entries instead of denying everyone', () => {
    // A stray comma or a typo must not lock the operator out of their own bot.
    process.env.PURGE_ADMIN_IDS = `not-an-id, ${USER_ID}, 12345`;
    expect(canPurge(fakeInteraction({ userId: USER_ID }) as never)).toBe(true);
  });

  it('treats whitespace around IDs as insignificant', () => {
    process.env.PURGE_ADMIN_IDS = `  ${USER_ID}  ,  ${OTHER_USER_ID} `;
    expect(canPurge(fakeInteraction({ userId: OTHER_USER_ID }) as never)).toBe(true);
  });
});

describe('canPurge — role membership', () => {
  it('allows a member holding the purge role', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const interaction = fakeInteraction({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] });
    expect(canPurge(interaction as never)).toBe(true);
  });

  it('denies a member without the purge role', () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const interaction = fakeInteraction({
      guild: fakeGuild([ROLE_ID]),
      memberRoleIds: [OTHER_ROLE_ID],
    });
    expect(canPurge(interaction as never)).toBe(false);
  });

  it('denies when the interaction has no resolved member', () => {
    // In a DM `member` is null; a guild-scoped command should not reach here,
    // but the gate must deny rather than throw if it does.
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const interaction = fakeInteraction({ guild: fakeGuild([ROLE_ID]) });
    (interaction as unknown as { member: unknown }).member = null;
    expect(canPurge(interaction as never)).toBe(false);
  });
});

describe('canPurge — fails closed', () => {
  it('denies everyone when nothing is configured', () => {
    // The critical case: an unconfigured gate must fail CLOSED. If this ever
    // returns true, anyone in the channel can purge the server.
    expect(
      canPurge(fakeInteraction({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] }) as never)
    ).toBe(false);
  });

  it('denies everyone when env vars are set but empty strings', () => {
    process.env.PURGE_ROLE_ID = '';
    process.env.PURGE_ROLE_NAME = '';
    process.env.PURGE_ADMIN_IDS = '   ';
    expect(
      canPurge(fakeInteraction({ guild: fakeGuild([ROLE_ID]), memberRoleIds: [ROLE_ID] }) as never)
    ).toBe(false);
  });

  it('denies when the interaction has no user id', () => {
    process.env.PURGE_ADMIN_IDS = USER_ID;
    expect(canPurge(fakeInteraction({ userId: null, guild: fakeGuild([]) }) as never)).toBe(false);
  });
});

describe('replyNoPermission', () => {
  it('reports missing access when a gate IS configured', async () => {
    process.env.PURGE_ROLE_ID = ROLE_ID;
    const interaction = fakeInteraction({});
    await replyNoPermission(interaction as never, '/purge preview');

    expect(interaction.replies).toHaveLength(1);
    expect(interaction.replies[0].content).toContain('purge role');
    expect(interaction.replies[0].content).toContain('/purge preview');
  });

  it('reports that access is unconfigured when nothing is set', async () => {
    // Distinguishing "you lack access" from "nobody configured this" saves the
    // operator a confusing dead end.
    const interaction = fakeInteraction({});
    await replyNoPermission(interaction as never, '/purge');

    expect(interaction.replies[0].content).toContain('not configured');
    expect(interaction.replies[0].content).toContain('PURGE_ADMIN_IDS');
    expect(interaction.replies[0].content).toContain('/purge');
  });

  it('treats a whitespace-only admin list as unconfigured', async () => {
    process.env.PURGE_ADMIN_IDS = '  ';
    const interaction = fakeInteraction({});
    await replyNoPermission(interaction as never);
    expect(interaction.replies[0].content).toContain('not configured');
  });

  it('is ephemeral', async () => {
    // A denial is not something the channel needs to see, and for the purge it
    // would otherwise advertise that the command is configured at all.
    const interaction = fakeInteraction({});
    await replyNoPermission(interaction as never);

    expect(interaction.replies[0].flags).toBe(MessageFlags.Ephemeral);
  });

  it('answers with a follow-up when the interaction was already deferred', async () => {
    // /purge dry-run defers before the slow scan; a later denial must not try
    // to reply a second time, which would throw and hide the real message.
    const interaction = fakeInteraction({ deferred: true });
    await replyNoPermission(interaction as never);

    expect(interaction.replies).toHaveLength(1);
    expect(interaction.replies[0].via).toBe('followUp');
  });
});
