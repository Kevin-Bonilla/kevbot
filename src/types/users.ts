export type UserRecord = {
  username: string;
  id: string;
  /**
   * Why this user is a target. 'inactive' = caught by the activity scan;
   * 'blacklisted' = explicitly listed in data/blacklisted_users.json and
   * kicked regardless of activity.
   */
  reason?: TargetReason;
};

export type TargetReason = 'inactive' | 'blacklisted';

export type KickOutcome = {
  id: string;
  username: string;
  status: 'kicked' | 'failed';
  error?: string;
  at: string;
};

export type PurgeResult = {
  timestamp: string;
  totalTargets: number;
  kicked: KickOutcome[];
  failed: KickOutcome[];
  whitelistedSkipped: string[];
  /**
   * Blacklisted users pulled in even though the scan found them active or
   * found them at all — the only reason a purge can remove an active member.
   */
  blacklisted: string[];
  /**
   * Whitelisted IDs that the blacklist overrode. Recorded explicitly because
   * it means a deliberate protection was beaten; it should never be silent.
   */
  whitelistOverrides: string[];
  /**
   * Entries that were never kicked because they cannot be: not in the guild,
   * a bot account, or the bot's own user. Anything here is a config mistake,
   * not a completed action.
   */
  skippedUnkickable: string[];
};
