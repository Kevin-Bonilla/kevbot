import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import { log, logTarget } from './logging/logger';
import { DeathCounterService } from './services/death-counter.service';
import { announceBackUp, announceGoingDown } from './services/deployment.service';
import { handlePurgeButton, PURGE_BUTTON_IDS } from './commands/index';
import { slashCommands } from './commands/registry';

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

/**
 * Intents are deliberately minimal now that the bot is slash-only.
 *
 *  - Guilds: guild/channel caches, needed for the purge scan.
 *  - GuildMembers: the privileged intent the member-fetch REST calls and the
 *    purge's `guild.members.fetch()` rely on.
 *
 * GuildMessages and MessageContent are gone with the `!` commands. Slash
 * commands arrive over the interactions gateway, not as message events, so
 * requesting MessageContent would only widen the bot's privilege for no gain
 * (and it is the intent Discord requires extra approval for).
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;

/**
 * Discord's hard cap on guild-scoped CHAT_INPUT commands (the same number
 * applies globally). Long past this the guild's command list would also be
 * unusable in the client, so refuse the registration instead of half-failing.
 */
const MAX_GUILD_COMMANDS = 100;

/**
 * Publishes the slash commands to every guild the bot is in.
 *
 * Guild-scoped registration is deliberate: global commands can take an hour to
 * propagate, while guild commands appear immediately, and this bot serves one
 * community. `set()` is idempotent, so a restart is the normal way to deploy a
 * command change. Failures are logged, not thrown — a registration problem
 * must not stop the bot from answering anything else.
 */
async function registerSlashCommands(): Promise<void> {
  const body = slashCommands.map((command) => command.data.toJSON());
  if (body.length > MAX_GUILD_COMMANDS) {
    log.error(
      `Refusing to register ${body.length} slash commands: Discord caps guild ` +
      `commands at ${MAX_GUILD_COMMANDS}. Split them into subcommands.`
    );
    return;
  }

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
  
  // Also fire-and-forget, and never throws: this only posts when the previous
  // process left a fresh deploy marker (see deployment.service.ts), so a crash
  // restart stays quiet instead of announcing itself as an update.
  void announceBackUp(client);
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
 * Tells the user a command failed, without letting one bug take the bot down.
 *
 * An error after a reply (or defer) must be a follow-up; replying twice throws
 * and would hide the original failure.
 */
async function reportInteractionError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  label: string,
  err: unknown
): Promise<void> {
  log.error(`${label} failed:`, err);
  const content = `Sorry, \`${label}\` hit an error: ${
    err instanceof Error ? err.message : String(err)
  }`;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    log.error('Failed to report interaction error:', replyErr);
  }
}

/**
 * True for the only buttons the bot creates. Compared against the exported
 * map rather than literals so a rename cannot leave a dead button behind.
 */
function isPurgeButton(customId: string): boolean {
  return (
    customId === PURGE_BUTTON_IDS.confirm || customId === PURGE_BUTTON_IDS.cancel
  );
}

/**
 * The interaction dispatcher.
 *
 * Slash commands are looked up by name; the purge confirmation arrives as a
 * button click on the preview message. One failing interaction must not crash
 * the client, and the user gets an ephemeral error instead of silence.
 */
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (!isPurgeButton(interaction.customId)) {
      log.warn(`Received unknown button interaction: ${interaction.customId}`);
      return;
    }
    try {
      await handlePurgeButton(interaction);
    } catch (err) {
      await reportInteractionError(interaction, '/purge', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = slashCommands.find((c) => c.data.name === interaction.commandName);
  if (!command) {
    // Normally impossible — Discord only sends commands we registered — but a
    // stale registration from a previous deploy can leave one behind.
    log.warn(`Received unknown slash command: /${interaction.commandName}`);
    return;
  }

  // Channel restrictions survived the move to slash commands: Discord lets a
  // bot hide a command by permissions, not by channel, so the guard has to
  // live here. It is a guardrail (keeps the counter jokes and the purge in
  // their channel), not the security boundary — the purge role gate is.
  if (command.requiredChannelId && interaction.channelId !== command.requiredChannelId) {
    await interaction.reply({
      content: `\`/${command.data.name}\` only works in <#${command.requiredChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    }).catch((err) => log.error('Failed to report wrong-channel use:', err));
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    await reportInteractionError(interaction, `/${command.data.name}`, err);
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
 *
 * SIGTERM is also the deploy signal (`docker stop` sends it), so that is where
 * the "going to sleep" announcement happens. It must be posted before
 * destroy() — once the gateway is closed there is no way to send anything —
 * and it is bounded by a timeout inside announceGoingDown() so a wedged REST
 * call cannot outlast docker stop's 30 seconds and turn into a SIGKILL. SIGINT
 * is deliberately left quiet: it is a local Ctrl-C, not a deployment.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down...`);
  if (signal === 'SIGTERM') {
    await announceGoingDown(client);
  }
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
