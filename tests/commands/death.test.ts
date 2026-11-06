import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  deathCounterCommand,
  deathLeaderboardCommand,
  diedCommand,
  formatLeaderboard,
} from '../../src/commands/death';
import { DeathCounterService } from '../../src/services/death-counter.service';

/**
 * Command-level tests: they exercise the real execute() handlers against a
 * fake interaction, so option reading, reply formatting, and the leaderboard's
 * multi-message paging are covered without a Discord connection.
 */

let tempDir: string;
const originalDataDir = process.env.KEVBOT_DATA_DIR;

type ReplyPayload = string | { content?: string; flags?: number };

/** Minimal stand-in for the parts of ChatInputCommandInteraction we use. */
function fakeInteraction(name?: string): {
  interaction: ChatInputCommandInteraction;
  replies: string[];
  flags: Array<number | undefined>;
} {
  const replies: string[] = [];
  const flags: Array<number | undefined> = [];
  const record = (payload: ReplyPayload): void => {
    if (typeof payload === 'string') {
      replies.push(payload);
      flags.push(undefined);
    } else {
      replies.push(payload.content ?? '');
      flags.push(payload.flags);
    }
  };
  const interaction = {
    options: { getString: () => name ?? null },
    reply: async (payload: ReplyPayload) => {
      record(payload);
    },
    followUp: async (payload: ReplyPayload) => {
      record(payload);
    },
    replied: false,
    deferred: false,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies, flags };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-death-cmd-'));
  process.env.KEVBOT_DATA_DIR = tempDir;
});

afterEach(() => {
  DeathCounterService.close();
  if (originalDataDir === undefined) delete process.env.KEVBOT_DATA_DIR;
  else process.env.KEVBOT_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('/died', () => {
  it('announces a first death differently from later ones', async () => {
    const first = fakeInteraction('Matthew');
    await diedCommand.execute(first.interaction);
    expect(first.replies[0]).toContain('Matthew');
    expect(first.replies[0]).toMatch(/first death/i);

    const second = fakeInteraction('matthew');
    await diedCommand.execute(second.interaction);
    expect(second.replies[0]).toContain('**2**');
    expect(second.replies[0]).toMatch(/deaths/i);
  });

  it('voices the most recent display casing', async () => {
    DeathCounterService.increment('matthew');
    const { interaction, replies } = fakeInteraction('MATTHEW');
    await diedCommand.execute(interaction);
    expect(replies[0]).toContain('**MATTHEW**');
  });

  it('replies with usage instead of counting a whitespace-only name', async () => {
    const { interaction, replies, flags } = fakeInteraction('   ');
    await diedCommand.execute(interaction);

    expect(replies[0]).toBe('Please include a character name, for example `/died Matthew`.');
    expect(flags[0]).toBe(MessageFlags.Ephemeral);
    // Fail closed: a blank name must not create a character.
    expect(DeathCounterService.list()).toEqual([]);
  });
});

describe('/deathcounter', () => {
  it('says nothing is recorded for an unknown character', async () => {
    const { interaction, replies } = fakeInteraction('Nobody');
    await deathCounterCommand.execute(interaction);
    expect(replies[0]).toBe('No deaths recorded for **Nobody** yet.');
  });

  it('reports one death in the singular, using the stored casing', async () => {
    DeathCounterService.increment('Matthew');
    const { interaction, replies } = fakeInteraction('matthew');
    await deathCounterCommand.execute(interaction);
    expect(replies[0]).toBe('**Matthew** has died once.');
  });

  it('reports multiple deaths with the total', async () => {
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');
    const { interaction, replies } = fakeInteraction('Matthew');
    await deathCounterCommand.execute(interaction);
    expect(replies[0]).toBe('**Matthew** has died **2** times.');
  });

  it('replies with usage for a whitespace-only name', async () => {
    const { interaction, replies, flags } = fakeInteraction('  ');
    await deathCounterCommand.execute(interaction);

    expect(replies[0]).toBe(
      'Please include a character name, for example `/deathcounter Matthew`.'
    );
    expect(flags[0]).toBe(MessageFlags.Ephemeral);
  });
});

describe('/deathleaderboard', () => {
  it('points at /died when the board is empty', async () => {
    const { interaction, replies } = fakeInteraction();
    await deathLeaderboardCommand.execute(interaction);
    expect(replies[0]).toContain('No deaths recorded yet');
    expect(replies[0]).toContain('/died');
  });

  it('lists characters in descending order with a total', async () => {
    DeathCounterService.increment('Kevin');
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');
    DeathCounterService.increment('Matthew');

    const { interaction, replies } = fakeInteraction();
    await deathLeaderboardCommand.execute(interaction);

    expect(replies).toHaveLength(1);
    expect(replies[0].indexOf('Matthew')).toBeLessThan(replies[0].indexOf('Kevin'));
    expect(replies[0]).toContain('Total: **4** deaths across 2 characters.');
  });

  it('pages a board too long for one Discord message', async () => {
    const counters = Array.from({ length: 150 }, (_, i) => ({
      name: `Player${i}`,
      deaths: 150 - i,
    }));
    const messages = formatLeaderboard(counters);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(1900);
      expect(message.startsWith('💀 **Death leaderboard**')).toBe(true);
    }
    // The footer only needs to appear once, on the final message.
    expect(messages[messages.length - 1]).toContain('across 150 characters');
  });
});
