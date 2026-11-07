import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import {
  PURGE_BUTTON_IDS,
  formatPreview,
  formatPurgeSummary,
  handlePurgeButton,
  purgeCommand,
  resetPendingPurgeForTests,
} from '../../src/commands/purge';
import { InactiveUserService } from '../../src/services/purge-users.service';
import { WhitelistMalformedError } from '../../src/errors';
import type { PurgeResult } from '../../src/types/users';

/**
 * Command-level tests for `/purge`.
 *
 * The scan itself is covered by tests/services/purge-users.service.test.ts;
 * what matters here is the part the message commands used to own and the
 * buttons now own:
 *   - the preview reports a count and never names a list,
 *   - arming is refused when the gate is unconfigured or there is no scan,
 *   - Confirm/Cancel is same-user, same-channel, same-message, inside 60s,
 *   - a replaced preview's buttons cannot confirm the newer purge,
 *   - the run is re-authorized on the click, not just when it was armed.
 *
 * Fakes are literal objects, matching tests/commands/death.test.ts.
 */

const USER_ID = '111111111111111111';
const OTHER_USER_ID = '222222222222222222';
const CHANNEL_ID = '1552121753692667977';
const PREVIEW_MESSAGE_ID = '333333333333333333';

let tempDir: string;
const savedEnv = { ...process.env };

const USERS = [
  { username: 'one', id: '444444444444444444' },
  { username: 'two', id: '555555555555555555' },
];

type Recorded = { content?: string; flags?: number; components?: unknown[] };

/** discord.js accepts a bare string anywhere a message payload is expected. */
function recorded(payload: Recorded | string): Recorded {
  return typeof payload === 'string' ? { content: payload } : payload;
}

function fakeGuild() {
  return {
    roles: {
      cache: {
        has: () => false,
        find: () => undefined,
      },
    },
  };
}

function writeInactiveUsers(users: Array<{ username: string; id: string }>): void {
  fs.writeFileSync(path.join(tempDir, 'inactive_users.json'), JSON.stringify(users, null, 2));
}

function writeList(file: string, ids: string[]): void {
  fs.writeFileSync(path.join(tempDir, file), JSON.stringify(ids.map((id) => ({ id })), null, 2));
}

/** Fake for `/purge <subcommand>`. */
function fakeSlashInteraction(opts: {
  subcommand?: string;
  messageId?: string | null;
} = {}) {
  const replies: Recorded[] = [];
  const edits: Recorded[] = [];
  let replied = false;
  let deferred = false;

  const interaction = {
    user: { id: USER_ID, username: 'kev' },
    guild: fakeGuild(),
    member: { roles: { cache: { has: () => false } } },
    channelId: CHANNEL_ID,
    client: {},
    options: { getSubcommand: () => opts.subcommand ?? 'preview' },
    get replied() { return replied; },
    get deferred() { return deferred; },
    async reply(payload: Recorded | string) {
      replied = true;
      replies.push(recorded(payload));
      const messageId = opts.messageId === undefined ? PREVIEW_MESSAGE_ID : opts.messageId;
      return { resource: messageId ? { message: { id: messageId } } : { message: null } };
    },
    async followUp(payload: Recorded | string) {
      replies.push(recorded(payload));
    },
    async deferReply() {
      deferred = true;
    },
    async editReply(payload: Recorded | string) {
      edits.push(recorded(payload));
    },
  };
  return { interaction, replies, edits };
}

/** Fake for a click on a purge preview button. */
function fakeButtonInteraction(opts: {
  customId?: string;
  userId?: string;
  messageId?: string;
  channelId?: string;
} = {}) {
  const replies: Recorded[] = [];
  const updates: Recorded[] = [];
  const edits: Recorded[] = [];

  const interaction = {
    customId: opts.customId ?? PURGE_BUTTON_IDS.confirm,
    user: { id: opts.userId ?? USER_ID, username: 'kev' },
    guild: fakeGuild(),
    member: { roles: { cache: { has: () => false } } },
    channelId: opts.channelId ?? CHANNEL_ID,
    message: { id: opts.messageId ?? PREVIEW_MESSAGE_ID },
    replied: false,
    deferred: false,
    async reply(payload: Recorded | string) {
      replies.push(recorded(payload));
    },
    async followUp(payload: Recorded | string) {
      replies.push(recorded(payload));
    },
    async update(payload: Recorded | string) {
      updates.push(recorded(payload));
    },
    async editReply(payload: Recorded | string) {
      edits.push(recorded(payload));
    },
  };
  return { interaction, replies, updates, edits };
}

function kick(id: string, status: 'kicked' | 'failed'): PurgeResult['kicked'][number] {
  return { id, username: `user-${id}`, status, at: '2026-11-07T00:00:00.000Z' };
}

function purgeResult(overrides: Partial<PurgeResult> = {}): PurgeResult {
  return {
    timestamp: '2026-11-07T00:00:00.000Z',
    totalTargets: 3,
    kicked: [kick('1', 'kicked'), kick('2', 'kicked')],
    failed: [kick('3', 'failed')],
    whitelistedSkipped: [],
    blacklisted: [],
    whitelistOverrides: [],
    skippedUnkickable: ['someone (9) — is a bot'],
    ...overrides,
  };
}

/** Arms a purge with `users.length` scanned targets, via the real preview path. */
async function arm(users: Array<{ username: string; id: string }> = USERS) {
  writeInactiveUsers(users);
  const fake = fakeSlashInteraction();
  await purgeCommand.execute(fake.interaction as unknown as ChatInputCommandInteraction);
  return fake;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-purge-cmd-'));
  process.env = { ...savedEnv };
  process.env.KEVBOT_DATA_DIR = tempDir;
  process.env.LOG_FILE = path.join(tempDir, 'kevbot.log');
  delete process.env.PURGE_ROLE_ID;
  delete process.env.PURGE_ROLE_NAME;
  process.env.PURGE_ADMIN_IDS = USER_ID;
  resetPendingPurgeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...savedEnv };
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('preview formatting', () => {
  it('reports a count and the confirmation window without naming a list', () => {
    const text = formatPreview(3, 1);

    expect(text).toContain('3 users will be kicked');
    expect(text).toContain('1 whitelisted skipped');
    expect(text).toContain('60 seconds');
    expect(text).toContain('Confirm');
    // The blacklist is operator-only information; the preview is a count.
    expect(text.toLowerCase()).not.toContain('blacklist');
  });

  it('uses the singular for one target', () => {
    expect(formatPreview(1, 0)).toContain('1 user will be kicked');
  });

  it('summarises a completed run in counts only', () => {
    const text = formatPurgeSummary(purgeResult());

    expect(text).toContain('2 kicked');
    expect(text).toContain('1 failed');
    expect(text).toContain('1 skipped');
    expect(text).toContain('data/purge_results.json');
    expect(text.toLowerCase()).not.toContain('blacklist');
  });
});

describe('/purge preview — arming', () => {
  it('refuses when the purge gate is not configured', async () => {
    delete process.env.PURGE_ADMIN_IDS;
    const { interaction, replies } = fakeSlashInteraction();

    await purgeCommand.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(replies[0].content).toContain('not configured');
    expect(replies[0].flags).toBe(MessageFlags.Ephemeral);

    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);
    expect(click.replies[0].content).toContain('No purge is armed');
  });

  it('points at /purge dry-run when no scan has ever run', async () => {
    const { interaction, replies } = fakeSlashInteraction();

    await purgeCommand.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(replies[0].content).toContain('/purge dry-run');
    expect(replies[0].flags).toBe(MessageFlags.Ephemeral);
  });

  it('reports an all-whitelisted scan instead of arming', async () => {
    writeInactiveUsers(USERS);
    writeList('whitelisted_users.json', USERS.map((u) => u.id));
    const { interaction, replies } = fakeSlashInteraction();

    await purgeCommand.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(replies[0].content).toContain('All 2 scanned users are whitelisted');
    // Nothing armed: a click afterwards must not find a pending purge.
    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);
    expect(click.replies[0].content).toContain('No purge is armed');
  });

  it('arms the purge and attaches Confirm and Cancel', async () => {
    const { interaction, replies } = await arm();

    expect(replies[0].content).toContain('2 users will be kicked');
    const row = (replies[0].components as Array<{ toJSON(): any }>)[0].toJSON();
    expect(row.components.map((c: any) => c.custom_id)).toEqual([
      PURGE_BUTTON_IDS.confirm,
      PURGE_BUTTON_IDS.cancel,
    ]);
  });

  it('does not arm when Discord returns no message id', async () => {
    writeInactiveUsers(USERS);
    const { interaction } = fakeSlashInteraction({ messageId: null });

    await purgeCommand.execute(interaction as unknown as ChatInputCommandInteraction);

    // An armed purge whose buttons cannot be bound would swallow a later
    // click, so it must not be armed at all.
    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);
    expect(click.replies[0].content).toContain('No purge is armed');
  });
});

describe('/purge buttons — confirmation rules', () => {
  it('cancels and clears the armed purge', async () => {
    await arm();
    const click = fakeButtonInteraction({ customId: PURGE_BUTTON_IDS.cancel });

    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    expect(click.updates[0].content).toContain('Nothing was kicked');
    expect(click.updates[0].components).toEqual([]);

    const again = fakeButtonInteraction();
    await handlePurgeButton(again.interaction as unknown as ButtonInteraction);
    expect(again.replies[0].content).toContain('No purge is armed');
  });

  it('refuses a click from anyone but the person who armed it', async () => {
    await arm();
    // Both users are authorized, so the only reason to refuse is ownership.
    process.env.PURGE_ADMIN_IDS = `${USER_ID},${OTHER_USER_ID}`;
    const intruder = fakeButtonInteraction({ userId: OTHER_USER_ID });

    await handlePurgeButton(intruder.interaction as unknown as ButtonInteraction);

    expect(intruder.replies[0].content).toContain('Only the person who ran');
    expect(intruder.replies[0].flags).toBe(MessageFlags.Ephemeral);

    // The real operator can still cancel: the intruder changed nothing.
    const owner = fakeButtonInteraction({ customId: PURGE_BUTTON_IDS.cancel });
    await handlePurgeButton(owner.interaction as unknown as ButtonInteraction);
    expect(owner.updates[0].content).toContain('Nothing was kicked');
  });

  it('refuses a click from outside the purge channel', async () => {
    await arm();
    const click = fakeButtonInteraction({ channelId: '999999999999999999' });

    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    expect(click.replies[0].content).toContain('only runs in');
    expect(click.updates).toHaveLength(0);
  });

  it('re-checks authorization on the click, not just at preview time', async () => {
    await arm();
    // The role was removed between preview and confirm: the click must fail
    // closed even though arming succeeded.
    delete process.env.PURGE_ADMIN_IDS;
    const click = fakeButtonInteraction();

    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    expect(click.replies[0].content).toContain('not configured');
    expect(click.updates).toHaveLength(0);
  });

  it('expires 60 seconds after the preview', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
    await arm();

    vi.setSystemTime(new Date('2026-11-07T12:01:01.000Z'));
    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    expect(click.updates[0].content).toContain('expired');
    expect(click.updates[0].components).toEqual([]);

    const again = fakeButtonInteraction();
    await handlePurgeButton(again.interaction as unknown as ButtonInteraction);
    expect(again.replies[0].content).toContain('No purge is armed');
  });

  it('ignores buttons on a replaced preview without killing the new one', async () => {
    await arm();
    const stale = fakeButtonInteraction({ messageId: '111222333444555666' });

    await handlePurgeButton(stale.interaction as unknown as ButtonInteraction);
    expect(stale.updates[0].content).toContain('replaced');
    expect(stale.updates[0].components).toEqual([]);

    // The newer armed purge must survive the stale click.
    const cancel = fakeButtonInteraction({ customId: PURGE_BUTTON_IDS.cancel });
    await handlePurgeButton(cancel.interaction as unknown as ButtonInteraction);
    expect(cancel.updates[0].content).toContain('Nothing was kicked');
  });

  it('drops the buttons before starting the slow kick loop', async () => {
    await arm();
    const spy = vi
      .spyOn(InactiveUserService, 'purgeInactiveUsers')
      .mockResolvedValue(purgeResult());

    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    expect(spy).toHaveBeenCalledTimes(1);
    // Buttons are removed up front so a second click cannot start a purge.
    expect(click.updates[0].components).toEqual([]);
    expect(click.updates[0].content).toContain('Purge confirmed');
    expect(click.edits[0].content).toContain('Purge complete');
    expect(click.edits[0].content).toContain('2 kicked');
  });

  it('reports a malformed user list without naming the file in channel', async () => {
    await arm();
    vi.spyOn(InactiveUserService, 'purgeInactiveUsers').mockRejectedValue(
      new WhitelistMalformedError(new Error('Unexpected token'))
    );

    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    const text = click.edits[0].content ?? '';
    expect(text).toContain('no one was kicked');
    expect(text).not.toContain('whitelisted_users.json');
    expect(text).not.toContain('Unexpected token');
  });

  it('keeps the raw error out of channel for any other failure', async () => {
    await arm();
    vi.spyOn(InactiveUserService, 'purgeInactiveUsers').mockRejectedValue(
      new Error('ENOENT: /opt/kevbot/data/secret.json')
    );

    const click = fakeButtonInteraction();
    await handlePurgeButton(click.interaction as unknown as ButtonInteraction);

    const text = click.edits[0].content ?? '';
    expect(text).toContain('Purge aborted');
    expect(text).not.toContain('secret.json');
    expect(text).toContain('data/purge_results.json');
  });
});
