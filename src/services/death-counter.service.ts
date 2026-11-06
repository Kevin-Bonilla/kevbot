import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Persistent per-character death counters, backed by SQLite.
 *
 * Why SQLite instead of another JSON file: the old oopsie counter (see
 * counter.service.ts) is a single number, but death counters are a growing set
 * of rows that need case-insensitive lookups, an ordered leaderboard, and an
 * increment that cannot lose a write. Those are one-line SQL statements; in
 * JSON they are hand-rolled read-modify-write code.
 *
 * The database uses Node's built-in `node:sqlite` (unflagged since Node
 * 22.13, still marked experimental) so there is no native module to compile in
 * the alpine image and no database server to run on the OCI VM. One file,
 * `data/kevbot.db`, lives on the same volume as the rest of the bot's state.
 *
 * The data directory is overridable (KEVBOT_DATA_DIR) for the same reason as
 * in counter.service.ts: tests must be able to point at a temp dir instead of
 * the real data/kevbot.db that the running bot writes. The path is resolved per
 * call rather than at import time so a test can set the env var in beforeEach
 * and get a clean database per case.
 */

/** Discord string options max out at this, so the service enforces it too. */
export const MAX_NAME_LENGTH = 32;

export interface DeathCounter {
  name: string;
  deaths: number;
}

interface DeathCounterRow {
  name: string;
  deaths: number;
}

const dbPath = (): string =>
  path.join(
    process.env.KEVBOT_DATA_DIR
      ? path.resolve(process.env.KEVBOT_DATA_DIR)
      : path.resolve(__dirname, '../../data'),
    'kevbot.db'
  );

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS death_counters (
    key        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    deaths     INTEGER NOT NULL CHECK (deaths >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// One connection, reopened when KEVBOT_DATA_DIR changes (tests do this per
// case). Opening per call would also work, but this keeps the schema check to
// once per database and avoids an open/close on every leaderboard refresh.
let db: DatabaseSync | null = null;
let openPath: string | null = null;

function getDb(): DatabaseSync {
  const file = dbPath();
  if (db?.isOpen && openPath === file) return db;

  closeDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const opened = new DatabaseSync(file);
  try {
    opened.exec(SCHEMA);
  } catch (err) {
    // Never cache a connection whose schema was not established.
    opened.close();
    throw err;
  }
  db = opened;
  openPath = file;
  return db;
}

function closeDb(): void {
  if (!db) return;
  try {
    if (db.isOpen) db.close();
  } catch {
    // Already closed (or a close that failed); the next getDb() reopens.
  }
  db = null;
  openPath = null;
}

/**
 * Normalizes a character name into its storage key and display form.
 *
 * WoW character names are case-insensitive, and friends will type "matthew",
 * "Matthew", or " Matthew " for the same person. The key collapses all of
 * those onto one row; the display name keeps the casing from the most recent
 * call, which is what the replies show.
 *
 * @throws if the name is empty or longer than MAX_NAME_LENGTH.
 */
export function normalizeName(raw: string): { key: string; name: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) {
    throw new Error('A character name is required.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Character names must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return { key: name.toLowerCase(), name };
}

export class DeathCounterService {
  /**
   * Records one death, creating the character on first use.
   *
   * The whole operation is a single UPSERT with RETURNING: SQLite applies it
   * atomically, so two quick `/died` calls cannot lose an increment the way a
   * read-modify-write JSON file can.
   *
   * @returns the character's display name and new death total.
   */
  static increment(rawName: string): DeathCounter {
    const { key, name } = normalizeName(rawName);
    const now = new Date().toISOString();
    const row = getDb()
      .prepare(
        `INSERT INTO death_counters (key, name, deaths, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           deaths = death_counters.deaths + 1,
           updated_at = excluded.updated_at
         RETURNING name, deaths`
      )
      .get(key, name, now, now) as DeathCounterRow | undefined;

    // RETURNING on an INSERT ... ON CONFLICT always produces one row.
    if (!row) throw new Error(`Failed to record a death for ${name}.`);
    return row;
  }

  /**
   * Looks up one character. Returns null for a name that was never recorded;
   * unlike increment(), a lookup must not create a zero-death row.
   */
  static get(rawName: string): DeathCounter | null {
    const { key } = normalizeName(rawName);
    const row = getDb()
      .prepare('SELECT name, deaths FROM death_counters WHERE key = ?')
      .get(key) as DeathCounterRow | undefined;
    return row ?? null;
  }

  /**
   * Every tracked character, most deaths first. Ties break on name so the
   * leaderboard order is stable between calls instead of SQLite's whim.
   */
  static list(): DeathCounter[] {
    return getDb()
      .prepare(
        `SELECT name, deaths
         FROM death_counters
         ORDER BY deaths DESC, name COLLATE NOCASE ASC`
      )
      .all() as unknown as DeathCounter[];
  }

  /** Releases the SQLite handle (tests and clean shutdown). */
  static close(): void {
    closeDb();
  }
}
