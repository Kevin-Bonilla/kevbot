import fs from 'fs';
import path from 'path';

/**
 * Reads and increments a persistent counter.
 *
 * The data directory is overridable (KEVBOT_DATA_DIR) for the same reason as
 * in purge-users.service.ts: tests must be able to point at a temp dir instead
 * of the real data/counter.json, which is tracked in git and shared with the
 * running bot. The path is resolved per call rather than at import time so a
 * test can set the env var in beforeEach and get a clean slate per case.
 */
const counterPath = (): string =>
  path.join(
    process.env.KEVBOT_DATA_DIR
      ? path.resolve(process.env.KEVBOT_DATA_DIR)
      : path.resolve(__dirname, '../../data'),
    'counter.json'
  );

export class CounterService {
  private static read(): { count: number } {
    return JSON.parse(fs.readFileSync(counterPath(), 'utf8'));
  }

  /**
   * Retrieves the current value of the counter.
   * @returns {number} The current counter value.
   */
  static getCount() {
    return this.read().count;
  }

  /**
   * Increments the counter value and persists the change to the JSON file.
   * Reads fresh on every call rather than caching in a static: a cached copy
   * goes stale the moment anything else writes the file (a second process, a
   * manual edit, a previous run), and a stale increment silently loses writes.
   *
   * @returns {number} The newly incremented counter value.
   */
  static increment() {
    const data = this.read();
    data.count++;
    fs.writeFileSync(counterPath(), JSON.stringify(data, null, 2));
    return data.count;
  }
}
