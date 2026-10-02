#Available Commands
-----------------------------------

- !purgeDryRun
- !oopsie
- !oopsiecounter
- !debug
- !github
- !purge
- !purge confirm

## Purge workflow
1. `!purgeDryRun` — scans every text channel for users inactive over a year,
   writes `data/inactive_users.json`. Safe, no action taken. Requires the purge
   role, same as `!purge` — a full-history scan is minutes of API calls. Streams a live
   "Scanning X/N" progress update (its reply is edited per channel) since a
   full-history scan can take several minutes.
2. `!purge` — preview: how many would be kicked, arms a 60-second confirmation
   window. If the blacklist is non-empty the preview names those users and
   warns that they are kicked even if active. Requires the purge role (PURGE_ROLE_ID
   or PURGE_ROLE_NAME in .env).
3. `!purge confirm` — same user, within 60s: kicks the targets. Discord only
   gets the kicked/failed counts; per-user results go to
   `data/purge_results.json`.

## The two user lists

Both files are a JSON array of `{ "id": "...", "note"?: "..." }` entries (bare
id strings also accepted):

- `data/whitelisted_users.json` — protects a user the scan flagged as inactive.
  A missing file means nobody is exempt.
- `data/blacklisted_users.json` — force-kicks a user **regardless of recent
  activity**, and overrides the whitelist. This is the only way the purge can
  remove someone who is still active, so entries should be deliberate.

Neither list is ever named in Discord. The `!purge` preview reports a count
only, and a malformed-list error tells the operator to check the log rather
than disclosing which file is broken. Full membership, the reason each target
was chosen, and any whitelist override live in `data/purge_results.json` and
`logs/kevbot.log`, which are not posted to the channel.

Precedence: blacklist > whitelist > scan. An ID in both lists is kicked, and
the override is recorded in `data/purge_results.json` under
`whitelistOverrides` and warned in the log — it is never silent, and never in
channel.

Either file that exists but cannot be read (broken JSON, not an array, or 0
bytes from an interrupted write) **aborts the purge**. A malformed list is
never treated as empty: for the whitelist that would unprotect someone, and
for the blacklist it would silently drop a kick you believe is queued.

Never kicked, recorded under `skippedUnkickable` in the results: the bot
itself (a fat-fingered ID must not make the bot disconnect mid-purge), other
bot accounts, and IDs not in the guild (recorded as a failure instead, so a
stale ID is visible rather than silently ignored).

Every kick uses the same audit reason ("Inactive for over a year") and targets
carry `reason: 'inactive'`, so which list a member came from is not
distinguishable from the kick log or the per-user results. The `blacklisted`
and `whitelistOverrides` arrays in `data/purge_results.json` remain the
record of that split.