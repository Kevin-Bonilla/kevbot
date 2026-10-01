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

## Environment
Copy `.env.example` to `.env`. Key variables:
- `DISCORD_TOKEN` — bot token (required).
- `PURGE_ROLE_ID` / `PURGE_ROLE_NAME` — role gate for `!purge` / `!purge confirm`.
- `LOG_LEVEL` — `debug | info | warn | error` (default `info`).
- `LOG_FILE` — app log file, appended (default `logs/kevbot.log`).

Logging is app-wide: `import { log } from './logging/logger'` and call
`log.debug/info/warn/error(msg, ...extra)`. Every line goes to the console
and is appended to the log file; `.gitignore` already excludes `*.log`.
