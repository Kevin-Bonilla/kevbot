import { KevbotError } from './kevbot-error';

/**
 * Thrown when the whitelist file exists but cannot be read or parsed.
 * A corrupted whitelist must never be silently treated as empty: that would
 * let the purge kick users a maintainer explicitly tried to protect.
 */
export class WhitelistMalformedError extends KevbotError {
  constructor(cause?: unknown) {
    super(
      `The whitelist file (data/whitelisted_users.json) is present but could not be read. ` +
      `Fix the file (it must be a JSON array of { "id": "..." } entries) or delete it; ` +
      `the purge was aborted so no one is kicked by accident.`,
      cause
    );
  }
}