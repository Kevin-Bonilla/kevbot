import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import dotenv from 'dotenv';
import { log, logTarget } from './logging/logger';
import type { SlashCommand } from './types';
import { DeathCounterService } from './services/death-counter.service';
import { 
  oopsieCommand, 
  displayOopsieCountCommand,
  purgeDryRunCommand,
  purgeCommand,
  purgeConfirmCommand,
  debugCommand,
  githubCommand,
  diedCommand,
  deathCounterCommand,
  deathLeaderboardCommand,
} from './commands/index';

dotenv.config();

/**
 * Record the effective logging setup before anything else can fail.
 *
 * On the Oracle VM the agent tails exactly this file (via the /app/logs bind
 * mount), so if OCI shows no data, the first question is "is the bot writing
 * where the agent is reading?" — this line answers it from the log itself,
 * even when nobody can SSH in. Keep the format stable-ish: the paths here are
 * the ones the agent configuration must match.
 */
const logging = logTarget();
log.info(`Kevbot starting (node ${process.version}, NODE_ENV=${process.env.NODE_ENV ?? 'development'})`);
log.info(`Logging: level=${logging.level} format=${logging.format} file=${logging.file}`);

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
 * Application (slash) commands, registered with Discord on startup.
 *
 * These are separate from `commands` above because they are dispatched by
 * interaction, not by message text. Registering them is what makes `/died`
 * work at all: Discord intercepts a leading `/` client-side, so a plain
 * message containing "/died" never reaches the bot.
 */
const slashCommands: SlashCommand[] = [
  diedCommand,
  deathCounterCommand,
  deathLeaderboardCommand,
];

/**
 * Publishes the slash commands to every guild the bot is in.
 *
 * Guild-scoped registration is deliberate: global commands can take an hour to
 * propagate, while guild commands appear immediately, and this bot serves one
 * community. `set()` is idempotent, so a restart is the normal way to deploy a
 * command change. Failures are logged, not thrown — a registration problem
 * must not stop the bot from answering message commands.
 */
async function registerSlashCommands(): Promise<void> {
  const body = slashCommands.map((command) => command.data.toJSON());
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    log.warn('No guilds cached at startup; skipped slash command registration.');
    return;
  }

  for (const guild of guilds) {
    try {
      await guild.commands.set(body);
      log.info(`Registered ${body.length} slash commands in ${guild.name} (${guild.id})`);
    } catch (err) {
      log.error(`Failed to register slash commands in guild ${guild.id}:`, err);
    }
  }
}

/**
 * Event listener for when the bot is ready.
 */
client.once('clientReady', () => {
  log.info(`Logged in as ${client.user?.tag}`);
  log.info('KEVBOT is ONLINE!');
  // Fire-and-forget: the ready handler must not await REST calls, and
  // registerSlashCommands() already logs its own failures.
  void registerSlashCommands();
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

/**
 * Slash command dispatch. Same isolation rule as message commands: one failing
 * interaction must not crash the client, and the user gets an ephemeral error
 * instead of silence.
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = slashCommands.find((c) => c.data.name === interaction.commandName);
  if (!command) {
    // Normally impossible — Discord only sends commands we registered — but a
    // stale registration from a previous deploy can leave one behind.
    log.warn(`Received unknown slash command: /${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`Slash command /${command.data.name} failed:`, err);
    const content = `Sorry, \`/${command.data.name}\` hit an error: ${
      err instanceof Error ? err.message : String(err)
    }`;
    try {
      // An error after a reply (or defer) must be a follow-up; replying twice
      // throws and would hide the original failure.
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      log.error('Failed to report slash command error:', replyErr);
    }
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
  // Release the SQLite handle so the file is cleanly closed and any journal is
  // checkpointed before the process exits.
  DeathCounterService.close();
  // Give the logger a moment to flush the last line, then exit.
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
