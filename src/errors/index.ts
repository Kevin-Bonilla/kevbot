/**
 * Custom error types for kevbot.
 *
 * Every error the bot throws on purpose lives here, so callers can branch on
 * a type (`err instanceof WhitelistMalformedError`) instead of matching on
 * message strings. Messages that users may see in Discord belong in the
 * constructor: the command layer decides whether to surface them.
 *
 * One file per feature area, aggregated here so callers import from '../errors'
 * and never need to know which file a given error came from. `KevbotError`
 * itself is deliberately NOT re-exported: error modules import it from
 * ./kevbot-error directly, so extending it can never form a require cycle
 * through this barrel.
 */
export { KevbotError } from './kevbot-error';
export {
  UserListMalformedError,
  WhitelistMalformedError,
  BlacklistMalformedError,
} from './purge-errors';
