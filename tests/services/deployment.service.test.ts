import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'discord.js';
import {
  announceBackUp,
  announceGoingDown,
  DEPLOY_AWAKE_MESSAGE,
  DEPLOY_MARKER_TTL_MS,
  DEPLOY_SLEEP_MESSAGE,
  deploymentMarkerPath,
} from '../../src/services/deployment.service';

/**
 * The deploy announcements have two halves that only make sense together: the
 * shutdown writes a marker and says goodbye, the next startup reads the marker
 * and says hello. These tests cover the cases where that hand-off must stay
 * quiet or retry — a crash (no marker), a stale marker (deploy never finished),
 * a corrupt marker, and a Discord send that fails at either end.
 *
 * The channel is faked rather than mocked with discord.js types: the service
 * only uses fetch().isSendable().send(), so a small object proves the contract
 * without booting a client or holding a token.
 */

interface FakeClientOptions {
  sendable?: boolean;
  fetchThrows?: boolean;
  sendThrows?: boolean;
}

function fakeClient(options: FakeClientOptions = {}): { client: Client; sent: string[] } {
  const sent: string[] = [];
  const channel = {
    isSendable: () => options.sendable ?? true,
    send: async (content: string) => {
      if (options.sendThrows) throw new Error('send failed');
      sent.push(content);
      return {};
    },
  };
  const client = {
    channels: {
      fetch: async () => {
        if (options.fetchThrows) throw new Error('fetch failed');
        return channel;
      },
    },
  } as unknown as Client;
  return { client, sent };
}

/** Simulates the marker a previous process would have left behind. */
function writeMarkerAt(at: number): void {
  fs.mkdirSync(path.dirname(deploymentMarkerPath()), { recursive: true });
  fs.writeFileSync(deploymentMarkerPath(), JSON.stringify({ at, pid: 4242 }));
}

const originalNodeEnv = process.env.NODE_ENV;
const originalDataDir = process.env.KEVBOT_DATA_DIR;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kevbot-deploy-'));
  process.env.KEVBOT_DATA_DIR = tmpDir;
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDataDir === undefined) delete process.env.KEVBOT_DATA_DIR;
  else process.env.KEVBOT_DATA_DIR = originalDataDir;
});

describe('deployment announcements', () => {
  it('keeps the marker in the configured data directory', () => {
    expect(deploymentMarkerPath()).toBe(path.join(tmpDir, 'deploy-pending.json'));
  });

  it('posts the sleep message and leaves a marker on shutdown', async () => {
    const { client, sent } = fakeClient();

    await announceGoingDown(client);

    expect(sent).toEqual([DEPLOY_SLEEP_MESSAGE]);
    const marker = JSON.parse(fs.readFileSync(deploymentMarkerPath(), 'utf8'));
    expect(marker.pid).toBe(process.pid);
    expect(typeof marker.at).toBe('number');
  });

  it('posts the awake message and clears a fresh marker on startup', async () => {
    writeMarkerAt(Date.now());
    const { client, sent } = fakeClient();

    await announceBackUp(client);

    expect(sent).toEqual([DEPLOY_AWAKE_MESSAGE]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(false);
  });

  it('stays quiet on a startup with no marker (a crash restart)', async () => {
    const { client, sent } = fakeClient();

    await announceBackUp(client);

    expect(sent).toEqual([]);
  });

  it('ignores and clears a stale marker', async () => {
    writeMarkerAt(Date.now() - DEPLOY_MARKER_TTL_MS - 1_000);
    const { client, sent } = fakeClient();

    await announceBackUp(client);

    expect(sent).toEqual([]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(false);
  });

  it('clears a malformed marker instead of failing every future start', async () => {
    fs.writeFileSync(deploymentMarkerPath(), 'not json');
    const { client, sent } = fakeClient();

    await expect(announceBackUp(client)).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(false);
  });

  it('stays quiet when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'development';
    const { client, sent } = fakeClient();

    await announceGoingDown(client);
    writeMarkerAt(Date.now());
    await announceBackUp(client);

    expect(sent).toEqual([]);
  });

  it('keeps the marker when the sleep message cannot be posted', async () => {
    const failing = fakeClient({ fetchThrows: true });

    await announceGoingDown(failing.client);

    expect(failing.sent).toEqual([]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(true);

    // The retry on the next startup still announces, because the stop was
    // still a deploy even though Discord was unreachable at the time.
    const healthy = fakeClient();
    await announceBackUp(healthy.client);
    expect(healthy.sent).toEqual([DEPLOY_AWAKE_MESSAGE]);
  });

  it('keeps the marker when the awake message cannot be posted', async () => {
    writeMarkerAt(Date.now());
    const { client, sent } = fakeClient({ sendThrows: true });

    await announceBackUp(client);

    expect(sent).toEqual([]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(true);
  });

  it('does not post into a channel that is not sendable', async () => {
    writeMarkerAt(Date.now());
    const { client, sent } = fakeClient({ sendable: false });

    await announceBackUp(client);

    expect(sent).toEqual([]);
    expect(fs.existsSync(deploymentMarkerPath())).toBe(true);
  });
});
