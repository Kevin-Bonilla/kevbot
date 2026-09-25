import { Command } from './types';
import { CounterService } from '../services/counter.service';

export const incrementCommand: Command = {
  name: '!increment',
  description: 'Increments the counter',
  execute: async (message) => {
    const newCount = CounterService.increment();
    await message.reply(`Counter incremented! Current count: ${newCount}`);
  },
};

export const counterCommand: Command = {
  name: '!counter',
  description: 'Displays the current counter',
  execute: async (message) => {
    const count = CounterService.getCount();
    await message.reply(`Current count: ${count}`);
  },
};
