import { Command } from '../types';
import { CounterService } from '../services/counter.service';

export const incrementCommand: Command = {
  name: '!oopsie',
  description: 'Increments the counter',
  requiredChannelId: '1552121753692667977',
  execute: async (message) => {
    const newCount = CounterService.increment();
    await message.reply(`The Jit with Two Kids made an Oopsie! Current count: ${newCount}`);
  },
};

export const counterCommand: Command = {
  name: '!oopsiecounter',
  description: 'Displays the current counter',
  requiredChannelId: '1552121753692667977',
  execute: async (message) => {
    const count = CounterService.getCount();
    await message.reply(`The Jit with Two Kids made ${count} Oopsies!`);
  },
};
