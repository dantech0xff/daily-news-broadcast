import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  APP_MIGRATIONS,
  backupBeforeDeliveryStoreUpgrade,
  runAppMigrations,
} from '../../src/app/db/app-migrations.js';
import {
  BACKUP_DIRECTORY_NAME,
  DEFAULT_BACKUP_RETENTION,
  createDatabaseBackup,
  databaseHasUserData,
} from '../../src/app/db/database-backup.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import {
  DATABASE_FILE_NAME,
  closeDatabase,
  openDatabase,
  resolveDatabasePath,
} from '../../src/app/db/open-database.js';
import { SQLiteDeliveryStore } from '../../src/core/sqlite-delivery-store.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const POSIX = process.platform !== 'win32';
const MIGRATED_AT = new Date('2026-10-03T04:05:06.789Z');

const EXPECTED_COLUMNS = {
  app_settings: ['key', 'value', 'updated_at'],
  app_channels: [
    'id', 'name', 'enabled', 'platform', 'mode', 'cron', 'timezone', 'config_json',
    'not_before', 'version', 'created_at', 'updated_at', 'updated_by',
  ],
  app_credentials: [
    'id', 'label', 'kind', 'ciphertext', 'iv', 'auth_tag', 'key_fingerprint',
    'created_at', 'updated_at', 'updated_by',
  ],
  app_runs: [
    'id', 'channel_id', 'trigger_type', 'status', 'started_at', 'finished_at', 'stats_json',
    'ai_input_tokens', 'ai_output_tokens', 'outputs_total', 'outputs_succeeded',
    'outputs_failed', 'error_text',
  ],
  app_source_health: [
    'run_id', 'channel_id', 'source_id', 'source_name', 'status', 'article_count',
    'error_class', 'observed_at',
  ],
  app_content_items: [
    'id', 'channel_id', 'article_key', 'title', 'url', 'source_id', 'source_name', 'category',
    'published_at', 'first_seen_at', 'last_seen_at', 'status', 'reject_reason', 'delivery_id',
    'summary_text', 'message_id', 'delivered_at', 'run_id', 'updated_at',
  ],
  app_runtime_lease: ['name', 'owner_id', 'acquired_at', 'heartbeat_at', 'expires_at'],
};

const EXPECTED_INDEXES = {
  app_runs_channel_started: ['channel_id', 'started_at'],
  app_source_health_channel_observed: ['channel_id', 'observed_at'],
  app_source_health_source_observed: ['source_id', 'observed_at'],
  app_content_items_channel_status_seen: ['channel_id', 'status', 'last_seen_at'],
  app_content_items_channel_delivered: ['channel_id', 'delivered_at'],
  app_content_items_published: ['published_at'],
  app_content_items_source: ['source_id'],
};

const V2_MIGRATION = Object.freeze({
  version: 2,
  name: 'add-settings-note',
  sql: `
    ALTER TABLE app_settings ADD COLUMN note TEXT;
    CREATE TABLE app_v2_marker (id TEXT PRIMARY KEY);
  `,
});

function rows(db, query, ...bindings) {
  return createNodeSqlStorage(db).sql.exec(query, ...bindings).toArray();
}

function tableExists(db, name) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;
}

function ledger(db) {
  return rows(db, 'SELECT version, name, applied_at FROM app_schema_migrations ORDER BY version');
}

async function listBackups(dataDir) {
  const directory = join(dataDir, BACKUP_DIRECTORY_NAME);
  return existsSync(directory) ? (await readdir(directory)).sort() : [];
}

function insertSetting(db, key = 'theme', value = 'dark') {
  createNodeSqlStorage(db).sql.exec(
    'INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)',
    key,
    value,
    MIGRATED_AT.toISOString(),
  );
}

function backupName(label, at = MIGRATED_AT) {
  return `content-radar-${at.toISOString().replace(/[:.]/g, '-')}-${label}.db`;
}

test('openDatabase creates a private data directory and applies the connection pragmas', async t => {
  const workspace = await createTempDataDir(t);
  const dataDir = join(workspace.dataDir, 'nested', 'data');
  const db = openDatabase({ dataDir });
  try {
    assert.equal(resolveDatabasePath(dataDir), join(dataDir, DATABASE_FILE_NAME));
    assert.ok(existsSync(resolveDatabasePath(dataDir)));
    assert.deepEqual(rows(db, 'PRAGMA journal_mode'), [{ journal_mode: 'wal' }]);
    assert.deepEqual(rows(db, 'PRAGMA foreign_keys'), [{ foreign_keys: 1 }]);
    assert.deepEqual(rows(db, 'PRAGMA busy_timeout'), [{ timeout: 5_000 }]);
    assert.deepEqual(rows(db, 'PRAGMA synchronous'), [{ synchronous: 1 }]);

    createNodeSqlStorage(db).sql.exec('CREATE TABLE probe (id INTEGER)');
    if (POSIX) {
      assert.equal(statSync(dataDir).mode & 0o777, 0o700);
      assert.equal(statSync(resolveDatabasePath(dataDir)).mode & 0o777, 0o600);
      assert.equal(statSync(`${resolveDatabasePath(dataDir)}-wal`).mode & 0o777, 0o600);
    }
  } finally {
    closeDatabase(db);
  }
  assert.equal(existsSync(`${resolveDatabasePath(dataDir)}-wal`), false);

  const custom = workspace.open({ busyTimeoutMs: 250 });
  assert.deepEqual(rows(custom, 'PRAGMA busy_timeout'), [{ timeout: 250 }]);
  for (const invalid of [-1, 1.5, 60_001, '5000']) {
    assert.throws(() => openDatabase({ dataDir, busyTimeoutMs: invalid }), TypeError);
  }
  for (const invalid of [undefined, '', '   ', 42]) {
    assert.throws(() => openDatabase({ dataDir: invalid }), TypeError);
  }
});

test('closeDatabase is idempotent and accepts missing connections', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  closeDatabase(db);
  closeDatabase(db);
  closeDatabase(null);
  closeDatabase(undefined);
  assert.throws(() => closeDatabase({ close() {} }), TypeError);
  assert.throws(() => db.prepare('SELECT 1'), /not open/);
});

test('a brand-new database gets the v1 app schema and no backup', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();

  const result = runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  assert.deepEqual(result, {
    fromVersion: 0,
    toVersion: 1,
    applied: [{ version: 1, name: 'create-app-tables' }],
    backupPath: null,
  });
  assert.deepEqual(ledger(db), [{ version: 1, name: 'create-app-tables', applied_at: MIGRATED_AT.toISOString() }]);
  assert.deepEqual(await listBackups(workspace.dataDir), []);

  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    assert.deepEqual(rows(db, `PRAGMA table_info(${table})`).map(row => row.name), columns, table);
  }
  for (const [index, columns] of Object.entries(EXPECTED_INDEXES)) {
    assert.deepEqual(rows(db, `PRAGMA index_info(${index})`).map(row => row.name), columns, index);
  }
  assert.deepEqual(
    rows(db, 'PRAGMA table_info(app_source_health)').filter(row => row.pk > 0).map(row => row.name),
    ['run_id', 'source_id'],
  );
});

test('v1 columns carry the specified defaults and uniqueness rules', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  const { sql } = createNodeSqlStorage(db);
  const at = MIGRATED_AT.toISOString();

  sql.exec(`
    INSERT INTO app_channels(id, name, mode, cron, timezone, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, 'telegram-main', 'Telegram', 'drip', '*/15 * * * *', 'Asia/Ho_Chi_Minh', '{"sources":[]}', at, at);
  assert.deepEqual(
    sql.exec('SELECT enabled, platform, version, not_before, updated_by FROM app_channels').one(),
    { enabled: 1, platform: 'telegram', version: 1, not_before: null, updated_by: null },
  );

  sql.exec(`
    INSERT INTO app_source_health(run_id, channel_id, source_id, status, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `, 'run-1', 'telegram-main', 'hn', 'success', at);
  assert.equal(sql.exec('SELECT article_count FROM app_source_health').one().article_count, 0);
  assert.throws(() => sql.exec(`
    INSERT INTO app_source_health(run_id, channel_id, source_id, status, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `, 'run-1', 'telegram-main', 'hn', 'failed', at), /UNIQUE constraint failed/);

  const insertItem = id => sql.exec(`
    INSERT INTO app_content_items(id, channel_id, article_key, first_seen_at, last_seen_at, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, 'telegram-main', 'article-key-1', at, at, 'queued', at);
  insertItem('item-1');
  assert.throws(() => insertItem('item-2'), /UNIQUE constraint failed/);
  assert.throws(() => sql.exec(
    'INSERT INTO app_runs(id, channel_id, trigger_type, started_at) VALUES (?, ?, ?, ?)',
    'run-1', 'telegram-main', 'scheduled', at,
  ), /NOT NULL constraint failed: app_runs.status/);
});

test('rerunning migrations is a no-op', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  assert.deepEqual(runAppMigrations({ db, dataDir: workspace.dataDir }), {
    fromVersion: 1,
    toVersion: 1,
    applied: [],
    backupPath: null,
  });
  assert.equal(ledger(db).length, 1);
  assert.deepEqual(await listBackups(workspace.dataDir), []);
});

test('pending migrations on a database with data run after a VACUUM INTO backup of the old schema', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  const upgradeAt = new Date('2026-10-04T00:00:00.000Z');
  const result = runAppMigrations({
    db,
    dataDir: workspace.dataDir,
    migrations: [...APP_MIGRATIONS, V2_MIGRATION],
    now: upgradeAt,
  });
  const expectedBackup = join(workspace.dataDir, BACKUP_DIRECTORY_NAME, backupName('v1', upgradeAt));
  assert.deepEqual(result, {
    fromVersion: 1,
    toVersion: 2,
    applied: [{ version: 2, name: 'add-settings-note' }],
    backupPath: expectedBackup,
  });
  assert.deepEqual(ledger(db).map(row => row.version), [1, 2]);
  assert.ok(tableExists(db, 'app_v2_marker'));

  if (POSIX) assert.equal(statSync(expectedBackup).mode & 0o777, 0o600);
  const backup = new DatabaseSync(expectedBackup);
  try {
    assert.deepEqual(rows(backup, 'SELECT key, value FROM app_settings'), [{ key: 'theme', value: 'dark' }]);
    assert.deepEqual(ledger(backup).map(row => row.version), [1]);
    assert.equal(tableExists(backup, 'app_v2_marker'), false);
    assert.equal(rows(backup, 'PRAGMA table_info(app_settings)').some(row => row.name === 'note'), false);
  } finally {
    backup.close();
  }
});

test('a failing migration rolls back atomically and keeps the backup taken before it', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  const broken = {
    version: 2,
    name: 'broken-migration',
    sql: 'CREATE TABLE app_partial (id TEXT); INSERT INTO missing_table VALUES (1);',
  };
  assert.throws(
    () => runAppMigrations({ db, dataDir: workspace.dataDir, migrations: [...APP_MIGRATIONS, broken], now: MIGRATED_AT }),
    /no such table: missing_table/,
  );
  assert.equal(tableExists(db, 'app_partial'), false);
  assert.deepEqual(ledger(db).map(row => row.version), [1]);
  assert.deepEqual(await listBackups(workspace.dataDir), [backupName('v1')]);

  const retryAt = new Date('2026-10-03T05:00:00.000Z');
  const retried = runAppMigrations({
    db,
    dataDir: workspace.dataDir,
    migrations: [...APP_MIGRATIONS, V2_MIGRATION],
    now: retryAt,
  });
  assert.deepEqual(retried.applied, [{ version: 2, name: 'add-settings-note' }]);
  assert.deepEqual(await listBackups(workspace.dataDir), [backupName('v1'), backupName('v1', retryAt)]);
});

test('a failed backup aborts the migration and leaves no partial backup file', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  const backupsPath = join(workspace.dataDir, BACKUP_DIRECTORY_NAME);
  await writeFile(backupsPath, 'not a directory');
  assert.throws(() => runAppMigrations({
    db,
    dataDir: workspace.dataDir,
    migrations: [...APP_MIGRATIONS, V2_MIGRATION],
    now: MIGRATED_AT,
  }), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.deepEqual(ledger(db).map(row => row.version), [1]);
  assert.equal(tableExists(db, 'app_v2_marker'), false);
  await rm(backupsPath);

  createNodeSqlStorage(db).transactionSync(() => {
    assert.throws(
      () => createDatabaseBackup({ db, dataDir: workspace.dataDir, label: 'v1', now: MIGRATED_AT }),
      /cannot VACUUM from within a transaction/,
    );
  });
  assert.deepEqual(await listBackups(workspace.dataDir), []);
});

test('backups keep the newest files up to the retention limit and ignore unrelated files', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  const backupsDir = join(workspace.dataDir, BACKUP_DIRECTORY_NAME);
  await mkdir(join(backupsDir, 'content-radar-2020-01-01T00-00-00-000Z-v0.db'), { recursive: true });
  await writeFile(join(backupsDir, 'notes.txt'), 'operator notes');
  await writeFile(join(backupsDir, 'content-radar-manual-copy.db'), '');
  const older = Array.from({ length: DEFAULT_BACKUP_RETENTION + 1 }, (_, day) => (
    backupName('v1', new Date(Date.UTC(2026, 8, day + 1)))
  ));
  for (const name of older) await writeFile(join(backupsDir, name), '');

  const unrelated = ['content-radar-2020-01-01T00-00-00-000Z-v0.db', 'content-radar-manual-copy.db', 'notes.txt'];
  const created = createDatabaseBackup({ db, dataDir: workspace.dataDir, label: 'v1', now: MIGRATED_AT });
  assert.equal(created, join(backupsDir, backupName('v1')));
  assert.deepEqual(
    await listBackups(workspace.dataDir),
    [...older.slice(-(DEFAULT_BACKUP_RETENTION - 1)), backupName('v1'), ...unrelated].sort(),
  );

  const laterAt = new Date('2026-10-05T00:00:00.000Z');
  createDatabaseBackup({ db, dataDir: workspace.dataDir, label: 'delivery-v6', now: laterAt, keep: 2 });
  assert.deepEqual(
    await listBackups(workspace.dataDir),
    [backupName('v1'), backupName('delivery-v6', laterAt), ...unrelated].sort(),
  );

  assert.throws(() => createDatabaseBackup({ db, dataDir: workspace.dataDir, label: 'v1', now: MIGRATED_AT }), { code: 'EEXIST' });
  for (const label of ['', 'V1', 'v1/../x', '-v1', 'a'.repeat(65)]) {
    assert.throws(() => createDatabaseBackup({ db, dataDir: workspace.dataDir, label }), TypeError, label);
  }
  for (const keep of [0, 1.5, 1_001]) {
    assert.throws(() => createDatabaseBackup({ db, dataDir: workspace.dataDir, label: 'v1', keep }), TypeError);
    assert.throws(() => runAppMigrations({ db, dataDir: workspace.dataDir, keepBackups: keep }), TypeError);
  }
});

test('refuses a database migrated by a newer build without taking a backup', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);
  createNodeSqlStorage(db).sql.exec(
    'INSERT INTO app_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
    2,
    'from-the-future',
    MIGRATED_AT.toISOString(),
  );

  assert.throws(
    () => runAppMigrations({ db, dataDir: workspace.dataDir }),
    /migration v2, which this build does not know/,
  );
  assert.deepEqual(await listBackups(workspace.dataDir), []);
});

test('rejects malformed migration lists before touching the database', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  const valid = { version: 1, name: 'first', sql: 'CREATE TABLE app_first (id TEXT)' };
  for (const migrations of [
    [],
    'not-a-list',
    [{ ...valid, version: 2 }],
    [valid, { version: 3, name: 'third', sql: 'SELECT 1' }],
    [valid, { version: 2, name: 'first', sql: 'SELECT 1' }],
    [{ ...valid, name: 'Not Kebab' }],
    [{ ...valid, sql: '   ' }],
  ]) {
    assert.throws(() => runAppMigrations({ db, dataDir: workspace.dataDir, migrations }), TypeError);
  }
  assert.equal(tableExists(db, 'app_schema_migrations'), false);
  assert.throws(() => runAppMigrations({ db, dataDir: workspace.dataDir, now: new Date('invalid') }), TypeError);
  assert.throws(() => runAppMigrations({ db: {}, dataDir: workspace.dataDir }), TypeError);
  assert.throws(() => runAppMigrations({ db, dataDir: '' }), TypeError);
});

test('databaseHasUserData ignores empty tables and schema ledgers', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  assert.equal(databaseHasUserData(db), false);

  await new SQLiteDeliveryStore(createNodeSqlStorage(db)).initialize();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  assert.ok(rows(db, 'SELECT COUNT(*) AS n FROM delivery_schema')[0].n > 0);
  assert.equal(databaseHasUserData(db), false);

  insertSetting(db);
  assert.equal(databaseHasUserData(db), true);
});

test('the delivery-store guard never backs up a brand-new database', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();

  assert.deepEqual(await backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir, now: MIGRATED_AT }), {
    fromVersion: 0,
    toVersion: 6,
    upgradePending: true,
    backupPath: null,
  });
  await new SQLiteDeliveryStore(createNodeSqlStorage(db)).initialize();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  assert.deepEqual(await listBackups(workspace.dataDir), []);
});

test('the delivery-store guard backs up existing data before an older delivery schema is upgraded', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  insertSetting(db);

  const missingSchema = await backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir, now: MIGRATED_AT });
  assert.deepEqual(missingSchema, {
    fromVersion: 0,
    toVersion: 6,
    upgradePending: true,
    backupPath: join(workspace.dataDir, BACKUP_DIRECTORY_NAME, backupName('delivery-v0')),
  });

  const storage = createNodeSqlStorage(db);
  const store = new SQLiteDeliveryStore(storage);
  await store.initialize();
  await store.transact(tx => tx.put('requests', 'kept-request', {
    requestId: 'kept-request',
    channelId: 'telegram-main',
    state: 'completed',
  }, { expectedVersion: 0 }));
  assert.deepEqual(await backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir }), {
    fromVersion: 6,
    toVersion: 6,
    upgradePending: false,
    backupPath: null,
  });

  storage.sql.exec('DELETE FROM news_schema_migrations WHERE version = 6');
  const upgradeAt = new Date('2026-10-04T00:00:00.000Z');
  const olderSchema = await backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir, now: upgradeAt });
  const expectedBackup = join(workspace.dataDir, BACKUP_DIRECTORY_NAME, backupName('delivery-v5', upgradeAt));
  assert.deepEqual(olderSchema, { fromVersion: 5, toVersion: 6, upgradePending: true, backupPath: expectedBackup });
  const backup = new DatabaseSync(expectedBackup);
  try {
    assert.deepEqual(rows(backup, 'SELECT record_id FROM requests'), [{ record_id: 'kept-request' }]);
    assert.deepEqual(rows(backup, 'SELECT MAX(version) AS version FROM news_schema_migrations'), [{ version: 5 }]);
  } finally {
    backup.close();
  }

  await new SQLiteDeliveryStore(storage).initialize();
  assert.equal((await backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir })).upgradePending, false);
  assert.deepEqual(await listBackups(workspace.dataDir), [backupName('delivery-v0'), backupName('delivery-v5', upgradeAt)]);
  await assert.rejects(backupBeforeDeliveryStoreUpgrade({ db, dataDir: workspace.dataDir, keepBackups: 0 }), TypeError);
});
