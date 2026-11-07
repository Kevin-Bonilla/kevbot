# Kevbot

A Discord bot built with Node.js and TypeScript.

## Setup Instructions
1. Clone the repository.
2. Install dependencies: `npm install`.
3. Create a `.env` file with your `DISCORD_TOKEN`.
4. Run the bot: `npm run dev`.

## Development Commands
- `npm run dev`: Starts the bot in watch mode for development.
- `npm run build`: Compiles the TypeScript source code into JavaScript.
- `npm run start`: Runs the compiled production build.

## Commands

Kevbot is slash-only: every command is a Discord application command,
registered on startup (guild-scoped, so a redeploy updates them immediately).
The old `!message` commands are gone, and with them the `messageCreate`
handler, the privileged **MessageContent** intent, and the `GuildMessages`
intent. Discord intercepts a leading `/` client-side, so a literal `/died`
message never reaches the bot.

| Command | Restrictions |
| --- | --- |
| `/died`, `/deathcounter`, `/deathleaderboard` | none |
| `/oopsie`, `/oopsiecounter` | kevins-ai-chamber only |
| `/purge dry-run`, `/purge preview` + Confirm/Cancel | kevins-ai-chamber only + purge role |
| `/debug` | kevins-ai-chamber only |
| `/status` | none |
| `/github` | none |

The channel and role restrictions are deliberate and enforced in code (channel
in `src/index.ts`, role in `src/services/role-gate.service.ts`);
`tests/commands/registration.test.ts` pins the set so one cannot be dropped by
accident. If commands do not appear in Discord, re-invite the bot with the
`applications.commands` scope. The full reference, including the purge
workflow and the whitelist/blacklist rules, is in
[src/commands/commands.md](src/commands/commands.md).

## Death counters

`/died <name>`, `/deathcounter <name>`, and `/deathleaderboard` are covered in
the table above. Counts are stored per character in `data/kevbot.db`, a SQLite
database using
Node's built-in `node:sqlite`. That means no database server on the VM and no
native module to compile in the alpine image. The file is created on first use
and lives in the `data/` volume, so back it up (ideally with the bot stopped)
along with the other `data/` files.
Node **22.13 or newer** is required for unflagged `node:sqlite`; the
Dockerfile's `node:22-alpine` satisfies this, and CI verifies the module loads
in the built image. Node still prints an `ExperimentalWarning` for
`node:sqlite` at startup — that is expected until the module is marked stable.

## Deployment (always-on)

Oracle Always Free VM, Docker + systemd. On the VM:

```bash
bash deploy/setup-vm.sh
```

That clones the repo to `/opt/kevbot`, creates `data/` and `logs/`, builds the
image, installs `deploy/kevbot.service`, and starts the bot with
`Restart=always`. Operate it with `systemctl status kevbot`,
`journalctl -u kevbot -f`, and `sudo systemctl restart kevbot`.

Secrets and the user lists are gitignored, so they exist only on the VM:
`.env` (token, purge role), `data/whitelisted_users.json`, and
`data/blacklisted_users.json`. Copy them onto a new machine by hand. The
death-counter database (`data/kevbot.db`) is also VM-only state — back it up
with the lists, since it holds the only copy of the counts.

### Deploy announcements

The bot announces deploys in kevins-ai-chamber:

- `Kevbot is going sleep 💤. He has a deployment happening rn` — on SIGTERM,
  which is what `docker stop` sends, and therefore what
  `systemctl restart kevbot` (and `deploy/setup-vm.sh`) triggers.
- `Kevbot is updated and awake! ☀️` — on the next startup, once the gateway is
  ready.

The shutdown writes `data/deploy-pending.json`; the next start only announces
when that marker exists and is less than 15 minutes old. That is what keeps a
crash restart (`Restart=always`) or a deploy that never came back from posting
a misleading "awake", and it means the hand-off survives the container being
replaced. SIGINT is quiet (a local Ctrl-C is not a deploy), and so is every run
that is not `NODE_ENV=production` — the image sets that, `npm run dev` does not,
so a dev restart never posts.

`/status` reports the uptime, the commit the image was built from
(`KEVBOT_COMMIT`, stamped by `setup-vm.sh`), guild counts, gateway ping, and
memory. See [src/commands/commands.md](src/commands/commands.md).

The bot handles `SIGTERM`/`SIGINT` for a clean gateway shutdown, and logs
disconnects and unhandled rejections so a dead connection is visible in the
journal instead of silent.

### Logging on OCI

Logs live in two places on the VM: the systemd journal (`journalctl -u kevbot`)
and `/opt/kevbot/logs/kevbot.log` on the host, written through the container's
`/app/logs` bind mount. To also send them to **OCI Logging** (Console search,
retention, agent-health alarms), follow
[deploy/oci-logging/README.md](deploy/oci-logging/README.md). It is a one-time
setup: enable the Custom Logs Monitoring plugin, create the dynamic
group/policy, point an agent configuration at `/opt/kevbot/logs/kevbot.log`,
and set `LOG_FORMAT=json` so the agent can parse the lines. The log group and
log can be created in the Console or with [`deploy/tf/`](deploy/tf/main.tf).
Check the chain at any time with:

```bash
sudo bash /opt/kevbot/deploy/oci-logging/check-agent.sh --emit-test
```

## Environment
Copy `.env.example` to `.env`. Key variables:
- `DISCORD_TOKEN` — bot token (required).
- `PURGE_ROLE_ID` / `PURGE_ROLE_NAME` — role gate for `/purge dry-run` and
  `/purge preview`. If neither resolves to a real guild role, the purge stays
  disabled. `PURGE_ADMIN_IDS` (comma-separated user IDs) authorizes the same
  commands without a role. See `src/services/role-gate.service.ts`.
- `LOG_LEVEL` — `debug | info | warn | error` (default `info`).
- `LOG_FILE` — app log file, appended (default `logs/kevbot.log`).
- `LOG_FORMAT` — `text | json`, serialization of the **log file** (default
  `text`; the console stays text). Set `json` on the VM for OCI Logging.
- `KEVBOT_COMMIT` — not a `.env` value: the commit is passed as a Docker build
  arg by `deploy/setup-vm.sh` and shown by `/status` as the running build. It
  is `unknown` for local and CI builds.

Logging is app-wide: `import { log } from './logging/logger'` and call
`log.debug/info/warn/error(msg, ...extra)`. Every line goes to the console
and is appended to the log file; `.gitignore` already excludes `*.log`.
