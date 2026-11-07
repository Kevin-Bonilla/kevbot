import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';
import { ADMIN_CHANNELS } from '../config/admin-channels';

/**
 * `/debug` — bot status and permissions at a glance.
 *
 * Keeps the old command's channel restriction: kevins-ai-chamber only.
 */
export const debugCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Debug bot status and permissions'),
  requiredChannelId: ADMIN_CHANNELS.kevinsAiChamber,
  execute: async (interaction) => {
    // interaction.client is always the logged-in client, so the old
    // "client is undefined" branch is impossible; keep the payload identical.
    const client = interaction.client;

    let guildName = 'No Guild / No Access';
    let memberCount = 0;
    let channelCount = 0;

    if (client.guilds.cache.size > 0) {
      const guild = client.guilds.cache.first()!;
      guildName = guild.name || 'Unknown Name';
      memberCount = guild.memberCount;
      channelCount = guild.channels.cache.size;
    }

    const debugInfo = {
      guild: guildName,
      memberCount,
      channelCount,
      os: process.platform,
      node_version: process.version,
      client_version: process.versions.node,
    };

    // A code block keeps Discord from swallowing the JSON's whitespace, which
    // a plain reply does for repeated spaces and blank lines.
    await interaction.reply(`**Debug Info:**\n\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``);
  },
};
