export type UserRecord = {
  username: string;
  id: string;
  /**
   * Why this user is a target.
   *
   * Currently always 'inactive': the distinction between scan-detected and
   * blacklisted targets is deliberately not surfaced, because the kick audit
   * reason and this field both end up readable outside the bot. The two
   * sources are still recoverable from PurgeResult.blacklisted. 'blacklisted'
   * is kept in the union so that distinction can be restored without
   * reshaping the type.
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
   * This is the operator-facing record of which targets came from which list,
   * now that UserRecord.reason does not distinguish them.
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
