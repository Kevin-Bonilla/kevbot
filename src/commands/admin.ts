import { Command } from '../types';
import { InactiveUserService } from '../services/purge-users.service';

/**
 * Command to scan for inactive users and display them.
 * Only available in kevins-ai-chamber
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where the command is allowed
 * @returns A promise that resolves when the command has been executed
 */
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
