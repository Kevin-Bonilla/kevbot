import { log } from '../logging/logger';

/**
 * Shared role gate for the privileged maintenance commands (`!purgeDryRun`,
 * `!purge`, `!purge confirm`).
 *
 * Resolved from env config: PURGE_ROLE_ID if it exists in the guild,
 * otherwise a guild role matched (case-insensitive) by name via
 * PURGE_ROLE_NAME. No valid configuration means nobody passes — an
 * unconfigured gate must fail closed, never open.
 *
 * Extracted from src/commands/purge.ts so the dry run and the real purge
 * can't drift apart: a scan is just as expensive and as intrusive as the
 * kicks it feeds.
 */

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
 * True when the message author holds the configured purge role.
 *
 * @param message - The Discord message object
 * @returns Whether the author is allowed to run the gated command
 */
export function canPurge(message: any): boolean {
  const roleId = resolvePurgeRoleId(message.guild);
  if (!roleId) {
    log.warn(`Denied ${message.author?.username} (${message.author?.id}): no valid purge role configured`);
    return false;
  }
  const allowed = !!message.member && message.member.roles.cache.has(roleId);
  if (!allowed) {
    log.info(`Denied ${message.author?.username} (${message.author?.id}): lacks purge role ${roleId}`);
  }
  return allowed;
}

/**
 * Replies with a permission error tailored to the configured state, so the
 * caller learns whether they're missing the role or the role was never set up.
 *
 * @param message - The Discord message object
 * @param commandName - The command the author tried to run
 * @returns A promise that resolves when the reply has been sent
 */
export async function replyNoPermission(message: any, commandName = '!purge'): Promise<void> {
  if (process.env.PURGE_ROLE_ID || process.env.PURGE_ROLE_NAME) {
    await message.reply(`You need the purge role to use \`${commandName}\`.`);
  } else {
    await message.reply(
      `The purge role is not configured yet (set PURGE_ROLE_ID in .env); \`${commandName}\` is disabled.`
    );
  }
}
