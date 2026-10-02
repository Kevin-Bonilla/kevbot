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
`data/blacklisted_users.json`. Copy them onto a new machine by hand.

The bot handles `SIGTERM`/`SIGINT` for a clean gateway shutdown, and logs
disconnects and unhandled rejections so a dead connection is visible in the
journal instead of silent.

## Environment
Copy `.env.example` to `.env`. Key variables:
- `DISCORD_TOKEN` — bot token (required).
- `PURGE_ROLE_ID` / `PURGE_ROLE_NAME` — role gate for `!purgeDryRun`, `!purge`
  and `!purge confirm`. Shared by all three via `src/services/role-gate.service.ts`;
  if neither resolves to a real guild role, all three stay disabled.
- `LOG_LEVEL` — `debug | info | warn | error` (default `info`).
- `LOG_FILE` — app log file, appended (default `logs/kevbot.log`).

Logging is app-wide: `import { log } from './logging/logger'` and call
`log.debug/info/warn/error(msg, ...extra)`. Every line goes to the console
and is appended to the log file; `.gitignore` already excludes `*.log`.
