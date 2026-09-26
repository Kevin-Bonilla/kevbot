import { Command } from '../types';

/**
 * Command to display the GitHub repository link.
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @returns A promise that resolves when the command has been executed
 */
export const githubCommand: Command = {
  name: '!github',
  description: 'Displays github repo link',
  execute: async (message, client) => {
    const githubLink = 'https://github.com/Kevin-Bonilla/kevbot';
    await message.channel.send(`Follow my Development! ${githubLink}`);
  }
};