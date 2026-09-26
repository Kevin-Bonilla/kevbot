import { Command } from '../types';

export const debugCommand: Command = {
  name: '!debug',
  description: 'Debug bot status and permissions',
  requiredChannelId: '1552121753692667977',
  execute: async (message, client) => {
    if (!client) {
      return message.reply("Error: Client is undefined.");
    }

    let guildName = 'No Guild / No Access';
    let memberCount = 0;
    let channelCount = 0;

    if (client.guilds.cache.size > 0) {
      const guild = client.guilds.cache.first();
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
      client_version: process.versions.node
    };
    
    await message.reply(`**Debug Info:**\n${JSON.stringify(debugInfo, null, 2)}`);
  },
};
