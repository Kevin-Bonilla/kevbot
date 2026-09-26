import { Command } from '../types';
import { InactiveUserService } from '../services/purge-users.service';

export const purgeDryRunCommand: Command = {
  name: '!purgeDryRun',
  description: 'Scan for inactive users and display them',
  requiredChannelId: '1552121753692667977',
  execute: async (message, client) => {
    await message.reply("Scanning channels for inactive users... This may take a while.");
    const results = await InactiveUserService.scanInactiveUsers(client);
    await message.reply(`Scan complete! Found ${results.length} inactive members. Check console output or data/inactive_users.json.`);
  },
};
