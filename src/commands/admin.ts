import { Command } from '../types';
import { InactiveUserService } from '../services/purge-users.service';

/**
 * Command to scan for inactive users (dry run).
 * Only available in kevins-ai-chamber.
 *
 * Streams a live progress message ("Scanning 3 of 12 — #general") by
 * editing its initial reply, throttled to one edit per 2 seconds so a
 * fast channel burst can't hit Discord's rate limits.
 */
const MIN_EDIT_SPACING_MS = 2000;


/**
 * Command to scan for inactive users (dry run).
 * Only available in kevins-ai-chamber.
 * 
 * @param name - The name of the command
 * @param description - The description of the command
 * @param requiredChannelId - The ID of the channel where this command can be executed
 * @returns A promise that resolves when the command has been executed
 */
export const purgeDryRunCommand: Command = {
  name: '!purgeDryRun',
  description: 'Scan for inactive users and display them',
  requiredChannelId: '1552121753692667977',
  execute: async (message, client) => {
    const status = await message.reply('🔍 Scanning channels for inactive users... this can take a while.');

    // Throttled progress updater: the scan fires one callback per channel;
    // a guild with many small channels would hammer message.edit, so keep
    // a minimum spacing and coalesce the rest into the next edit.
    let lastEditAt = 0;
    let pendingText: string | null = null;
    let flushing = false;
    const pushProgress = (completedChannels: number, totalChannels: number, channelName: string) => {
      const text = `🔍 Scanning channel ${completedChannels}/${totalChannels} — most recent: #${channelName}`;
      const now = Date.now();
      if (now - lastEditAt >= MIN_EDIT_SPACING_MS) {
        lastEditAt = now;
        status.edit(text).catch(() => { /* non-fatal: keep scanning */ });
      } else if (!flushing) {
        pendingText = text;
        flushing = true;
        setTimeout(() => {
          flushing = false;
          if (pendingText !== null) {
            lastEditAt = Date.now();
            status.edit(pendingText).catch(() => { /* non-fatal */ });
            pendingText = null;
          }
        }, Math.max(0, MIN_EDIT_SPACING_MS - (now - lastEditAt)));
      }
    };

    const results = await InactiveUserService.scanInactiveUsers(client, pushProgress);

    await status.edit(
      `✅ Scan complete: ${results.length} inactive members (no activity in over a year).` +
      (results.length === 0
        ? ' Nobody left to purge.'
        : ' See data/inactive_users.json — run `!purge` to review and arm the real purge.')
    ).catch(() => { /* non-fatal */ });
  },
};
