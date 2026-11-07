import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';

/**
 * `/status` — uptime and runtime info for anyone in the server.
 *
 * The interesting number after a deploy is how long the current process has
 * been up, because that is what distinguishes "just restarted" from "still the
 * build from last week". `client.uptime` is the time since the gateway became
 * ready, which is the moment the bot could actually answer; `process.uptime()`
 * is the fallback for the (rare) call before the client is ready.
 *
 * The commit comes from KEVBOT_COMMIT, stamped into the image by
 * deploy/setup-vm.sh. It says which build is running without SSHing to the VM
 * and running `git -C /opt/kevbot rev-parse HEAD`, which may not even match the
 * image if a build was never restarted.
 */

const COMMIT_FALLBACK = 'unknown';

/**
 * Human-readable duration: 45s, 2m 5s, 3h 2m, 2d 4h 12m.
 *
 * Two units, largest first — enough to be precise, short enough for one line
 * in Discord. Seconds are dropped past the hour because a bot's uptime does not
 * need second-level precision once it has been up that long.
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export const statusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Shows how long Kevbot has been up and what it is running'),
  execute: async (interaction) => {
    const client = interaction.client;

    // client.uptime is null until the gateway is ready; a command cannot be
    // invoked before then, but the fallback keeps the types honest.
    const uptimeMs = client.uptime ?? process.uptime() * 1000;
    const startedAt = Math.floor((Date.now() - uptimeMs) / 1000);

    const guilds = client.guilds.cache.size;
    const members = [...client.guilds.cache.values()].reduce(
      (total, guild) => total + guild.memberCount,
      0
    );
    const ping = client.ws.ping;
    const commit = process.env.KEVBOT_COMMIT?.trim() || COMMIT_FALLBACK;
    const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    // <t:...:f> is rendered in each viewer's own locale and time zone by the
    // Discord client, so the bot does not have to guess a time zone.
    const lines = [
      '**Kevbot status**',
      `**Uptime:** ${formatUptime(uptimeMs)} (awake since <t:${startedAt}:f>)`,
      `**Build:** \`${commit}\` on Node ${process.version} (${process.platform}/${process.arch})`,
      `**Guilds:** ${guilds} · ${members} members`,
      `**Gateway:** ${client.isReady() ? 'connected' : 'connecting'} · ping ${ping >= 0 ? `${ping} ms` : 'unknown'}`,
      `**Memory:** ${memoryMb} MB`,
    ];

    await interaction.reply(lines.join('\n'));
  },
};
