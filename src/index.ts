import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { incrementCommand, counterCommand } from './commands/counter';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;

const commands = [incrementCommand, counterCommand];

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const command = commands.find(c => message.content === c.name);
  if (command) {
    await command.execute(message);
  }
});

if (TOKEN && TOKEN !== 'YOUR_TOKEN_HERE') {
  client.login(TOKEN);
} else {
  console.error('Please provide a valid DISCORD_TOKEN in your .env file.');
}
