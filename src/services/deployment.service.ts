import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'discord.js';
import { ADMIN_CHANNELS } from '../config/admin-channels';
import { log } from '../logging/logger';

/**
 * Deployment announcements.
 *
 * A deploy on the VM is `git pull` + `docker build` + `systemctl restart`: the
 * running container gets SIGTERM (`docker stop -t 30`) and a fresh process
 * comes up seconds later. So the only chance to say "I'm going down" is the
 * shutdown handler, and the only way to tell "I came back from a deploy" from
 * "systemd restarted me after a crash" is state that survives the restart. That
 * state is a marker file in the data volume (the same volume that already holds
 * the counter, the death database, and the purge lists).
 *
 *   1. SIGTERM  -> write data/deploy-pending.json, post the sleep message.
 *   2. clientReady -> if the marker exists and is fresh, post the awake
 *      message and delete the marker.
 *
 * The consequences are deliberate:
 *
 *   - A crash or a dev restart leaves no marker, so it stays quiet instead of
 *     posting "awake" on every crash-loop attempt (RestartSec=10 would make
 *     that five messages in under a minute).
 *   - A stale marker is ignored. A deploy that never came back, or a VM that
 *     was off for a day, must not announce a restart as if it just happened.
 *   - Announcements are production-only. `npm run dev` restarts the child on
 *     every save (tsx watch uses SIGTERM), and posting to the real channel on
 *     each edit would be noise. The image sets NODE_ENV=production, which is
 *     what the VM runs.
 *   - Neither exported function ever throws. announceGoingDown() runs inside
 *     the shutdown path, where an exception would skip client.destroy() and
 *     leave the gateway to be SIGKILLed by Docker instead of closed cleanly.
 *
 * Channel: kevins-ai-chamber, the admin channel every operational message
 * already goes to (ADMIN_CHANNELS). It is pinned in code for the same reasons
 * as the command restrictions — a channel ID is not a secret, the repo is the
 * deployment artifact, and an empty env value would silently disable the
 * announcements with no visible cause.
 */

const ANNOUNCEMENT_CHANNEL_ID = ADMIN_CHANNELS.kevinsAiChamber;

export const DEPLOY_SLEEP_MESSAGE = 'Kevbot is going sleep 💤. He has a deployment happening rn';
export const DEPLOY_AWAKE_MESSAGE = 'Kevbot is updated and awake! ☀️';

/**
 * How long a shutdown marker stays trustworthy.
 *
 * A restart normally follows the stop within seconds, so this only has to
 * cover a slow container start. Beyond it the deploy did not complete (build
 * failed after the stop, host went down, ...) and an "awake" message would be
 * misleading.
 */
export const DEPLOY_MARKER_TTL_MS = 15 * 60 * 1000;

/** Upper bound on one Discord call during shutdown; docker stop allows 30s. */
const SEND_TIMEOUT_MS = 5_000;

/** What the shutdown handler leaves behind for the next process to find. */
interface DeployMarker {
  /** Epoch ms at which the previous process was asked to stop. */
  at: number;
  /** PID of the previous process, so the log can name both sides of a deploy. */
  pid: number;
}

/**
 * Absolute marker path. KEVBOT_DATA_DIR is honoured for the same reason as in
 * counter.service.ts: a test can point at a temp dir instead of the real
 * data/ directory shared with the running bot.
 */
export function deploymentMarkerPath(): string {
  const dir = process.env.KEVBOT_DATA_DIR
    ? path.resolve(process.env.KEVBOT_DATA_DIR)
    : path.resolve(__dirname, '../../data');
  return path.join(dir, 'deploy-pending.json');
}

/**
 * True on the VM, false under `npm run dev` / tests.
 *
 * NODE_ENV=production is baked into the runtime image (see Dockerfile), so this
 * needs no extra configuration and cannot be forgotten in .env.
 */
function announcementsEnabled(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Writes the marker before the sleep message is attempted, so a failed send
 * does not also lose the fact that the stop was a deploy. Write-then-rename:
 * a SIGKILL mid-write must not leave half a JSON document for the next boot to
 * interpret.
 */
function writeMarker(): void {
  const target = deploymentMarkerPath();
  const marker: DeployMarker = { at: Date.now(), pid: process.pid };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marker));
    fs.renameSync(tmp, target);
  } catch (err) {
    log.error('Could not write the deploy marker; the awake announcement will be skipped:', err);
  }
}

/**
 * Reads the marker if there is one. A missing file means "no deploy in
 * progress"; an unreadable or malformed one is removed and treated the same,
 * so a partial write cannot wedge every future startup.
 */
function readMarker(): DeployMarker | null {
  const file = deploymentMarkerPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read the deploy marker ${file}; assuming no deploy:`, err);
    }
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DeployMarker>;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) {
      throw new Error('missing a numeric "at" timestamp');
    }
    return { at: parsed.at, pid: typeof parsed.pid === 'number' ? parsed.pid : 0 };
  } catch (err) {
    log.warn(`Ignoring an unreadable deploy marker at ${file}:`, err);
    clearMarker();
    return null;
  }
}

/** Best-effort delete; a marker that is already gone is not an error. */
function clearMarker(): void {
  try {
    fs.unlinkSync(deploymentMarkerPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not remove the deploy marker:', err);
    }
  }
}

/**
 * Posts one line to the announcement channel.
 *
 * `channels.fetch` rather than `channels.cache.get` so the send still works on
 * a cold cache (the awake message is posted as soon as the client is ready,
 * before anyone has touched the channel). A missing channel, missing Send
 * Messages permission, or a hung request is logged and reported as false; the
 * caller decides what that means for the marker.
 */
async function sendToChannel(client: Client, content: string): Promise<boolean> {
  try {
    const channel = await withTimeout(client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID), SEND_TIMEOUT_MS);
    if (!channel || !channel.isSendable()) {
      log.warn(
        `Deployment announcement channel ${ANNOUNCEMENT_CHANNEL_ID} is missing or not sendable; ` +
        'check the bot is still in the guild and can post there.'
      );
      return false;
    }
    // Explicit <unknown>: channel.send() returns a union of Message<false> and
    // Message<true> promises, and inference would pin T to one arm of it.
    await withTimeout<unknown>(channel.send(content), SEND_TIMEOUT_MS);
    return true;
  } catch (err) {
    log.error('Could not post the deployment announcement:', err);
    return false;
  }
}

/** Rejects rather than hanging the shutdown path on a wedged REST call. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Says the bot is going to sleep, then leaves the marker for the restart.
 *
 * Called from the SIGTERM handler in src/index.ts, before client.destroy().
 * Never throws, and bounded by SEND_TIMEOUT_MS so a stuck request cannot eat
 * the 30 seconds `docker stop` allows before SIGKILL.
 */
export async function announceGoingDown(client: Client): Promise<void> {
  if (!announcementsEnabled()) {
    log.debug('Deployment announcements are off (NODE_ENV is not production).');
    return;
  }

  writeMarker();
  const sent = await sendToChannel(client, DEPLOY_SLEEP_MESSAGE);
  if (sent) {
    log.info('Posted the deployment sleep announcement.');
  } else {
    log.warn('The sleep announcement was not posted; the marker is kept so the restart can still announce.');
  }
}

/**
 * Says the bot is updated and awake, but only when the previous process left a
 * fresh marker (i.e. this start is the other half of a deploy).
 *
 * Called from the clientReady handler in src/index.ts. Never throws; a failed
 * send keeps the marker so the next restart within the TTL can retry instead
 * of losing the announcement entirely.
 */
export async function announceBackUp(client: Client): Promise<void> {
  if (!announcementsEnabled()) {
    log.debug('Deployment announcements are off (NODE_ENV is not production).');
    return;
  }

  const marker = readMarker();
  if (!marker) {
    log.debug('No deploy marker; not announcing a restart.');
    return;
  }

  const age = Date.now() - marker.at;
  if (age > DEPLOY_MARKER_TTL_MS) {
    log.warn(
      `Ignoring a stale deploy marker (${Math.round(age / 60_000)} min old, previous pid ${marker.pid}); ` +
      'not announcing a restart.'
    );
    clearMarker();
    return;
  }

  const sent = await sendToChannel(client, DEPLOY_AWAKE_MESSAGE);
  if (!sent) {
    log.warn('The awake announcement was not posted; the marker is kept for the next restart.');
    return;
  }

  clearMarker();
  log.info(
    `Posted the deployment awake announcement (previous pid ${marker.pid}, ` +
    `down for ${Math.round(age / 1000)}s).`
  );
}
