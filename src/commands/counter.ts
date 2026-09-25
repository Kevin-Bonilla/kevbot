import { Command } from '../types';
import { CounterService } from '../services/counter.service';

/**
 * Command to increment the oopsie counter.
 * Only available in kevins-ai-chamber
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where the command is allowed
 * @returns A promise that resolves when the command has been executed
 */
export const oopsieCommand: Command = {
  name: '!oopsie',
  description: 'Increments the counter',
  requiredChannelId: '1552121753692667977',
  execute: async (message) => {
    const newCount = CounterService.increment();
    await message.reply(`The Jit with Two Kids made an Oopsie! Current count: ${newCount}`);
  },
};

/**
 * Command to display the oopsie counter.
 * Only available in kevins-ai-chamber
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where the command is allowed
 * @returns A promise that resolves when the command has been executed
 */
export const displayOopsieCountCommand: Command = {
  name: '!oopsiecounter',
  description: 'Displays the current counter',
  requiredChannelId: '1552121753692667977',
  execute: async (message) => {
    const count = CounterService.getCount();
    await message.reply(`The Jit with Two Kids made ${count} Oopsies!`);
  },
};
