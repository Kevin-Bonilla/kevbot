import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * A Discord application (slash) command.
 *
 * Every command the bot exposes is one of these: Discord intercepts a leading
 * `/` client-side, so there is no message-text path to keep in sync. A message
 * command type (`Command`) used to live next to this one; it is gone now that
 * `/` is the only way to invoke the bot, and its removal is why `src/index.ts`
 * no longer listens for `messageCreate` or requests the privileged
 * MessageContent intent.
 *
 * `data` is typed structurally rather than as `SlashCommandBuilder` because
 * builders change type as options are added (`SlashCommandOptionsOnlyBuilder`,
 * `SlashCommandSubcommandsOnlyBuilder` and friends). Everything we need is
 * `name` plus a `toJSON()` that produces the REST payload, and every builder
 * shape satisfies that.
 */
export interface SlashCommand {
  data: {
    name: string;
    toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
  };
  /**
   * The one channel this command may be used in, if it is channel-bound.
   *
   * Enforced by the dispatcher in `src/index.ts` rather than by Discord, because
   * a bot cannot set per-channel command permissions with a bot token. Hiding
   * the command from other channels is therefore a guardrail, not a security
   * boundary — the purge role gate is what actually protects the destructive
   * commands.
   */
  requiredChannelId?: string;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
