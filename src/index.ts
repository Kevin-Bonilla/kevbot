import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { log } from './logging/logger';
import { 
  oopsieCommand, 
  displayOopsieCountCommand,
  purgeDryRunCommand,
  purgeCommand,
  purgeConfirmCommand,
  debugCommand,
  githubCommand,
} from './commands/index';

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

const commands = [
  oopsieCommand, 
  displayOopsieCountCommand, 
  purgeDryRunCommand, 
  purgeCommand,
  purgeConfirmCommand,
  debugCommand, 
  githubCommand
];

/**
 * Event listener for when the bot is ready.
 */
client.once('ready', () => {
  log.info(`Logged in as ${client.user?.tag}`);
  log.info('KEVBOT is ONLINE!');
});

/**
 * Event listener for when a message is created in a channel.
 */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const command = commands.find(c => message.content === c.name);
  if (command) {
    if (command.requiredChannelId && message.channel.id !== command.requiredChannelId) {
      return; // Ignore command if not in the correct channel
    }
    await command.execute(message, client).catch((err) => {
      // A bug inside ONE command must never take the whole bot down:
      // an unhandled throw/throw here historically crashed the client.
      log.error(`Command ${command.name} failed:`, err);
      message.reply(`Sorry, \`${command.name}\` hit an error: ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => {});
    });
  }
});


if (TOKEN && TOKEN !== 'YOUR_TOKEN_HERE') {
  client.login(TOKEN);
} else {
  log.error('Please provide a valid DISCORD_TOKEN in your .env file.');
}
