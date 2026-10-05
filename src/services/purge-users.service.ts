import fs from 'fs';
import path from 'path';
import { Client, Collection, Message, NewsChannel, PublicThreadChannel, TextChannel } from 'discord.js';
import { UserRecord, KickOutcome, PurgeResult } from '../types/users';
import { log } from '../logging/logger';
import { WhitelistMalformedError, BlacklistMalformedError } from '../errors';

// The data directory is overridable so tests can point at a temp dir instead of
// the real data/. These are FUNCTIONS, not module-level consts, precisely so the
// env var is read on every call: a test can set KEVBOT_DATA_DIR in beforeEach and
// get a clean slate per case, even though the module was imported at the top of
// the test file. A module-level const would capture the value once at import and
// silently point every case back at the real data/ directory.
const dataPath = (file: string): string =>
  path.join(
    process.env.KEVBOT_DATA_DIR
      ? path.resolve(process.env.KEVBOT_DATA_DIR)
      : path.resolve(__dirname, '../../data'),
    file
  );

const PURGE_REASON = 'Inactive for over a year (kevbot purge)';
const KICK_INTERVAL_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class InactiveUserService {

  /**
   * Scans all text channels to find users who haven't messaged in over a year.
   * It fetches the complete available history to identify each user's latest message.
   *
   * @param client The Discord client instance
   * @param onProgress Optional: called with (completedChannels, totalChannels, channelName)
   *                   after each channel finishes, so callers can stream a live
   *                   "5 of 12 — #general" update to the requester.
   * @returns List of inactive user objects
   */
  static async scanInactiveUsers(
    client: Client,
    onProgress?: (completedChannels: number, totalChannels: number, channelName: string) => void
  ): Promise<UserRecord[]> {
    log.debug("Starting inactive user scan...");
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);

    log.debug(`Cutoff date set to: ${cutoffDate.toISOString()}`);

    const activeUsers = new Set<string>();

    const guild = client.guilds.cache.first();
    if (!guild) {
      log.error("No guild found. Could not check members.");
      return [];
    }

    const channels = [...guild.channels.cache
      .filter((c): c is TextChannel | NewsChannel | PublicThreadChannel => c.isTextBased())
      .values()];
    log.info(`Dry-run scan: scanning ${channels.length} text channels`);

    let completed = 0;
    for (const channel of channels) {
      const channelLabel = channel.name || 'channel';
      log.info(`[${completed + 1}/${channels.length}] starting scan of #${channelLabel} (${channel.id})`);
      if (!('messages' in channel) || typeof channel.messages.fetch !== 'function') {
        log.warn(`Skipping channel ${channelLabel} (ID: ${channel.id}) - messages.fetch unavailable`);
        continue;
      }

      try {
        let lastId: string | null = null;
        let messagesFromThisChannel = 0;
        const channelStart = Date.now();

        while (true) {
          const messages: Collection<string, Message> = await channel.messages.fetch({
            limit: 100,
            ...(lastId ? { before: lastId } : {}),
          });

          if (messages.size === 0) break;

          messagesFromThisChannel += messages.size;
          const elapsed = ((Date.now() - channelStart) / 1000).toFixed(1);
          log.info(`  [${channel.name}] page fetched — ${messagesFromThisChannel} msgs so far, ${elapsed}s in this channel`);
          for (const msg of messages.values()) {
            if (!msg.author.bot && msg.createdAt >= cutoffDate) {
              activeUsers.add(msg.author.id);
            }
          }

          const oldestMessage = messages.last();
          if (!oldestMessage || messages.size < 100) break;
          // Cutoff reached: everything older than this is irrelevant, stop paging.
          if (oldestMessage.createdAt < cutoffDate) {
            log.info(`  [${channel.name}] reached cutoff (oldest msg ${oldestMessage.createdAt.toISOString()}); stopping here`);
            break;
          }
          lastId = oldestMessage.id;
          // Brief pause between pages to stay well under the per-endpoint rate limit.
          await new Promise((r) => setTimeout(r, 250));
        }
        const totalElapsed = ((Date.now() - channelStart) / 1000).toFixed(1);
        log.info(`✅ channel ${channel.name || channel.id} done — ${messagesFromThisChannel} messages in ${totalElapsed}s`);
      } catch (err) {
        log.error(`Error reading history for channel ${channel.name || channel.id}:`, err);
      }

      completed++;
      onProgress?.(completed, channels.length, channel.name || 'channel');
    }

    log.info(`Unique users active within the last period: ${activeUsers.size}`);

    const members = await guild.members.fetch();
    log.info(`Total members in guild: ${members.size}`);

    const inactiveUsers: UserRecord[] = [];
    for (const member of members.values()) {
      if (member.user.bot) continue;

      if (!activeUsers.has(member.id)) {
        inactiveUsers.push({
          username: member.user.username,
          id: member.id,
        });
      }
    }

    log.info(`Dry-run scan complete: ${inactiveUsers.length} inactive, results in ${dataPath('inactive_users.json')}`);
    fs.writeFileSync(dataPath('inactive_users.json'), JSON.stringify(inactiveUsers, null, 2));
    return inactiveUsers;
  }

  /**
   * True when a scan file exists (i.e. `!purgeDryRun` has been run at least once).
   * 
   * @returns Whether scan data is available
   */
  static hasScanData(): boolean {
    return fs.existsSync(dataPath('inactive_users.json'));
  }

  /**
   * Reads the list of inactive users from the JSON file.
   * 
   * @returns List of Inactive Users
   */
  static getInactiveUsers(): UserRecord[] {
    if (!fs.existsSync(dataPath('inactive_users.json'))) {
      log.warn("Inactive users data file does not exist. Please run the scan first.");
      return [];
    }

    const data = fs.readFileSync(dataPath('inactive_users.json'), 'utf-8');
    return JSON.parse(data) as UserRecord[];
  }

  /**
   * Shared reader for the whitelist and blacklist files. Both are a JSON
   * array whose entries are either a bare Discord user ID string or an object
   * with an `id` (and optionally a free-form `note`):
   *   [ { "id": "123456789012345678", "note": "admin, don't kick" } ]
   * A missing file means an empty list. A file that exists but cannot be read
   * raises `makeError`, so each list fails closed with its own error type
   * rather than one shared message.
   *
   * @param filePath - Path to the list file
   * @param listName - Human-readable name used in the error message
   * @returns The user IDs that parsed as numeric Discord snowflakes
   */
  private static readUserIdList(filePath: string, listName: 'whitelist' | 'blacklist'): string[] {
    if (!fs.existsSync(filePath)) return [];

    const makeError = (cause?: unknown) =>
      listName === 'whitelist'
        ? new WhitelistMalformedError(cause)
        : new BlacklistMalformedError(cause);

    // A 0-byte file is what you get from `touch` or an interrupted write. It
    // is not valid JSON, so it must abort like any other malformed list —
    // treating it as empty would silently un-target a blacklisted user.
    if (fs.statSync(filePath).size === 0) {
      throw makeError(`${filePath} is empty`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      throw makeError(err);
    }

    if (!Array.isArray(parsed)) {
      throw makeError(`${listName} file is not a JSON array`);
    }

    return parsed
      .map((entry: unknown): string | null => {
        if (typeof entry === 'string') return entry;
        if (entry !== null && typeof entry === 'object'
            && typeof (entry as Record<string, unknown>).id === 'string') {
          return (entry as Record<string, unknown>).id as string;
        }
        return null;
      })
      .filter((id: string | null): id is string => id !== null && /^\d+$/.test(id));
  }

  /**
   * Reads the whitelist of user IDs from data/whitelisted_users.json.
   * See {@link readUserIdList} for the accepted format. A missing file means
   * an empty whitelist (nobody has declared protections).
   *
   * @throws WhitelistMalformedError If the file exists but cannot be read,
   *   is empty, is not valid JSON, or is not an array. Callers must treat
   *   this as a hard error and abort the purge.
   * @returns Array of whitelisted user IDs
   */
  static getWhitelistedUserIds(): string[] {
    return InactiveUserService.readUserIdList(dataPath('whitelisted_users.json'), 'whitelist');
  }

  /**
   * Reads the blacklist of user IDs from data/blacklisted_users.json.
   * See {@link readUserIdList} for the accepted format. A missing file means
   * an empty blacklist (nobody is force-targeted).
   *
   * Blacklisted users are kicked regardless of recent activity, and the
   * blacklist overrides the whitelist. This is the only mechanism by which
   * the purge can remove a member who has been active, so entries are held to
   * the same fail-closed standard as the whitelist.
   *
   * @throws BlacklistMalformedError If the file exists but cannot be read,
   *   is empty, is not valid JSON, or is not an array. Callers must treat
   *   this as a hard error and abort the purge.
   * @returns Array of blacklisted user IDs
   */
  static getBlacklistedUserIds(): string[] {
    return InactiveUserService.readUserIdList(dataPath('blacklisted_users.json'), 'blacklist');
  }

  /**
   * Builds the final kick list: every scanned-inactive user except the
   * whitelisted ones, PLUS every blacklisted user regardless of activity.
   *
   * Precedence, highest first:
   *   1. Blacklist  — always a target, even if whitelisted or active.
   *   2. Whitelist  — protects a user found inactive by the scan.
   *   3. Scan       — everyone else the scan flagged.
   *
   * Blacklisted users who are not in the scan file still become targets; they
   * are resolved against the guild at kick time for a real username, so a
   * stale or wrong ID fails loudly in the results rather than silently
   * matching a stranger.
   *
   * @returns Targets with their reason, whitelisted users skipped, blacklisted
   *   targets, and any whitelist entries the blacklist overrode
   */
  static getTargetsToKick(): {
    targets: UserRecord[];
    skippedWhitelisted: string[];
    blacklisted: string[];
    whitelistOverrides: string[];
  } {
    const inactive = InactiveUserService.getInactiveUsers();
    const whitelist = new Set(InactiveUserService.getWhitelistedUserIds());
    const blacklist = new Set(InactiveUserService.getBlacklistedUserIds());
    const inactiveIds = new Set(inactive.map((u) => u.id));

    const skippedWhitelisted = inactive
      .filter((u) => whitelist.has(u.id) && !blacklist.has(u.id))
      .map((u) => `${u.username} (${u.id})`);

    // Blacklist wins over the whitelist: an entry in both is an override, and
    // it is reported rather than applied quietly.
    const whitelistOverrides = [...whitelist]
      .filter((id) => blacklist.has(id))
      .map((id) => {
        const known = inactive.find((u) => u.id === id);
        return known ? `${known.username} (${id})` : id;
      });

    const targets: UserRecord[] = inactive
      .filter((u) => !whitelist.has(u.id) || blacklist.has(u.id))
      .map((u) => ({ ...u, reason: 'inactive' }));

    // Blacklisted users the scan never flagged (i.e. they are active) are
    // still targets. Username is unknown until the guild lookup, so mark it.
    for (const id of blacklist) {
      if (inactiveIds.has(id)) continue;
      targets.push({ id, username: `unknown (${id})`, reason: 'inactive' });
    }

    return { targets, skippedWhitelisted, blacklisted: [...blacklist], whitelistOverrides };
  }

  /**
   * Best-effort display name for a target, used for audit records on paths
   * that skip the user. Blacklisted IDs that the scan never saw start life as
   * an "unknown (id)" placeholder, so a skip would otherwise be logged against
   * a placeholder rather than a person. Rejects if the member is not in the
   * guild; callers fall back to the placeholder.
   *
   * @param guild - Guild to resolve against
   * @param user - The target record
   * @returns The live username
   */
  private static async describeMember(guild: any, user: UserRecord): Promise<string> {
    const member = await guild.members.fetch(user.id);
    return member.user.username;
  }

  /**
   * Purges inactive users from the guild by kicking them, omitting the
   * whitelisted ones. Every kick outcome (success or failure with the error)
   * is written to data/purge_results.json as an audit trail, even if the run
   * is interrupted partway through.
   * 
   * @param client The Discord client instance
   * @returns A summary of kicks, failures, and whitelisted users skipped
   */
  static async purgeInactiveUsers(client: Client): Promise<PurgeResult> {
    const {
      targets,
      skippedWhitelisted,
      blacklisted,
      whitelistOverrides,
    } = InactiveUserService.getTargetsToKick();

    const guild = client.guilds.cache.first();
    if (!guild) {
      throw new Error("No guild found. The bot may not be in a server.");
    }

    if (whitelistOverrides.length) {
      log.warn(
        `Blacklist overrides ${whitelistOverrides.length} whitelist entr` +
        `${whitelistOverrides.length === 1 ? 'y' : 'ies'}: ${whitelistOverrides.join(', ')}`
      );
    }

    log.info(
      `Purging ${targets.length} users ` +
      `(${blacklisted.length} blacklisted, ${skippedWhitelisted.length} whitelisted skipped)...`
    );

    const kicked: KickOutcome[] = [];
    const failed: KickOutcome[] = [];
    const skippedUnkickable: string[] = [];
    const buildResult = (): PurgeResult => ({
      timestamp: new Date().toISOString(),
      totalTargets: targets.length,
      kicked,
      failed,
      whitelistedSkipped: skippedWhitelisted,
      blacklisted,
      whitelistOverrides,
      skippedUnkickable,
    });

    try {
      for (const user of targets) {
        const outcome: KickOutcome = {
          id: user.id,
          username: user.username,
          status: 'failed',
          at: new Date().toISOString(),
        };

        // A blacklisted ID is operator-supplied and the list is hand-edited,
        // so a fat-fingered entry must not be able to kick the bot itself and
        // take the whole purge down mid-run. Bots are skipped for the same
        // reason: they are never inactive-member cleanup targets.
        if (user.id === client.user?.id) {
          // Best-effort name lookup so the audit trail says who it was, not
          // the "unknown" placeholder a blacklisted ID starts with.
          const label = await InactiveUserService.describeMember(guild, user)
            .catch(() => user.username);
          skippedUnkickable.push(`${label} (${user.id}) — is the bot itself`);
          log.error(`Refusing to kick ${user.id}: it is this bot. Skipped.`);
          continue;
        }

        try {
          const member = await guild.members.fetch(user.id);

          if (member.user.bot) {
            skippedUnkickable.push(`${member.user.username} (${user.id}) — is a bot`);
            log.warn(`Skipping ${member.user.username} (${user.id}): bot accounts are not purge targets.`);
            continue;
          }

          // Prefer the live username over the scan file's or the "unknown"
          // placeholder, so results and the audit trail are readable.
          outcome.username = member.user.username;

          // One audit reason for every kick, regardless of which list the
          // target came from. The kick reason is visible in Discord's own
          // audit log, so a per-list reason here would identify blacklisted
          // members to anyone who can read it.
          await member.kick(PURGE_REASON);
          outcome.status = 'kicked';
          kicked.push(outcome);
          log.info(`Kicked ${outcome.username} (${user.id})`);
        } catch (err) {
          outcome.error = err instanceof Error ? err.message : String(err);
          failed.push(outcome);
          log.error(`Failed to kick ${outcome.username} (${user.id}):`, outcome.error);
        }

        await sleep(KICK_INTERVAL_MS);
      }
    } finally {
      // Always persist what happened, even if the run was interrupted.
      fs.writeFileSync(dataPath('purge_results.json'), JSON.stringify(buildResult(), null, 2));
      log.info(`Purge results written to ${dataPath('purge_results.json')}`);
    }

    return buildResult();
  }
}
