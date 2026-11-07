import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';
import { CounterService } from '../services/counter.service';
import { ADMIN_CHANNELS } from '../config/admin-channels';

/**
 * The Matthew Oopsie Counter, as slash commands.
 *
 * `/oopsie`        — record an Oopsie (+1)
 * `/oopsiecounter` — show the current total
 *
 * Both keep the restriction the message commands had: they only work in
 * kevins-ai-chamber (ADMIN_CHANNELS.kevinsAiChamber, enforced by the dispatcher in
 * src/index.ts). The old `if (message.author.bot) return` guard is inherent
 * to slash commands — Discord does not let a bot user invoke one.
 */

export const oopsieCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('oopsie')
    .setDescription('Increments the Oopsie counter'),
  requiredChannelId: ADMIN_CHANNELS.kevinsAiChamber,
  execute: async (interaction) => {
    const newCount = CounterService.increment();
    await interaction.reply(`The Jit with Two Kids made an Oopsie! Current count: ${newCount}`);
  },
};

export const displayOopsieCountCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('oopsiecounter')
    .setDescription('Displays the current Oopsie count'),
  requiredChannelId: ADMIN_CHANNELS.kevinsAiChamber,
  execute: async (interaction) => {
    const count = CounterService.getCount();
    await interaction.reply(`The Jit with Two Kids made ${count} Oopsies!`);
  },
};
