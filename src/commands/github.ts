import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';

/**
 * `/github` — link to the repo.
 *
 * Unrestricted, like the message command it replaces: it was usable in any
 * channel. Discord still decides who may see the command where, via the
 * server's Integrations settings.
 */
export const githubCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('github')
    .setDescription('Displays the kevbot GitHub repository link'),
  execute: async (interaction) => {
    const githubLink = 'https://github.com/Kevin-Bonilla/kevbot';
    await interaction.reply(`Follow my Development! ${githubLink}`);
  },
};
