import type { SlashCommand } from '../types';
import { displayOopsieCountCommand, oopsieCommand } from './counter';
import { deathCounterCommand, deathLeaderboardCommand, diedCommand } from './death';
import { debugCommand } from './debug';
import { githubCommand } from './github';
import { purgeCommand } from './purge';

/**
 * The single registry of commands the bot publishes to Discord.
 *
 * Kept apart from `src/index.ts` so the list can be imported without booting
 * the client (a test can validate names, descriptions, and the command count
 * against Discord's limits), and so registering a command is one edit in one
 * place. Ordering is display order in the Discord picker, roughly
 * most-used first.
 *
 * Discord caps an application at 100 global CHAT_INPUT commands, and the same
 * number of guild-scoped commands per guild. We register guild-scoped (see
 * registerSlashCommands in src/index.ts), so 100 is the ceiling here; anything
 * that grows past it should become a subcommand, which is how the three purge
 * message commands became one `/purge` with two subcommands.
 */
export const slashCommands: SlashCommand[] = [
  diedCommand,
  deathCounterCommand,
  deathLeaderboardCommand,
  oopsieCommand,
  displayOopsieCountCommand,
  purgeCommand,
  debugCommand,
  githubCommand,
];
