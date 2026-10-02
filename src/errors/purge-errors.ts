import { KevbotError } from './kevbot-error';

/**
 * Thrown when a user list file (whitelist or blacklist) exists but cannot be
 * read or parsed.
 *
 * A corrupted list must never be silently treated as empty. For the whitelist
 * that would kick users a maintainer explicitly tried to protect; for the
 * blacklist it would quietly skip a targeted kick. Either way the operator
 * believes something is protected or pending that the run is not honoring, so
 * the purge aborts and the file gets fixed by hand.
 *
 * Carries two messages on purpose:
 *   - `message` — safe to show in Discord. Deliberately does NOT name which
 *     list or which file: the purge is role-gated, and an error posted in
 *     channel would otherwise disclose that a blacklist exists and which file
 *     backs it.
 *   - `detail`  — full diagnosis for the log file, where the operator does
 *     need the list name, the path, and the underlying parse error.
 */
export class UserListMalformedError extends KevbotError {
  /** Full diagnosis: list name, file path, expected shape, cause. Logs only. */
  readonly detail: string;

  /**
   * @param listName - Human-readable list name, e.g. 'whitelist' (detail only)
   * @param filePath - Path to the offending file (detail only)
   * @param expected - Description of the required shape (detail only)
   * @param cause - The underlying parse error, if any
   */
  constructor(
    listName: string,
    filePath: string,
    expected: string,
    cause?: unknown
  ) {
    super(
      `A user list file used by the purge is present but could not be read, so the ` +
      `purge was aborted and no one was kicked. Fix the malformed file (or delete ` +
      `it) and run \`!purge\` again — the log file has the details.`
    );
    this.detail =
      `The ${listName} file (${filePath}) is present but could not be read. ` +
      `Fix the file (${expected}) or delete it; ` +
      `the purge was aborted so no one is kicked by accident.` +
      (cause instanceof Error ? ` Cause: ${cause.message}` : '');
  }
}

/** The whitelist is present but unreadable — abort rather than treat as empty. */
export class WhitelistMalformedError extends UserListMalformedError {
  constructor(cause?: unknown) {
    super(
      'whitelist',
      'data/whitelisted_users.json',
      'it must be a JSON array of { "id": "..." } entries',
      cause
    );
  }
}

/** The blacklist is present but unreadable — abort rather than skip the kick. */
export class BlacklistMalformedError extends UserListMalformedError {
  constructor(cause?: unknown) {
    super(
      'blacklist',
      'data/blacklisted_users.json',
      'it must be a JSON array of { "id": "..." } entries',
      cause
    );
  }
}
