import { log } from '../logging/logger';

/**
 * Shared role gate for the privileged maintenance commands (`!purgeDryRun`,
 * `!purge`, `!purge confirm`).
 *
 * Two independent ways to be authorized, either of which is sufficient:
 *
 *   1. PURGE_ROLE_ID / PURGE_ROLE_NAME — a guild role. Preferred: it survives
 *      the operator losing an account and can be handed to a co-moderator
 *      without touching config.
 *   2. PURGE_ADMIN_IDS — a comma-separated list of Discord *user* IDs. Held
 *      as a fallback because a user ID is far easier to obtain than a role ID
 *      (right-click yourself -> Copy User ID, no Developer Mode needed), and
 *      a server owner always has a user ID to hand.
 *
 * A user ID is NOT interchangeable with a role ID: they are different snowflake
 * namespaces, so a user ID in PURGE_ROLE_ID would never match the guild's role
 * cache. Keeping them in separate variables is what makes that mistake
 * impossible rather than silently denied.
 *
 * No valid configuration means nobody passes — an unconfigured gate must fail
 * closed, never open.
 *
 * Extracted from src/commands/purge.ts so the dry run and the real purge
 * can't drift apart: a scan is just as expensive and as intrusive as the
 * kicks it feeds.
 */

/**
 * Parses PURGE_ADMIN_IDS into a set of user IDs, dropping anything that isn't
 * a plausible snowflake. A malformed entry is ignored rather than fatal, so a
 * stray space or comma can't lock the operator out of their own bot; the
 * dropped value is logged.
 *
 * @returns The configured admin user IDs
 */
function resolveAdminIds(): Set<string> {
  const raw = process.env.PURGE_ADMIN_IDS?.trim();
  if (!raw) return new Set();

  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const valid = ids.filter((id) => /^\d{17,20}$/.test(id));
  const dropped = ids.filter((id) => !/^\d{17,20}$/.test(id));
  if (dropped.length) {
    log.warn(`Ignoring malformed PURGE_ADMIN_IDS entries (not a Discord ID): ${dropped.join(', ')}`);
  }
  return new Set(valid);
}

/**
 * Resolves the purge role ID from env config: PURGE_ROLE_ID if it exists in
 * the guild, otherwise a guild role matched (case-insensitive) by name via
 * PURGE_ROLE_NAME. Returns null when no valid role is configured.
 *
 * @param guild - The guild the command was invoked in (may be undefined in DMs)
 * @returns The ID of the purge role, or null if not found
 */
export function resolvePurgeRoleId(guild: any): string | null {
  if (!guild) return null;

  const roleId = process.env.PURGE_ROLE_ID;
  if (roleId && guild.roles.cache.has(roleId)) return roleId;

  const roleName = process.env.PURGE_ROLE_NAME;
  if (roleName) {
    const role = guild.roles.cache.find(
      (r: any) => r.name.toLowerCase() === roleName.trim().toLowerCase()
    );
    if (role) return role.id;
  }

  log.debug('Purge role could not be resolved from PURGE_ROLE_ID / PURGE_ROLE_NAME');
  return null;
}

/**
 * True when the message author holds the configured purge role OR is listed
 * in PURGE_ADMIN_IDS.
 *
 * @param message - The Discord message object
 * @returns Whether the author is allowed to run the gated command
 */
export function canPurge(message: any): boolean {
  const authorId = message.author?.id;
  const who = `${message.author?.username} (${authorId})`;

  // User-ID check first: it is the path a solo operator actually takes, and it
  // works even when no role exists in the guild.
  const adminIds = resolveAdminIds();
  if (authorId && adminIds.has(authorId)) {
    return true;
  }

  const roleId = resolvePurgeRoleId(message.guild);
  if (!roleId) {
    log.warn(`Denied ${who}: no valid purge role or admin ID configured`);
    return false;
  }

  const allowed = !!message.member && message.member.roles.cache.has(roleId);
  if (!allowed) {
    log.info(`Denied ${who}: lacks purge role ${roleId} and is not in PURGE_ADMIN_IDS`);
  }
  return allowed;
}

/**
 * Replies with a permission error tailored to the configured state, so the
 * caller learns whether they're missing access or nothing was ever set up.
 *
 * @param message - The Discord message object
 * @param commandName - The command the author tried to run
 * @returns A promise that resolves when the reply has been sent
 */
export async function replyNoPermission(message: any, commandName = '!purge'): Promise<void> {
  const configured =
    !!process.env.PURGE_ROLE_ID ||
    !!process.env.PURGE_ROLE_NAME ||
    !!process.env.PURGE_ADMIN_IDS?.trim();

  if (configured) {
    await message.reply(`You need the purge role to use \`${commandName}\`.`);
  } else {
    await message.reply(
      `Access is not configured yet (set PURGE_ADMIN_IDS or PURGE_ROLE_ID in .env); ` +
      `\`${commandName}\` is disabled.`
    );
  }
}
