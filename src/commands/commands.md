# Available Commands
-----------------------------------

Every command is a Discord slash command (application command), registered with
Discord on startup and guild-scoped so changes appear immediately. There are no
message commands: Discord intercepts a leading `/` client-side, so a literal
`/died` message never reaches the bot.

## Command list

| Command | What it does | Restrictions |
| --- | --- | --- |
| `/died <name>` | Records one death, creating the character on first use. | none |
| `/deathcounter <name>` | One character's death total. | none |
| `/deathleaderboard` | Every character, most deaths first, with a grand total. | none |
| `/oopsie` | Increments the Matthew Oopsie counter. | kevins-ai-chamber only |
| `/oopsiecounter` | Shows the current Oopsie count. | kevins-ai-chamber only |
| `/purge dry-run` | Scans for inactive members. No kicks. | kevins-ai-chamber only + purge role |
| `/purge preview` | Reports the kick count and posts Confirm / Cancel. | kevins-ai-chamber only + purge role |
| `/debug` | Bot status and guild counts. | kevins-ai-chamber only |
| `/status` | Uptime, running build, guild counts, gateway ping, memory. | none |
| `/github` | Link to the repository. | none |

Names are case-insensitive and whitespace-trimmed for the counters, so
`matthew`, `Matthew`, and ` matthew ` are one character. Death counts live in
`data/kevbot.db` (SQLite, built into Node 22 — no database server and no native
addon to install).

If a command does not appear in Discord, the bot is missing the
`applications.commands` scope: re-invite it with that scope. If it appears but
refuses to run, it is either in the wrong channel (the reply says which one is
allowed) or, for `/purge`, you lack the purge role.

## Deployment announcements

The bot announces a deploy in kevins-ai-chamber:

- `Kevbot is going sleep 💤. He has a deployment happening rn` — posted on
  SIGTERM, which is what `docker stop` sends, so `systemctl restart kevbot` and
  `deploy/setup-vm.sh` both trigger it.
- `Kevbot is updated and awake! ☀️` — posted on the next startup, once the
  gateway is ready.

The second message only appears when the shutdown left
`data/deploy-pending.json` behind, so a crash restart is silent, and a marker
older than 15 minutes is treated as a deploy that never completed. SIGINT (a
local Ctrl-C) never announces, and neither does any run that is not
`NODE_ENV=production` — the production image sets it, so `npm run dev` does not
post on every save.

## Restrictions

Two kinds, both enforced in code:

- **Channel**: `/oopsie`, `/oopsiecounter`, `/debug` and `/purge` only work in
  kevins-ai-chamber, the same channel the old `!` message commands required.
  The check lives in the dispatcher (`src/index.ts`); a use elsewhere gets an
  ephemeral "only works in #kevins-ai-chamber". Discord cannot express
  per-channel command permissions for a bot, so this is a guardrail rather
  than a security boundary.
- **Role**: `/purge` requires the purge role from `PURGE_ROLE_ID` /
  `PURGE_ROLE_NAME`, or a user ID in `PURGE_ADMIN_IDS`. An unconfigured gate
  denies everyone. See "The purge gate" below.

## Counters

- `/oopsie` — increments the Oopsie counter, replies with the new total.
- `/oopsiecounter` — replies with the current total.
- `/died <name>` — +1 death for that character.
- `/deathcounter <name>` — that character's total.
- `/deathleaderboard` — ranked list; splits into several messages when the list
  outgrows Discord's 2000-character limit.

## Purge workflow

1. `/purge dry-run` — scans every text channel for users inactive over a year,
   writes `data/inactive_users.json`. Safe, no action taken. Requires the purge
   role, same as `/purge preview` — a full-history scan is minutes of API calls.
   Streams a live "Scanning X/N" progress update (its reply is edited per
   channel) since a full-history scan can take several minutes.
2. `/purge preview` — preview: how many would be kicked, arms a 60-second
   confirmation window and posts **Confirm** / **Cancel** buttons. If the
   blacklist is non-empty the preview still only reports a count; the
   blacklist's effect is visible in the audit file after the run. Requires the
   purge role.
3. Press **Confirm** (same user, within 60s) — kicks the targets. Discord only
   gets the kicked/failed counts; per-user results go to
   `data/purge_results.json`. **Cancel** disarms it and kicks nobody. After 60
   seconds the buttons expire and the preview must be re-run.

Only one purge can be armed at a time. Running `/purge preview` again replaces
the older preview, and the older message's buttons stop working — a stale click
can never confirm the newer purge.

## The purge gate

Either of these authorizes `/purge`:

- `PURGE_ROLE_ID` (a role ID that exists in the guild) or `PURGE_ROLE_NAME`
  (matched case-insensitively), or
- `PURGE_ADMIN_IDS`, a comma-separated list of user IDs.

A user ID is not interchangeable with a role ID. If neither is configured, the
commands stay disabled and say so — the gate fails closed.

## The two user lists

Both files are a JSON array of `{ "id": "...", "note"?: "..." }` entries (bare
id strings also accepted):

- `data/whitelisted_users.json` — protects a user the scan flagged as inactive.
  A missing file means nobody is exempt.
- `data/blacklisted_users.json` — force-kicks a user **regardless of recent
  activity**, and overrides the whitelist. This is the only way the purge can
  remove someone who is still active, so entries should be deliberate.

Neither list is ever named in Discord. The `/purge preview` reply reports a
count only, and a malformed-list error tells the operator to check the log
rather than disclosing which file is broken. Full membership, the reason each
target was chosen, and any whitelist override live in
`data/purge_results.json` and `logs/kevbot.log`, which are not posted to the
channel.

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
