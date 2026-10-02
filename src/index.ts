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
client.once('clientReady', () => {
  log.info(`Logged in as ${client.user?.tag}`);
  log.info('KEVBOT is ONLINE!');
});

/**
 * A long-lived gateway connection will drop eventually — network blips, a
 * Discord-side restart, an idle host. Without these, the process stays alive
 * but permanently deaf, and the only symptom is a bot that stopped answering.
 * discord.js reconnects and re-emits clientReady on its own; these handlers
 * exist so the drop is visible in the log and a hard error is not silent.
 */
client.on('disconnect', () => log.warn('Gateway disconnected; reconnecting...'));
client.on('reconnecting', () => log.info('Gateway reconnecting...'));
client.on('error', (err) => log.error('Client error:', err));
client.on('shardError', (err) => log.error('Shard error:', err));
process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection:', err));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

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

/**
 * Shut down cleanly on SIGTERM/SIGINT (systemd stop, Ctrl-C, container stop).
 *
 * Without this, `systemctl restart` kills the process mid-request: a running
 * purge would lose its in-flight kicks without writing the results file, and
 * the next run would start from a stale target list. destroy() closes the
 * gateway and lets the process exit, which systemd's TimeoutStopSec allows for.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down...`);
  try {
    await client.destroy();
    log.info('Gateway closed cleanly.');
  } catch (err) {
    log.error('Error during shutdown:', err);
  }
  // Give the logger a moment to flush the last line, then exit.
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
