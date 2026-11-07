import { afterEach, describe, expect, it } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatUptime, statusCommand } from '../../src/commands/status';

/**
 * `/status` is mostly presentation, so the two things worth pinning are the
 * duration formatting (it is easy to get an off-by-one in the seconds) and that
 * the reply actually carries the operational fields — uptime, build, guilds,
 * ping — rather than silently dropping one when the shape changes.
 */

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [125_000, '2m 5s'],
    [3 * 3_600_000 + 2 * 60_000, '3h 2m'],
    [2 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000, '2d 4h 12m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatUptime(ms)).toBe(expected);
  });
});

const originalCommit = process.env.KEVBOT_COMMIT;

afterEach(() => {
  if (originalCommit === undefined) delete process.env.KEVBOT_COMMIT;
  else process.env.KEVBOT_COMMIT = originalCommit;
});

describe('/status', () => {
  it('reports uptime, build, guild counts, and gateway ping', async () => {
    process.env.KEVBOT_COMMIT = 'abc1234';

    let replyContent = '';
    const interaction = {
      client: {
        uptime: 3_723_000, // 1h 2m 3s
        isReady: () => true,
        ws: { ping: 42 },
        guilds: {
          cache: new Map([
            ['1', { memberCount: 40 }],
            ['2', { memberCount: 2 }],
          ]),
        },
      },
      reply: async (content: string) => {
        replyContent = content;
      },
    } as unknown as ChatInputCommandInteraction;

    await statusCommand.execute(interaction);

    expect(replyContent).toContain('**Uptime:** 1h 2m');
    expect(replyContent).toContain('abc1234');
    expect(replyContent).toContain(`Node ${process.version}`);
    expect(replyContent).toContain('**Guilds:** 2 · 42 members');
    expect(replyContent).toContain('connected');
    expect(replyContent).toContain('42 ms');
    expect(replyContent).toContain('MB');
  });

  it('falls back to "unknown" when the build did not stamp a commit', async () => {
    delete process.env.KEVBOT_COMMIT;

    let replyContent = '';
    const interaction = {
      client: {
        uptime: 5_000,
        isReady: () => true,
        ws: { ping: -1 },
        guilds: { cache: new Map() },
      },
      reply: async (content: string) => {
        replyContent = content;
      },
    } as unknown as ChatInputCommandInteraction;

    await statusCommand.execute(interaction);

    expect(replyContent).toContain('`unknown`');
    expect(replyContent).toContain('ping unknown');
  });
});
