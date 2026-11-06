import { escapeMarkdown, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandStringOption } from 'discord.js';
import type { SlashCommand } from '../types';
import {
  DeathCounterService,
  MAX_NAME_LENGTH,
  normalizeName,
  type DeathCounter,
} from '../services/death-counter.service';

/**
 * WoW death counters, as real Discord slash commands.
 *
 * `/died`            — +1 death for a character (creates it on first use)
 * `/deathcounter`    — one character's total
 * `/deathleaderboard`— everyone, most deaths first
 *
 * These are application commands, not message commands: Discord intercepts a
 * leading `/` client-side, so a literal `/died` message never reaches the bot.
 * They are registered in src/index.ts on startup and dispatched from
 * `interactionCreate`.
 */

/** Discord's hard cap is 2000; leave room for markdown and future suffixes. */
const MAX_MESSAGE_LENGTH = 1900;

const NAME_OPTION = (option: SlashCommandStringOption): SlashCommandStringOption =>
  option
    .setName('name')
    .setDescription('Character name (not case-sensitive)')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(MAX_NAME_LENGTH);

/**
 * Reads and normalizes the required `name` option, replying ephemerally with a
 * usage hint when it is blank.
 *
 * Discord enforces `required`, but `min_length` counts whitespace, so a value
 * like "   " does reach the bot. Letting normalizeName() throw would surface an
 * internal-sounding error through the generic handler; this says what to do and
 * guarantees no row is written for a whitespace-only name.
 *
 * @returns the display name, or null when the caller should stop.
 */
async function readNameOption(
  interaction: ChatInputCommandInteraction,
  commandName: string
): Promise<string | null> {
  try {
    return normalizeName(interaction.options.getString('name', true)).name;
  } catch {
    await interaction.reply({
      content: `Please include a character name, for example \`/${commandName} Matthew\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
}

/** `/died` reply for a just-recorded death. */
export function formatDied(counter: DeathCounter): string {
  const name = `**${escapeMarkdown(counter.name)}**`;
  return counter.deaths === 1
    ? `💀 ${name} has died. That's their first death.`
    : `💀 ${name} has died. That's **${counter.deaths}** deaths.`;
}

/** `/deathcounter` reply, including the never-recorded case. */
export function formatCounter(name: string, counter: DeathCounter | null): string {
  // Prefer the stored display name (the casing from the most recent /died);
  // fall back to the caller's input when there is no row yet.
  const display = `**${escapeMarkdown(counter ? counter.name : name)}**`;
  if (!counter) return `No deaths recorded for ${display} yet.`;
  return counter.deaths === 1
    ? `${display} has died once.`
    : `${display} has died **${counter.deaths}** times.`;
}

/**
 * Formats the leaderboard into one or more Discord messages.
 *
 * It returns an array because a long-lived server can accumulate more
 * characters than fit under Discord's 2000-character message limit. Each chunk
 * repeats the header so a continuation still reads on its own; the total goes
 * on the final chunk.
 */
export function formatLeaderboard(counters: DeathCounter[]): string[] {
  const header = '💀 **Death leaderboard**';
  const total = counters.reduce((sum, counter) => sum + counter.deaths, 0);
  const footer =
    `Total: **${total}** ${total === 1 ? 'death' : 'deaths'} across ` +
    `${counters.length} character${counters.length === 1 ? '' : 's'}.`;

  const messages: string[] = [];
  let current = header;

  counters.forEach((counter, index) => {
    const line = `${index + 1}. **${escapeMarkdown(counter.name)}** — ${counter.deaths}`;
    if (`${current}\n${line}`.length > MAX_MESSAGE_LENGTH) {
      messages.push(current);
      current = `${header}\n${line}`;
    } else {
      current = `${current}\n${line}`;
    }
  });

  if (`${current}\n\n${footer}`.length <= MAX_MESSAGE_LENGTH) {
    messages.push(`${current}\n\n${footer}`);
  } else {
    messages.push(current, footer);
  }
  return messages;
}

export const diedCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('died')
    .setDescription('Record one death for a character')
    .addStringOption(NAME_OPTION),
  execute: async (interaction) => {
    const name = await readNameOption(interaction, 'died');
    if (name === null) return;
    await interaction.reply(formatDied(DeathCounterService.increment(name)));
  },
};

export const deathCounterCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('deathcounter')
    .setDescription("Show one character's death count")
    .addStringOption(NAME_OPTION),
  execute: async (interaction) => {
    const name = await readNameOption(interaction, 'deathcounter');
    if (name === null) return;
    await interaction.reply(formatCounter(name, DeathCounterService.get(name)));
  },
};

export const deathLeaderboardCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('deathleaderboard')
    .setDescription('Show every character, most deaths first'),
  execute: async (interaction) => {
    const counters = DeathCounterService.list();
    if (counters.length === 0) {
      await interaction.reply('No deaths recorded yet. Use `/died <name>` to start counting.');
      return;
    }

    const [first, ...rest] = formatLeaderboard(counters);
    await interaction.reply(first);
    for (const message of rest) {
      await interaction.followUp(message);
    }
  },
};
