import { Command } from '../types';
import { InactiveUserService } from '../services/purge-users.service';
import { canPurge, replyNoPermission } from '../services/role-gate.service';
import { UserListMalformedError } from '../errors';
import { log } from '../logging/logger';

/**
 * Real purge commands.
 *
 * Flow:
 *  1. `!purge` previews: reports how many would be kicked (the !purgeDryRun
 *     scan minus the whitelist) and arms a 60-second confirmation window.
 *  2. `!purge confirm` run by the SAME user inside that window executes the
 *     kicks. Discord gets counts only; details live in data/purge_results.json.
 *
 * Both commands are restricted to the kevins-ai-chamber channel and to
 * members of the purge role configured via PURGE_ROLE_ID / PURGE_ROLE_NAME.
 */

const CHANNEL_ID = '1552121753692667977';
const CONFIRM_WINDOW_MS = 60_000;
const RESULTS_FILE = 'data/purge_results.json';

type PendingPurge = { userId: string; createdAt: number };
let pendingPurge: PendingPurge | null = null;

/**
 * Arms the purge: shows how many users would be kicked and opens the
 * confirmation window.
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where this command can be executed
 * @returns A promise that resolves when the command has been executed
 */
export const purgeCommand: Command = {
  name: '!purge',
  description: 'Preview the inactive-user purge and ask for confirmation',
  requiredChannelId: CHANNEL_ID,
  execute: async (message) => {
    if (!(await canPurge(message))) {
      await replyNoPermission(message);
      return;
    }

    // A scan is normally required, but not when the purge has work queued that
    // does not depend on scanning activity. getTargetsToKick() reports zero
    // targets on its own if there is genuinely nothing to do, so the explicit
    // scan check is only a guard against a confusing empty first run.
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
        await message.reply(`Purge aborted: ${err.message}`);
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
        await message.reply('Nothing to purge yet. Run `!purgeDryRun` first, then `!purge`.');
        return;
      }
      await message.reply(`Nothing to purge — ${detail}`);
      return;
    }

    pendingPurge = { userId: message.author.id, createdAt: Date.now() };

    // Nothing here names the blacklist or distinguishes its targets from the
    // scanned ones. The preview is a count plus a pointer to the audit trail;
    // who is on which list is an operator concern that lives in
    // data/purge_results.json and the log, not in a channel. The operator is
    // still role-gated to reach this far.
    await message.reply(
      `Purge armed: ${targets.length} user${targets.length === 1 ? '' : 's'} will be kicked` +
      (skippedWhitelisted.length ? ` (${skippedWhitelisted.length} whitelisted skipped)` : '') +
      `. Details are recorded in ${RESULTS_FILE} after the run. ` +
      `Run \`!purge confirm\` within 60 seconds to proceed.`
    );
  },
};

/**
 * Confirms and executes the armed purge (same user, within 60 seconds).
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where this command can be executed
 * @returns A promise that resolves when the command has been executed
 */
export const purgeConfirmCommand: Command = {
  name: '!purge confirm',
  description: 'Confirm and execute the armed purge',
  requiredChannelId: CHANNEL_ID,
  execute: async (message, client) => {
    if (!(await canPurge(message))) {
      await replyNoPermission(message);
      return;
    }

    const windowOpen =
      pendingPurge !== null &&
      pendingPurge.userId === message.author.id &&
      Date.now() - pendingPurge.createdAt <= CONFIRM_WINDOW_MS;

    if (!windowOpen) {
      await message.reply('No purge is armed right now (or it expired). Run `!purge` first.');
      return;
    }

    pendingPurge = null;
    await message.reply('Starting purge... this may take a little while.');

    try {
      const result = await InactiveUserService.purgeInactiveUsers(client);
      // Skipped entries are deliberately not enumerated here: they can only
      // arise from a hand-edited list, and naming them in channel would leak
      // both the fact and the contents of that list. The count plus the audit
      // file is enough for the operator to investigate.
      const skippedNote = result.skippedUnkickable.length
        ? `, ${result.skippedUnkickable.length} skipped`
        : '';
      await message.reply(
        `Purge complete: ${result.kicked.length} kicked, ${result.failed.length} failed` +
        `${skippedNote}. See ${RESULTS_FILE} for details.`
      );
    } catch (err) {
      if (err instanceof UserListMalformedError) {
        // Fail closed: no kicks made; the list needs fixing first.
        log.error('Purge aborted (malformed user list):', err.detail);
        await message.reply(`Purge aborted, no one was kicked: ${err.message}`);
        return;
      }
      log.error('Purge failed:', err);
      // Generic catch-all, so err.message is untrusted: it could come from a
      // library or a list-parsing path and name a file we do not disclose in
      // channel. Post a generic line and keep the real message in the log.
      await message.reply(
        `Purge aborted. Partial results are in ${RESULTS_FILE}; see the log for details.`
      );
    }
  },
};
