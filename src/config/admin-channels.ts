/**
 * The admin channels commands are pinned to.
 *
 * The rule the bot enforces is "this exact channel", not "any channel admins
 * can type in". Discord owns who may post where; the bot only decides which
 * channel a command is designed for, and a permission change on the channel
 * does not widen that. Keeping the distinction here stops the name from doing
 * work the dispatcher does not do.
 *
 * Kept in code rather than `.env` on purpose:
 *   - a channel ID is not a secret, and the repo is the deployment artifact;
 *   - an empty or misspelled env value would either drop the restriction
 *     (fail open — wrong for the purge) or lock the commands out, and neither
 *     is visible until someone tries a command on the VM;
 *   - the IDs are stable. Re-creating a channel and updating the pin is a
 *     deliberate, reviewable change, and tests/commands/registration.test.ts
 *     pins the literal so a silent edit fails CI.
 *
 * Commands point at an entry through `SlashCommand.requiredChannelId`; the
 * dispatcher in src/index.ts enforces it. This is a guardrail, not a security
 * boundary — the purge role gate is what protects the destructive commands.
 *
 * One entry per channel, not one shared array: `/oopsie` is confined to
 * kevins-ai-chamber because the joke belongs there, while `/purge` is confined
 * there because it is the admin channel. They happen to match today and are
 * free to diverge without dragging each other along.
 */
export const ADMIN_CHANNELS = {
  /** kevins-ai-chamber — the counter, `/debug`, and the purge are confined here. */
  kevinsAiChamber: '1552121753692667977',
} as const;
