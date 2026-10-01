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
   writes `data/inactive_users.json`. Safe, no action taken.
2. `!purge` — preview: how many would be kicked (minus whitelisted), arms
   a 60-second confirmation window. Requires the purge role (PURGE_ROLE_ID
   or PURGE_ROLE_NAME in .env).
3. `!purge confirm` — same user, within 60s: kicks the targets. Skips anyone
   in `data/whitelisted_users.json`, an array of `{ "id": "...", "note"?: "..." }`
   entries (bare id strings also accepted), e.g.
   `[ { "id": "123...", "note": "admin, don't kick" } ]`.
   Discord only gets the kicked/failed counts; per-user results go to
   `data/purge_results.json`.