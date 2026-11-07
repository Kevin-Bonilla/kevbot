import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from '../types';
import { InactiveUserService } from '../services/purge-users.service';
import { canPurge, replyNoPermission } from '../services/role-gate.service';
import { UserListMalformedError } from '../errors';
import { log } from '../logging/logger';
import { ADMIN_CHANNELS } from '../config/admin-channels';
import type { PurgeResult } from '../types/users';

/**
 * The purge, as one `/purge` command with two subcommands:
 *
 *  1. `/purge dry-run` — scans every text channel for members with no activity
 *     in over a year and writes data/inactive_users.json. No action is taken.
 *  2. `/purge preview` — reports how many would be kicked (the scan minus the
 *     whitelist) and posts **Confirm** / **Cancel** buttons, valid for 60
 *     seconds and only for the person who ran the preview.
 *
 * The confirm step used to be a second typed message command (`!purge
 * confirm`). A button is a better fit for a destructive action: it cannot be
 * mistyped, it shows the count it is confirming right next to the click, and
 * the interaction carries the clicker's identity so the "same person, inside
 * the window" rule is enforced the same way it was before.
 *
 * Both subcommands are restricted to the kevins-ai-chamber channel and to
 * members of the purge role configured via PURGE_ROLE_ID / PURGE_ROLE_NAME /
 * PURGE_ADMIN_IDS (see services/role-gate.service).
 */

const CONFIRM_WINDOW_MS = 60_000;
const RESULTS_FILE = 'data/purge_results.json';

/** One throttled progress edit per this interval keeps the scan under rate limits. */
const MIN_EDIT_SPACING_MS = 2000;

/**
 * Custom IDs of the confirmation buttons. They live in one exported map so the
 * dispatcher in src/index.ts can route clicks without duplicating string
 * literals, and so a typo fails to compile instead of leaving a dead button.
 */
export const PURGE_BUTTON_IDS = {
  confirm: 'purge:confirm',
  cancel: 'purge:cancel',
} as const;

/**
 * The armed purge, if any. Only one can be pending: arming a second preview
 * replaces the first, which is why the message ID is stored — a click on the
 * older message must not confirm the newer purge.
 */
type PendingPurge = { userId: string; messageId: string; createdAt: number };
let pendingPurge: PendingPurge | null = null;

/**
 * Clears the in-memory confirmation window.
 *
 * Test-only seam: the pending purge is module state by design (it dies with
 * the process, exactly like the old 60-second window), and a test needs a
 * clean slate per case without restarting the module.
 */
export function resetPendingPurgeForTests(): void {
  pendingPurge = null;
}

/** The preview text: a count, the audit pointer, and the two ways forward. */
export function formatPreview(targetCount: number, skippedWhitelistedCount: number): string {
  return (
    `Purge armed: ${targetCount} user${targetCount === 1 ? '' : 's'} will be kicked` +
    (skippedWhitelistedCount ? ` (${skippedWhitelistedCount} whitelisted skipped)` : '') +
    `. Details are recorded in ${RESULTS_FILE} after the run. ` +
    `Press **Confirm** within 60 seconds to proceed, or **Cancel**.`
  );
}

/**
 * The post-run summary posted in channel.
 *
 * Deliberately counts only. Which user came from which list, and why each was
 * chosen, stays in data/purge_results.json and the log — see the note in
 * `runPreview` about not disclosing the blacklist.
 */
export function formatPurgeSummary(result: PurgeResult): string {
  // Skipped entries are deliberately not enumerated here: they can only arise
  // from a hand-edited list, and naming them in channel would leak both the
  // fact and the contents of that list. The count plus the audit file is
  // enough for the operator to investigate.
  const skippedNote = result.skippedUnkickable.length
    ? `, ${result.skippedUnkickable.length} skipped`
    : '';
  return (
    `Purge complete: ${result.kicked.length} kicked, ${result.failed.length} failed` +
    `${skippedNote}. See ${RESULTS_FILE} for details.`
  );
}

/** The Confirm / Cancel row attached to a purge preview. */
function confirmationRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PURGE_BUTTON_IDS.confirm)
      .setLabel('Confirm purge')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(PURGE_BUTTON_IDS.cancel)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Ephemeral one-liner, for refusals and dead ends that shouldn't clutter the channel. */
async function notice(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  content: string
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * `/purge dry-run` — full-history scan of every text channel.
 *
 * Deferred before the scan starts: Discord gives an interaction three seconds
 * to be acknowledged and a full-history scan can take minutes. `editReply`
 * then streams the same "Scanning X/N — #channel" progress the message
 * command used to, throttled to one edit per MIN_EDIT_SPACING_MS so a guild
 * with many small channels cannot hammer the rate limit.
 */
async function runDryRun(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  let lastEditAt = 0;
  let pendingText: string | null = null;
  let flushing = false;
  const pushProgress = (completedChannels: number, totalChannels: number, channelName: string) => {
    const text = `🔍 Scanning channel ${completedChannels}/${totalChannels} — most recent: #${channelName}`;
    const now = Date.now();
    if (now - lastEditAt >= MIN_EDIT_SPACING_MS) {
      lastEditAt = now;
      interaction.editReply(text).catch(() => { /* non-fatal: keep scanning */ });
    } else if (!flushing) {
      pendingText = text;
      flushing = true;
      setTimeout(() => {
        flushing = false;
        if (pendingText !== null) {
          lastEditAt = Date.now();
          interaction.editReply(pendingText).catch(() => { /* non-fatal */ });
          pendingText = null;
        }
      }, Math.max(0, MIN_EDIT_SPACING_MS - (now - lastEditAt)));
    }
  };

  const results = await InactiveUserService.scanInactiveUsers(interaction.client, pushProgress);

  await interaction.editReply(
    `✅ Scan complete: ${results.length} inactive members (no activity in over a year).` +
    (results.length === 0
      ? ' Nobody left to purge.'
      : ' See data/inactive_users.json — run `/purge preview` to review and arm the real purge.')
  ).catch(() => { /* non-fatal */ });
}

/**
 * `/purge preview` — builds the kick list, reports the count, and arms the
 * 60-second confirmation window.
 *
 * Nothing here names the blacklist or distinguishes its targets from the
 * scanned ones. The preview is a count plus a pointer to the audit trail; who
 * is on which list is an operator concern that lives in data/purge_results.json
 * and the log, not in a channel. The user is still role-gated to reach this far.
 */
async function runPreview(interaction: ChatInputCommandInteraction): Promise<void> {
  // A scan is normally required, but not when the purge has work queued that
  // does not depend on scanning activity. getTargetsToKick() reports zero
  // targets on its own if there is genuinely nothing to do.
  let targets;
  let skippedWhitelisted: string[];
  try {
    ({ targets, skippedWhitelisted } = InactiveUserService.getTargetsToKick());
  } catch (err) {
    if (err instanceof UserListMalformedError) {
      // Fail closed: a broken user list must never look like an empty one.
      // That would either unprotect someone or silently drop a kick the
      // operator believes is queued. `detail` (which names the file) goes to
      // the log; `message` is the sanitized version safe for the channel.
      log.error('Purge aborted (malformed user list):', err.detail);
      await notice(interaction, `Purge aborted: ${err.message}`);
      return;
    }
    throw err;
  }

  if (targets.length === 0) {
    const detail = skippedWhitelisted.length
      ? `All ${skippedWhitelisted.length} scanned users are whitelisted.`
      : 'The scan found no users to purge.';
    // With no scan on record at all, point at the scan command rather than
    // claiming the scan came up empty — it never ran.
    if (!InactiveUserService.hasScanData()) {
      await notice(interaction, 'Nothing to purge yet. Run `/purge dry-run` first, then `/purge preview`.');
      return;
    }
    await notice(interaction, `Nothing to purge — ${detail}`);
    return;
  }

  const response = await interaction.reply({
    content: formatPreview(targets.length, skippedWhitelisted.length),
    components: [confirmationRow()],
    withResponse: true,
  });
  const messageId = response.resource?.message?.id;
  if (!messageId) {
    // Without the message ID the buttons cannot be bound to this preview, and
    // an armed purge that can never be confirmed is worse than none: it would
    // sit in memory and swallow a later click.
    log.warn('Purge preview posted but Discord returned no message id; not arming the purge.');
    return;
  }

  pendingPurge = { userId: interaction.user.id, messageId, createdAt: Date.now() };
}

/**
 * Handles a click on the purge preview's Confirm / Cancel buttons.
 *
 * Kept separate from the slash command so `src/index.ts` can dispatch it from
 * the same `interactionCreate` handler, and so every rule lives in one place:
 *
 *   - the pending purge must still exist (it is in memory only, so a restart
 *     between preview and click cancels it),
 *   - the clicker is re-authorized, because a role can be removed between
 *     preview and confirm and a button is a second way in,
 *   - the clicker must be the person who armed it, as before,
 *   - the click must come from the preview message that armed it (a replaced
 *     preview's buttons are dead), inside the 60-second window.
 *
 * Confirm is destructive, so the buttons are removed *before* the slow kick
 * loop: a second click must not be able to start a second purge.
 */
export async function handlePurgeButton(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingPurge;

  if (!pending) {
    await notice(
      interaction,
      'No purge is armed right now (or it expired). Run `/purge preview` first.'
    );
    return;
  }

  // The channel restriction applies to the click as well as to the command:
  // a message can be moved between channels, and the purge belongs to
  // kevins-ai-chamber even if its buttons end up somewhere else.
  if (interaction.channelId !== ADMIN_CHANNELS.kevinsAiChamber) {
    await notice(interaction, `The purge only runs in <#${ADMIN_CHANNELS.kevinsAiChamber}>.`);
    return;
  }

  if (!canPurge(interaction)) {
    await replyNoPermission(interaction, '/purge');
    return;
  }

  if (interaction.user.id !== pending.userId) {
    await notice(
      interaction,
      'Only the person who ran `/purge preview` can answer it. ' +
      'Run `/purge preview` yourself if you are authorized.'
    );
    return;
  }

  if (interaction.message.id !== pending.messageId) {
    // Do NOT clear pending here: this click is on an older preview, and the
    // newer armed purge it would otherwise cancel is still valid.
    await interaction.update({
      content: 'This purge preview was replaced by a newer one, so its buttons are inactive. ' +
        'Use the newest `/purge preview` message, or run it again.',
      components: [],
    });
    return;
  }

  if (Date.now() - pending.createdAt > CONFIRM_WINDOW_MS) {
    pendingPurge = null;
    await interaction.update({
      content: 'The purge confirmation window expired (60 seconds). Nothing was kicked. ' +
        'Run `/purge preview` again.',
      components: [],
    });
    return;
  }

  if (interaction.customId === PURGE_BUTTON_IDS.cancel) {
    pendingPurge = null;
    await interaction.update({
      content: 'Purge cancelled. Nothing was kicked.',
      components: [],
    });
    return;
  }

  // Confirm. Clear the state and drop the buttons before the slow part; the
  // update also acknowledges the interaction inside Discord's 3-second limit.
  pendingPurge = null;
  await interaction.update({
    content: 'Purge confirmed. Starting... this may take a little while.',
    components: [],
  });

  try {
    const result = await InactiveUserService.purgeInactiveUsers(interaction.client);
    await interaction.editReply(formatPurgeSummary(result));
  } catch (err) {
    if (err instanceof UserListMalformedError) {
      // Fail closed: no kicks made; the list needs fixing first.
      log.error('Purge aborted (malformed user list):', err.detail);
      await interaction.editReply(`Purge aborted, no one was kicked: ${err.message}`);
      return;
    }
    log.error('Purge failed:', err);
    // Generic catch-all, so err.message is untrusted: it could come from a
    // library or a list-parsing path and name a file we do not disclose in
    // channel. Post a generic line and keep the real message in the log.
    await interaction.editReply(
      `Purge aborted. Partial results are in ${RESULTS_FILE}; see the log for details.`
    );
  }
}

export const purgeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Scan for inactive members, then review and run the purge')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dry-run')
        .setDescription('Scan every channel for members inactive over a year (no kicks)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('preview')
        .setDescription('Preview the purge and confirm it with buttons')
    ),
  requiredChannelId: ADMIN_CHANNELS.kevinsAiChamber,
  execute: async (interaction) => {
    if (!canPurge(interaction)) {
      await replyNoPermission(interaction, '/purge');
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'dry-run') {
      await runDryRun(interaction);
      return;
    }
    if (subcommand === 'preview') {
      await runPreview(interaction);
      return;
    }

    // Unreachable while Discord validates subcommands against the registered
    // payload; logged rather than thrown so a stale registration is visible.
    log.warn(`Received unknown /purge subcommand: ${subcommand}`);
  },
};
