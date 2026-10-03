import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATABASE_FILE_NAME = 'content-radar.db';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;

/**
 * Resolve the absolute data directory, rejecting empty or non-string paths.
 * @param {string} dataDir
 * @returns {string}
 */
export function resolveDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('A data directory path is required');
  }
  return resolve(dataDir);
}

/**
 * @param {string} dataDir
 * @returns {string} Absolute path of the app database inside `dataDir`.
 */
export function resolveDatabasePath(dataDir) {
  return join(resolveDataDir(dataDir), DATABASE_FILE_NAME);
}

/**
 * Open (creating if needed) `${dataDir}/content-radar.db` with WAL journaling,
 * foreign keys, a busy timeout, and `synchronous=NORMAL`. The data directory is
 * created owner-only and a new database file is created readable by its owner
 * only; SQLite gives its WAL and shared-memory files the same permissions.
 *
 * @param {{ dataDir: string, busyTimeoutMs?: number }} options
 * @returns {DatabaseSync}
 */
export function openDatabase({ dataDir, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  const directory = resolveDataDir(dataDir);
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(`busyTimeoutMs must be an integer between 0 and ${MAX_BUSY_TIMEOUT_MS}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, DATABASE_FILE_NAME);
  createPrivateFileIfMissing(path);

  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const journalMode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (String(journalMode).toLowerCase() !== 'wal') {
      throw new Error(`SQLite could not enable WAL journaling (journal_mode=${journalMode})`);
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Open a private, throwaway in-memory database.
 * @returns {DatabaseSync}
 */
export function openMemoryDatabase() {
  return new DatabaseSync(':memory:');
}

/**
 * Close a connection opened by `openDatabase`. Safe to call more than once and
 * with `null`/`undefined`, so shutdown paths can call it unconditionally.
 * Closing the last connection lets SQLite checkpoint and remove the WAL file.
 *
 * @param {DatabaseSync | null | undefined} db
 */
export function closeDatabase(db) {
  if (db === null || db === undefined) return;
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError('closeDatabase requires a node:sqlite DatabaseSync connection');
  }
  try {
    db.close();
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_STATE') throw error;
  }
}

function createPrivateFileIfMissing(path) {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}
