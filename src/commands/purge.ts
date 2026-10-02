import { Command } from '../types';
import { InactiveUserService } from '../services/purge-users.service';
import { canPurge, replyNoPermission } from '../services/role-gate.service';
import { WhitelistMalformedError } from '../errors';
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

    if (!InactiveUserService.hasScanData()) {
      await message.reply('No scan data yet. Run `!purgeDryRun` first, then `!purge`.');
      return;
    }

    let targets;
    let skippedWhitelisted: string[];
    try {
      ({ targets, skippedWhitelisted } = InactiveUserService.getTargetsToKick());
    } catch (err) {
      if (err instanceof WhitelistMalformedError) {
        // Fail closed: a broken whitelist must never look like an empty one.
        log.error('Purge aborted (malformed whitelist):', err);
        await message.reply(`Purge aborted: ${err.message}`);
        return;
      }
      throw err;
    }
    if (targets.length === 0) {
      const detail = skippedWhitelisted.length
        ? `All ${skippedWhitelisted.length} scanned users are whitelisted.`
        : 'The scan found no inactive users.';
      await message.reply(`Nothing to purge — ${detail}`);
      return;
    }

    pendingPurge = { userId: message.author.id, createdAt: Date.now() };
    await message.reply(
      `Purge armed: ${targets.length} user${targets.length === 1 ? '' : 's'} will be kicked` +
      (skippedWhitelisted.length ? ` (${skippedWhitelisted.length} whitelisted skipped)` : '') +
      `. Full list is in data/inactive_users.json. ` +
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
      await message.reply(
        `Purge complete: ${result.kicked.length} kicked, ${result.failed.length} failed. ` +
        `See ${RESULTS_FILE} for details.`
      );
    } catch (err) {
      if (err instanceof WhitelistMalformedError) {
        // Fail closed: no kicks made; the whitelist needs fixing first.
        log.error('Purge aborted (malformed whitelist):', err);
        await message.reply(`Purge aborted, no one was kicked: ${err.message}`);
        return;
      }
      log.error('Purge failed:', err);
      await message.reply(`Purge aborted: ${err instanceof Error ? err.message : String(err)}. Partial results are in ${RESULTS_FILE}.`);
    }
  },
};
