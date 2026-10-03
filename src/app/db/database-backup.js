import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createNodeSqlStorage } from './node-sql-storage.js';
import { resolveDataDir } from './open-database.js';

export const DEFAULT_BACKUP_RETENTION = 10;
export const BACKUP_DIRECTORY_NAME = 'backups';

const MAX_BACKUP_RETENTION = 1_000;
const BACKUP_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BACKUP_FILE_PATTERN = /^content-radar-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]+(?:-[a-z0-9]+)*\.db$/;
// Migration ledgers describe schema shape rather than user data, so on their
// own they do not make a database worth backing up.
const SCHEMA_BOOKKEEPING_TABLES = new Set([
  'app_schema_migrations',
  'news_schema_migrations',
  'delivery_schema',
]);

/**
 * @param {number} keep
 * @returns {number}
 */
export function assertBackupRetention(keep) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_BACKUP_RETENTION) {
    throw new TypeError(`Backup retention must be an integer between 1 and ${MAX_BACKUP_RETENTION}`);
  }
  return keep;
}

/**
 * True when any user table other than the schema ledgers holds at least one row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function databaseHasUserData(db) {
  const { sql } = createNodeSqlStorage(db);
  const tables = sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  ).toArray();
  return tables.some(({ name }) => !SCHEMA_BOOKKEEPING_TABLES.has(name)
    && sql.exec(`SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1`).toArray().length > 0);
}

/**
 * Write a consistent snapshot of `db` with `VACUUM INTO` to
 * `${dataDir}/backups/content-radar-<UTC timestamp>-<label>.db`, flush it to
 * disk, then keep only the newest `keep` backups. Must run outside a
 * transaction. A failed backup throws and leaves no partial file behind;
 * failing to prune older backups only logs a warning.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dataDir: string,
 *   label: string,
 *   now?: Date,
 *   keep?: number,
 * }} options
 * @returns {string} Absolute path of the new backup.
 */
export function createDatabaseBackup({ db, dataDir, label, now = new Date(), keep = DEFAULT_BACKUP_RETENTION }) {
  const { sql } = createNodeSqlStorage(db);
  const directory = join(resolveDataDir(dataDir), BACKUP_DIRECTORY_NAME);
  if (typeof label !== 'string' || label.length > 64 || !BACKUP_LABEL_PATTERN.test(label)) {
    throw new TypeError('Backup label must be lowercase letters, digits, and single hyphens');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Backup time must be a valid Date');
  }
  assertBackupRetention(keep);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `content-radar-${timestamp}-${label}.db`);
  // VACUUM INTO accepts an existing empty file, which lets the backup start
  // owner-only and never overwrite an earlier one.
  closeSync(openSync(path, 'wx', 0o600));
  try {
    sql.exec('VACUUM INTO ?', path);
    // SQLite does not fsync VACUUM INTO output.
    const descriptor = openSync(path, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Report why the backup failed rather than why its cleanup failed.
    }
    throw error;
  }
  pruneBackups(directory, keep);
  return path;
}

function pruneBackups(directory, keep) {
  try {
    const names = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse();
    for (const name of names.slice(keep)) rmSync(join(directory, name), { force: true });
  } catch (error) {
    // Pruning is housekeeping: it must not block the migration the fresh backup
    // protects, but the operator should know old backups are accumulating.
    console.warn('[DB] Failed to prune old database backups', { code: error?.code ?? 'unknown' });
  }
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
