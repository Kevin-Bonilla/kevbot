import fs from 'fs';
import path from 'path';
import { Client, Collection, Message } from 'discord.js';
import { UserRecord, KickOutcome, PurgeResult } from '../types/users';

const dataPath = path.resolve(__dirname, '../../data/inactive_users.json');
const whitelistPath = path.resolve(__dirname, '../../data/whitelisted_users.json');
const resultsPath = path.resolve(__dirname, '../../data/purge_results.json');

const PURGE_REASON = 'Inactive for over a year (kevbot purge)';
const KICK_INTERVAL_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Thrown when the whitelist file exists but cannot be read or parsed.
 * A corrupted whitelist must never be silently treated as empty: that would
 * let the purge kick users a maintainer explicitly tried to protect.
 */
export class WhitelistMalformedError extends Error {
  constructor(cause: unknown) {
    super(
      `The whitelist file (data/whitelisted_users.json) is present but could not be read. ` +
      `Fix the file (it must be a JSON array of { "id": "..." } entries) or delete it; ` +
      `the purge was aborted so no one is kicked by accident.`
    );
    this.name = 'WhitelistMalformedError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export class InactiveUserService {

  /**
   * Scans all text channels to find users who haven't messaged in over a year.
   * It fetches the complete available history to identify each user's latest message.
   * 
   * @param client The Discord client instance
   * @returns List of inactive user objects
   */
  static async scanInactiveUsers(client: Client): Promise<UserRecord[]> {
    console.log("Starting inactive user scan...");
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
    
    console.log(`Cutoff date set to: ${cutoffDate.toISOString()}`);
    
    const lastSeen = new Map<string, Date>();

    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error("No guild found. Could not check members.");
      return [];
    }

    const channels = guild.channels.cache.filter(c => c.isTextBased());
    console.log(`Found ${channels.size} text channels.`);
    
    for (const channel of channels.values()) {
      if (!('messages' in channel) || typeof channel.messages.fetch !== 'function') {
        console.log(`Skipping channel ${channel.name || 'Unknown'} (ID: ${channel.id}) - Reason: messages.fetch is not a function.`);
        continue;
      }

      try {
        let lastId: string | null = null;
        let messagesFromThisChannel = 0;

        while (true) {
          const messages: Collection<string, Message> = await channel.messages.fetch({
            limit: 100,
            ...(lastId ? { before: lastId } : {}),
          });

          if (messages.size === 0) break;

          messagesFromThisChannel += messages.size;
          for (const msg of messages.values()) {
            if (!msg.author.bot) {
              const currentLastSeen = lastSeen.get(msg.author.id);
              if (!currentLastSeen || msg.createdAt > currentLastSeen) {
                lastSeen.set(msg.author.id, msg.createdAt);
              }
            }
          }

          const oldestMessageId: string | undefined = messages.last()?.id;
          if (!oldestMessageId || messages.size < 100) break;
          lastId = oldestMessageId;
        }
        console.log(`Successfully scanned channel: ${channel.name} (${channel.id}) - Fetched ${messagesFromThisChannel} messages.`);
      } catch (err) {
        console.error(`Error reading history for channel ${channel?.name || channel?.id}:`, err);
      }
    }

    console.log(`Total unique users found in messages: ${lastSeen.size}`);
    
    const members = await guild.members.fetch();
    console.log(`Total members in guild: ${members.size}`);

    const inactiveUsers: UserRecord[] = [];
    for (const member of members.values()) {
      if (member.user.bot) continue;

      const lastDate = lastSeen.get(member.id);
      if (!lastDate || lastDate < cutoffDate) {
        inactiveUsers.push({
          username: member.user.username,
          id: member.id,
          lastActive: lastDate?.toISOString() ?? null,
        });
      }
    }

    console.log(`Inactive users identified: ${inactiveUsers.length}`);
    fs.writeFileSync(dataPath, JSON.stringify(inactiveUsers, null, 2));
    return inactiveUsers;
  }

  /**
   * True when a scan file exists (i.e. `!purgeDryRun` has been run at least once).
   * 
   * @returns Whether scan data is available
   */
  static hasScanData(): boolean {
    return fs.existsSync(dataPath);
  }

  /**
   * Reads the list of inactive users from the JSON file.
   * 
   * @returns List of Inactive Users
   */
  static getInactiveUsers(): UserRecord[] {
    if (!fs.existsSync(dataPath)) {
      console.warn("Inactive users data file does not exist. Please run the scan first.");
      return [];
    }

    const data = fs.readFileSync(dataPath, 'utf-8');
    return JSON.parse(data) as UserRecord[];
  }

  /**
   * Reads the whitelist of user IDs from data/whitelisted_users.json.
   * Format: a JSON array of entries, each an object with a Discord user
   * `id`, optionally carrying a free-form `note`:
   *   [
   *     { "id": "123456789012345678", "note": "admin, don't kick" },
   *     { "id": "987654321098765432" }
   *   ]
   * Bare id strings in the array are also accepted for convenience.
   * A missing file means an empty whitelist (nobody has declared protections).
   * 
   * @throws WhitelistMalformedError If the file exists but cannot be read,
   *   is not valid JSON, or is not an array. Callers must treat this as a
   *   hard error and abort the purge.
   * @returns Array of whitelisted user IDs
   */
  static getWhitelistedUserIds(): string[] {
    if (!fs.existsSync(whitelistPath)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(whitelistPath, 'utf-8'));
    } catch (err) {
      throw new WhitelistMalformedError(err);
    }

    if (!Array.isArray(parsed)) {
      throw new WhitelistMalformedError('whitelist file is not a JSON array');
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
   * Splits the scanned inactive users into kick targets and the ones skipped
   * because they are whitelisted.
   * 
   * @returns Kick targets plus a human-readable list of skipped (whitelisted) users
   */
  static getTargetsToKick(): { targets: UserRecord[]; skippedWhitelisted: string[] } {
    const inactive = InactiveUserService.getInactiveUsers();
    const whitelist = new Set(InactiveUserService.getWhitelistedUserIds());

    const targets = inactive.filter((u) => !whitelist.has(u.id));
    const skippedWhitelisted = inactive
      .filter((u) => whitelist.has(u.id))
      .map((u) => `${u.username} (${u.id})`);

    return { targets, skippedWhitelisted };
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
    const { targets, skippedWhitelisted } = InactiveUserService.getTargetsToKick();

    const guild = client.guilds.cache.first();
    if (!guild) {
      throw new Error("No guild found. The bot may not be in a server.");
    }

    console.log(`Purging ${targets.length} inactive users (${skippedWhitelisted.length} whitelisted skipped)...`);

    const kicked: KickOutcome[] = [];
    const failed: KickOutcome[] = [];
    const buildResult = (): PurgeResult => ({
      timestamp: new Date().toISOString(),
      totalTargets: targets.length,
      kicked,
      failed,
      whitelistedSkipped: skippedWhitelisted,
    });

    try {
      for (const user of targets) {
        const outcome: KickOutcome = {
          id: user.id,
          username: user.username,
          status: 'failed',
          at: new Date().toISOString(),
        };

        try {
          const member = await guild.members.fetch(user.id);
          await member.kick(PURGE_REASON);
          outcome.status = 'kicked';
          kicked.push(outcome);
          console.log(`Kicked ${user.username} (${user.id})`);
        } catch (err) {
          outcome.error = err instanceof Error ? err.message : String(err);
          failed.push(outcome);
          console.error(`Failed to kick ${user.username} (${user.id}):`, outcome.error);
        }

        await sleep(KICK_INTERVAL_MS);
      }
    } finally {
      // Always persist what happened, even if the run was interrupted.
      fs.writeFileSync(resultsPath, JSON.stringify(buildResult(), null, 2));
      console.log(`Purge results written to ${resultsPath}`);
    }

    return buildResult();
  }
}
