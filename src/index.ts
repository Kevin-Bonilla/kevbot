import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { oopsieCommand, displayOopsieCountCommand } from './commands/counter';
import { purgeDryRunCommand } from './commands/admin';
import { debugCommand } from './commands/debug';
import { githubCommand } from './commands/github';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;

const commands = [oopsieCommand, displayOopsieCountCommand, purgeDryRunCommand, debugCommand, githubCommand];

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`KEVBOT is ONLINE!`);
  console.log(`--------------------------------`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const command = commands.find(c => message.content === c.name);
  if (command) {
    if (command.requiredChannelId && message.channel.id !== command.requiredChannelId) {
      return; // Ignore command if not in the correct channel
    }
    await command.execute(message, client);
  }
});

if (TOKEN && TOKEN !== 'YOUR_TOKEN_HERE') {
  client.login(TOKEN);
} else {
  console.error('Please provide a valid DISCORD_TOKEN in your .env file.');
}
