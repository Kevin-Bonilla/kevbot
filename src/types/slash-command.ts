import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * A Discord application (slash) command.
 *
 * Kept separate from `Command` (see ./command.ts) on purpose: slash commands
 * receive an interaction with typed options, not a Message, and are dispatched
 * from `interactionCreate`. Folding both into one interface would make every
 * existing message command carry interaction-only fields it never uses.
 *
 * `data` is typed structurally rather than as `SlashCommandBuilder` because
 * builders change type as options are added (`SlashCommandOptionsOnlyBuilder`
 * and friends). Everything we need is `name` plus a `toJSON()` that produces
 * the REST payload, and both builder shapes satisfy that.
 */
export interface SlashCommand {
  data: {
    name: string;
    toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
  };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
