import test from 'node:test';
import assert from 'node:assert/strict';

import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { closeDatabase } from '../../src/app/db/open-database.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { SQLiteDeliveryStore } from '../../src/core/sqlite-delivery-store.js';
import { RecordingOutput } from '../helpers/fakes.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

async function openStore(workspace) {
  const db = workspace.open();
  const storage = createNodeSqlStorage(db);
  const store = new SQLiteDeliveryStore(storage);
  await store.initialize();
  return { db, sql: storage.sql, store };
}

async function reopenStore(workspace, previous) {
  closeDatabase(previous.db);
  return openStore(workspace);
}

function rows(sql, query, ...bindings) {
  return sql.exec(query, ...bindings).toArray();
}

function plan(sql, query, ...bindings) {
  return rows(sql, `EXPLAIN QUERY PLAN ${query}`, ...bindings).map(row => row.detail).join('\n');
}

test('initializes the v6 normalized schema and enforces compare-and-set versions', async t => {
  const workspace = await createTempDataDir(t);
  const { sql, store } = await openStore(workspace);

  assert.deepEqual(
    rows(sql, 'SELECT schema_value FROM delivery_schema WHERE schema_key = ?', 'schema_version'),
    [{ schema_value: '6' }],
  );
  assert.deepEqual(rows(sql, `
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('requests', 'deliveries', 'attempts', 'delivery_outputs')
    ORDER BY name
  `).map(row => row.name), ['attempts', 'deliveries', 'delivery_outputs', 'requests']);
  assert.deepEqual(rows(sql, 'SELECT version, name FROM news_schema_migrations ORDER BY version'), [
    { version: 1, name: 'generic-record-store' },
    { version: 2, name: 'materialized-query-metadata' },
    { version: 3, name: 'normalized-domain-tables' },
    { version: 4, name: 'indexed-retention-tombstones' },
    { version: 5, name: 'bounded-status-query-indexes' },
    { version: 6, name: 'coordinator-hot-query-indexes' },
  ]);

  const created = await store.transact(tx => tx.put('test_records', 'record-1', {
    value: 'created',
    channelId: 'channel-a',
    state: 'accepted',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  assert.equal(created.version, 1);

  const updated = await store.transact(tx => tx.put('test_records', 'record-1', {
    ...created,
    value: 'updated',
    channelId: 'channel-b',
    state: 'completed',
  }, { expectedVersion: created.version }));
  assert.equal(updated.value, 'updated');
  assert.equal(updated.version, 2);

  await assert.rejects(store.transact(tx => tx.put('test_records', 'record-1', {
    ...updated,
    value: 'stale-write',
  }, { expectedVersion: 1 })), /version conflict/i);
  await assert.rejects(store.transact(tx => tx.delete('test_records', 'record-1', {
    expectedVersion: 1,
  })), /version conflict/i);

  const stored = await store.get('test_records', 'record-1');
  assert.equal(stored.value, 'updated');
  assert.equal(stored.version, 2);
  const metadataQuery = `
    SELECT channel_id, state, created_at
    FROM delivery_records
    WHERE table_name = ? AND record_id = ?
  `;
  assert.deepEqual(rows(sql, metadataQuery, 'test_records', 'record-1'), [{
    channel_id: 'channel-b',
    state: 'completed',
    created_at: '2026-07-20T00:00:00.000Z',
  }]);

  const cleared = await store.transact(tx => tx.put('test_records', 'record-1', {
    value: 'metadata-cleared',
  }, { expectedVersion: updated.version }));
  assert.equal(cleared.version, 3);
  assert.deepEqual(rows(sql, metadataQuery, 'test_records', 'record-1'), [{
    channel_id: null,
    state: null,
    created_at: null,
  }]);

  await store.transact(tx => tx.delete('test_records', 'record-1', { expectedVersion: 3 }));
  assert.equal(await store.get('test_records', 'record-1'), null);
});

test('rolls back every write when a transaction throws', async t => {
  const workspace = await createTempDataDir(t);
  const { store } = await openStore(workspace);

  await assert.rejects(store.transact(tx => {
    tx.put('test_records', 'first', { value: 1 }, { expectedVersion: 0 });
    tx.put('test_records', 'second', { value: 2 }, { expectedVersion: 0 });
    throw new Error('abort the transaction');
  }), /abort the transaction/);

  assert.deepEqual(await store.list('test_records'), []);
  assert.deepEqual(await store.list('requests'), []);
  await assert.rejects(
    store.transact(() => Promise.resolve('async work')),
    /must be synchronous/,
  );
});

test('persists records and replays schema initialization after the database file is reopened', async t => {
  const workspace = await createTempDataDir(t);
  const first = await openStore(workspace);
  await first.store.transact(tx => {
    tx.put('test_records', 'durable', { value: 'survives' }, { expectedVersion: 0 });
    tx.put('requests', 'durable-request', {
      requestId: 'durable-request',
      channelId: 'channel-a',
      state: 'accepted',
      createdAt: '2026-07-20T00:00:00.000Z',
    }, { expectedVersion: 0 });
  });

  const reopened = await reopenStore(workspace, first);
  const durable = await reopened.store.get('test_records', 'durable');
  assert.equal(durable.value, 'survives');
  assert.equal(durable.version, 1);
  assert.equal(await reopened.store.count('requests', { channelId: 'channel-a', state: 'accepted' }), 1);
  assert.deepEqual(
    rows(reopened.sql, 'SELECT schema_value FROM delivery_schema WHERE schema_key = ?', 'schema_version'),
    [{ schema_value: '6' }],
  );
  assert.equal(rows(reopened.sql, 'SELECT version FROM news_schema_migrations').length, 6);
});

test('upgrades v5 coordinator indexes and paused-maintenance metadata idempotently', async t => {
  const workspace = await createTempDataDir(t);
  const pausedRecord = {
    outboxId: 'paused-outbox',
    channelId: 'channel-a',
    state: 'retry_pending',
    pauseOverrideActionId: 'operator-action-1',
    createdAt: '2026-07-20T00:00:00.000Z',
    version: 1,
  };

  const initial = await openStore(workspace);
  const { sql } = initial;
  sql.exec(`
    INSERT INTO maintenance_outbox(
      record_id, record_json, version, updated_at,
      channel_id, state, created_at, pause_override_action_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  pausedRecord.outboxId,
  JSON.stringify(pausedRecord),
  pausedRecord.version,
  pausedRecord.createdAt,
  pausedRecord.channelId,
  pausedRecord.state,
  pausedRecord.createdAt,
  pausedRecord.pauseOverrideActionId);
  sql.exec(`
    DROP INDEX IF EXISTS day_batches_channel_created_record;
    DROP INDEX IF EXISTS batch_items_batch_created_record;
    DROP INDEX IF EXISTS requests_channel_state_deadline_record;
    DROP INDEX IF EXISTS deliveries_channel_state_record;
    DROP INDEX IF EXISTS maintenance_outbox_channel_state_record;
    DROP INDEX IF EXISTS maintenance_outbox_channel_state_deadline_record;
    DROP INDEX IF EXISTS maintenance_outbox_paused_override_record;
    ALTER TABLE maintenance_outbox DROP COLUMN pause_override_action_id;
    ALTER TABLE delivery_records DROP COLUMN pause_override_action_id;
    DELETE FROM news_schema_migrations WHERE version = 6;
  `);
  sql.exec('DELETE FROM delivery_schema WHERE schema_key = ?', 'pause_override_metadata_version');
  sql.exec(
    'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
    'record_metadata_version',
    '3',
  );
  sql.exec(
    'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
    'schema_version',
    '5',
  );

  let current = initial;
  for (let replay = 0; replay < 2; replay += 1) {
    current = await reopenStore(workspace, current);
    assert.deepEqual(
      rows(current.sql, 'SELECT schema_value FROM delivery_schema WHERE schema_key = ?', 'schema_version'),
      [{ schema_value: '6' }],
    );
    assert.deepEqual(rows(current.sql, 'SELECT version, name FROM news_schema_migrations WHERE version = 6'), [{
      version: 6,
      name: 'coordinator-hot-query-indexes',
    }]);
    assert.deepEqual(rows(current.sql, `
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'day_batches_channel_created_record',
          'batch_items_batch_created_record',
          'requests_channel_state_deadline_record',
          'deliveries_channel_state_record',
          'maintenance_outbox_channel_state_record',
          'maintenance_outbox_channel_state_deadline_record',
          'maintenance_outbox_paused_override_record'
        )
      ORDER BY name
    `).map(row => row.name), [
      'batch_items_batch_created_record',
      'day_batches_channel_created_record',
      'deliveries_channel_state_record',
      'maintenance_outbox_channel_state_deadline_record',
      'maintenance_outbox_channel_state_record',
      'maintenance_outbox_paused_override_record',
      'requests_channel_state_deadline_record',
    ]);
    assert.deepEqual(
      rows(current.sql, 'SELECT pause_override_action_id FROM maintenance_outbox WHERE record_id = ?', pausedRecord.outboxId),
      [{ pause_override_action_id: pausedRecord.pauseOverrideActionId }],
    );
    assert.deepEqual(await current.store.findPausedMaintenance(pausedRecord.channelId), pausedRecord);
    const pausedPlan = plan(current.sql, `
      SELECT record_json, version
      FROM maintenance_outbox INDEXED BY maintenance_outbox_paused_override_record
      WHERE channel_id = ?
        AND state = ?
        AND pause_override_action_id IS NOT NULL
      ORDER BY next_attempt_at ASC, deadline_at ASC, record_id ASC
      LIMIT 1
    `, pausedRecord.channelId, pausedRecord.state);
    assert.match(pausedPlan, /SEARCH maintenance_outbox USING INDEX maintenance_outbox_paused_override_record \(channel_id=\? AND state=\?\)/);
    assert.doesNotMatch(pausedPlan, /SCAN maintenance_outbox|USE TEMP B-TREE/);
  }
});

test('migrates and backfills legacy generic records into domain tables idempotently across reopen', async t => {
  const workspace = await createTempDataDir(t);
  const legacyRecord = {
    channelId: 'legacy-channel',
    state: 'running',
    triggerType: 'manual',
    requestId: 'legacy-request',
    deliveryId: 'legacy-delivery',
    batchId: 'legacy-batch',
    publishingDay: '2026-07-19',
    outputKey: 'telegram:legacy',
    deadlineAt: '2026-07-20T00:05:00.000Z',
    nextAttemptAt: '2026-07-20T00:10:00.000Z',
    createdAt: '2026-07-20T00:00:00.000Z',
    pauseOverrideActionId: 'legacy-override-action',
    untouched: { nested: true },
    version: 7,
  };

  const initial = await openStore(workspace);
  initial.sql.exec(`
    DROP TABLE delivery_records;
    CREATE TABLE delivery_records (
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (table_name, record_id)
    );
  `);
  initial.sql.exec(
    `INSERT INTO delivery_records(
      table_name, record_id, record_json, version, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
    'requests',
    'legacy-record',
    JSON.stringify(legacyRecord),
    legacyRecord.version,
    '2026-07-20T00:01:00.000Z',
  );
  initial.sql.exec('DELETE FROM delivery_schema WHERE schema_key = ?', 'record_metadata_version');
  initial.sql.exec(
    'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
    'schema_version',
    '2',
  );

  const upgraded = await reopenStore(workspace, initial);
  const columns = rows(upgraded.sql, 'PRAGMA table_info(delivery_records)').map(row => row.name);
  for (const column of [
    'channel_id', 'state', 'trigger_type', 'request_id', 'delivery_id', 'batch_id',
    'publishing_day', 'output_key', 'deadline_at', 'next_attempt_at', 'created_at',
    'retention_status', 'pause_override_action_id',
  ]) {
    assert.ok(columns.includes(column), `delivery_records.${column} was not restored`);
  }
  assert.deepEqual(rows(upgraded.sql, `
    SELECT
      channel_id, state, trigger_type, request_id, delivery_id, batch_id,
      publishing_day, output_key, deadline_at, next_attempt_at, created_at,
      pause_override_action_id
    FROM requests
    WHERE record_id = ?
  `, 'legacy-record'), [{
    channel_id: legacyRecord.channelId,
    state: legacyRecord.state,
    trigger_type: legacyRecord.triggerType,
    request_id: legacyRecord.requestId,
    delivery_id: legacyRecord.deliveryId,
    batch_id: legacyRecord.batchId,
    publishing_day: legacyRecord.publishingDay,
    output_key: legacyRecord.outputKey,
    deadline_at: legacyRecord.deadlineAt,
    next_attempt_at: legacyRecord.nextAttemptAt,
    created_at: legacyRecord.createdAt,
    pause_override_action_id: legacyRecord.pauseOverrideActionId,
  }]);
  assert.deepEqual(await upgraded.store.get('requests', 'legacy-record'), legacyRecord);
  assert.deepEqual(await upgraded.store.query('requests', {
    channelId: legacyRecord.channelId,
    state: legacyRecord.state,
  }), [legacyRecord]);
  assert.deepEqual(rows(upgraded.sql, `
    SELECT record_id FROM delivery_records
    WHERE table_name = ? AND record_id = ?
  `, 'requests', 'legacy-record'), []);

  const replayed = await reopenStore(workspace, upgraded);
  assert.deepEqual(await replayed.store.get('requests', 'legacy-record'), legacyRecord);
  assert.deepEqual(
    rows(replayed.sql, 'SELECT schema_value FROM delivery_schema WHERE schema_key = ?', 'record_metadata_version'),
    [{ schema_value: '4' }],
  );
  assert.equal(
    rows(replayed.sql, 'PRAGMA table_info(delivery_records)').filter(row => row.name === 'channel_id').length,
    1,
  );
});

test('queries exact metadata with bounded state arrays, ordering, and transaction parity', async t => {
  const workspace = await createTempDataDir(t);
  const { sql, store } = await openStore(workspace);

  await store.transact(tx => {
    tx.put('requests', 'accepted-old', {
      requestId: 'accepted-old',
      channelId: 'channel-a',
      state: 'accepted',
      triggerType: 'scheduled',
      deliveryId: 'delivery-a',
      batchId: 'batch-a',
      publishingDay: '2026-07-20',
      outputKey: 'telegram:a',
      deadlineAt: '2026-07-20T00:10:00.000Z',
      nextAttemptAt: null,
      createdAt: '2026-07-20T00:00:00.000Z',
    }, { expectedVersion: 0 });
    tx.put('requests', 'running-new', {
      requestId: 'running-new',
      channelId: 'channel-a',
      state: 'running',
      triggerType: 'manual',
      deliveryId: 'delivery-b',
      batchId: 'batch-a',
      publishingDay: '2026-07-20',
      outputKey: 'telegram:b',
      deadlineAt: '2026-07-20T00:20:00.000Z',
      nextAttemptAt: '2026-07-20T00:30:00.000Z',
      createdAt: '2026-07-20T00:02:00.000Z',
    }, { expectedVersion: 0 });
    tx.put('requests', 'other-channel', {
      requestId: 'other-channel',
      channelId: 'channel-b',
      state: 'accepted',
      triggerType: 'manual',
      deliveryId: 'delivery-c',
      batchId: 'batch-b',
      publishingDay: '2026-07-20',
      outputKey: 'telegram:c',
      deadlineAt: '2026-07-20T00:30:00.000Z',
      nextAttemptAt: null,
      createdAt: '2026-07-20T00:03:00.000Z',
      retentionStatus: 'compacted',
    }, { expectedVersion: 0 });
  });

  const active = await store.query('requests', {
    channelId: 'channel-a',
    state: ['accepted', 'running'],
  }, { orderBy: 'createdAt', direction: 'desc', limit: 2 });
  assert.deepEqual(active.map(record => record.requestId), ['running-new', 'accepted-old']);
  assert.match(plan(sql, `
    SELECT record_json, version
    FROM requests
    WHERE channel_id = ? AND state = ?
    ORDER BY created_at DESC, record_id DESC
    LIMIT ?
  `, 'channel-a', 'accepted', 10), /requests_hot_[0-9]+/);

  const exact = await store.transact(tx => tx.query('requests', {
    channelId: 'channel-a',
    state: 'running',
    triggerType: 'manual',
    requestId: 'running-new',
    deliveryId: 'delivery-b',
    batchId: 'batch-a',
    publishingDay: '2026-07-20',
    outputKey: 'telegram:b',
    deadlineAt: '2026-07-20T00:20:00.000Z',
    nextAttemptAt: '2026-07-20T00:30:00.000Z',
    createdAt: '2026-07-20T00:02:00.000Z',
  }, { limit: 1 }));
  assert.deepEqual(exact.map(record => record.requestId), ['running-new']);
  assert.equal(await store.count('requests', { channelId: 'channel-a' }), 2);
  assert.equal(await store.transact(tx => tx.count('requests', {
    channelId: 'channel-a', state: ['accepted', 'running'],
  })), 2);
  assert.deepEqual((await store.query('requests', { channelId: 'channel-a' }, {
    orderBy: 'createdAt', direction: 'desc', limit: 1, offset: 1,
  })).map(record => record.requestId), ['accepted-old']);

  assert.equal((await store.query('requests', { nextAttemptAt: null })).length, 2);
  assert.equal((await store.query('requests', { retentionStatus: 'compacted' }))[0].requestId, 'other-channel');
  assert.equal(await store.count('requests', { channelId: 'channel-a', retentionStatus: null }), 2);
  assert.equal(await store.count('requests', { state: [] }), 0);
  assert.deepEqual(await store.query('requests', { state: "accepted') OR 1=1 --" }), []);

  await assert.rejects(store.query('requests; DROP TABLE delivery_records', {}), /invalid.*table/i);
  await assert.rejects(store.query('requests', { unknown: 'value' }), /unsupported.*filter/i);
  await assert.rejects(store.query('requests', { deliveryId: ['delivery-a'] }), /does not accept arrays/i);
  await assert.rejects(store.query('requests', { state: Array(33).fill('accepted') }), /cannot exceed 32/i);
  await assert.rejects(store.query('requests', { deliveryId: 'x'.repeat(501) }), /invalid.*deliveryId/i);
  await assert.rejects(store.query('requests', {}, { limit: 0 }), /limit/i);
  await assert.rejects(store.query('requests', {}, { limit: 1_001 }), /limit/i);
  await assert.rejects(store.query('requests', {}, { offset: -1 }), /offset/i);
  await assert.rejects(store.query('requests', {}, { offset: 1_000_001 }), /offset/i);
  await assert.rejects(
    store.query('requests', {}, { orderBy: 'createdAt; DROP TABLE delivery_records' }),
    /unsupported.*order/i,
  );
  await assert.rejects(store.query('requests', {}, { orderBy: '__proto__' }), /unsupported.*order/i);
  await assert.rejects(store.query('requests', {}, { direction: 'sideways' }), /direction/i);
  assert.equal(await store.count('requests', {}), 3);
});

test('uses exact hot-query indexes and pages through more than 1,000 rows', async t => {
  const workspace = await createTempDataDir(t);
  const { sql, store } = await openStore(workspace);

  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1499
    )
    INSERT INTO delivery_records(
      table_name, record_id, record_json, version, updated_at,
      channel_id, state, trigger_type, delivery_id, batch_id,
      publishing_day, output_key, deadline_at, next_attempt_at, created_at
    )
    SELECT
      'query_plan_fixture',
      printf('record-%04d', value),
      '{"version":1}',
      1,
      '2026-07-20T00:00:00.000Z',
      CASE WHEN value % 2 = 0 THEN 'channel-a' ELSE 'channel-b' END,
      CASE WHEN value % 3 = 0 THEN 'accepted' ELSE 'completed' END,
      'scheduled',
      printf('delivery-%04d', value),
      printf('batch-%02d', value % 10),
      '2026-07-20',
      'telegram:fixture',
      printf('2026-07-20T00:%04d:00.000Z', value),
      printf('2026-07-20T01:%04d:00.000Z', value),
      printf('2026-07-20T00:%04d:00.000Z', value)
    FROM fixture
  `);
  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1499
    )
    INSERT INTO requests(
      record_id, record_json, version, updated_at,
      channel_id, state, created_at
    )
    SELECT
      printf('status-request-%04d', value),
      printf(
        '{"requestId":"status-request-%04d","channelId":"channel-a","state":"completed","createdAt":"status-%04d","version":1}',
        value,
        value
      ),
      1,
      '2026-07-20T00:00:00.000Z',
      'channel-a',
      'completed',
      printf('status-%04d', value)
    FROM fixture
  `);
  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1499
    )
    INSERT INTO delivery_outputs(
      record_id, record_json, version, updated_at,
      state, delivery_id, output_key
    )
    SELECT
      printf('status-output-%04d', value),
      printf(
        '{"deliveryId":"status-delivery-%04d","outputKey":"telegram:%04d","state":"%s","version":1}',
        value,
        value,
        CASE value % 3
          WHEN 0 THEN 'manual_retry_required'
          WHEN 1 THEN 'exhausted'
          ELSE 'needs_reconciliation'
        END
      ),
      1,
      '2026-07-20T00:00:00.000Z',
      CASE value % 3
        WHEN 0 THEN 'manual_retry_required'
        WHEN 1 THEN 'exhausted'
        ELSE 'needs_reconciliation'
      END,
      printf('status-delivery-%04d', value),
      printf('telegram:%04d', value)
    FROM fixture
  `);
  sql.exec('ANALYZE delivery_records; ANALYZE requests; ANALYZE delivery_outputs;');

  assert.match(plan(sql, `
    SELECT record_json, version
    FROM delivery_records
    WHERE table_name = ? AND channel_id = ? AND state = ?
    ORDER BY created_at DESC, record_id DESC
    LIMIT ?
  `, 'query_plan_fixture', 'channel-a', 'accepted', 10), /delivery_records_table_channel_state_created/);
  assert.match(plan(sql, `
    SELECT record_json, version
    FROM delivery_records
    WHERE table_name = ? AND channel_id = ? AND state = ?
    ORDER BY deadline_at ASC, record_id ASC
    LIMIT ?
  `, 'query_plan_fixture', 'channel-a', 'accepted', 10), /delivery_records_table_channel_state_deadline/);
  assert.match(plan(sql, `
    SELECT record_json, version
    FROM delivery_records
    WHERE table_name = ? AND channel_id = ? AND state = ?
    ORDER BY next_attempt_at ASC, record_id ASC
    LIMIT ?
  `, 'query_plan_fixture', 'channel-a', 'accepted', 10), /delivery_records_table_channel_state_next_attempt/);
  assert.equal((await store.query('query_plan_fixture')).length, 1_000);

  const indexedPlans = [
    [
      `SELECT record_json, version FROM requests
       WHERE 1 = 1 AND channel_id = ?
       ORDER BY created_at DESC, record_id DESC
       LIMIT ? OFFSET ?`,
      ['channel-a', 100, 0],
      /SEARCH requests USING INDEX requests_channel_created_record \(channel_id=\?\)/,
      /SCAN requests|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM day_batches
       WHERE 1 = 1 AND channel_id = ?
       ORDER BY created_at DESC, record_id DESC
       LIMIT ? OFFSET ?`,
      ['channel-a', 100, 0],
      /SEARCH day_batches USING INDEX day_batches_channel_created_record \(channel_id=\?\)/,
      /SCAN day_batches|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM batch_items
       WHERE 1 = 1 AND batch_id = ?
       ORDER BY created_at ASC, record_id ASC
       LIMIT ? OFFSET ?`,
      ['batch-a', 100, 0],
      /SEARCH batch_items USING INDEX batch_items_batch_created_record \(batch_id=\?\)/,
      /SCAN batch_items|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM requests
       WHERE channel_id = ? AND state = ? AND deadline_at <= ?
       ORDER BY deadline_at ASC, record_id ASC
       LIMIT ? OFFSET ?`,
      ['channel-a', 'accepted', '2026-07-20T00:10:00.000Z', 100, 0],
      /SEARCH requests USING INDEX requests_channel_state_deadline_record \(channel_id=\? AND state=\? AND deadline_at<\?\)/,
      /SCAN requests|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM deliveries
       WHERE 1 = 1 AND channel_id = ? AND state = ?
       ORDER BY record_id ASC
       LIMIT ? OFFSET ?`,
      ['channel-a', 'generation_exhausted', 100, 0],
      /SEARCH deliveries USING INDEX deliveries_channel_state_record \(channel_id=\? AND state=\?\)/,
      /SCAN deliveries|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM maintenance_outbox
       WHERE 1 = 1 AND channel_id = ? AND state = ?
       ORDER BY record_id ASC
       LIMIT ? OFFSET ?`,
      ['channel-a', 'dead_letter', 100, 0],
      /SEARCH maintenance_outbox USING INDEX maintenance_outbox_channel_state_record \(channel_id=\? AND state=\?\)/,
      /SCAN maintenance_outbox|USE TEMP B-TREE/,
    ],
    [
      `SELECT record_json, version FROM delivery_outputs INDEXED BY delivery_outputs_state_record
       WHERE 1 = 1 AND state IN (?, ?, ?)
       ORDER BY record_id ASC
       LIMIT ? OFFSET ?`,
      ['manual_retry_required', 'exhausted', 'needs_reconciliation', 1_000, 0],
      /SEARCH delivery_outputs USING INDEX delivery_outputs_state_record \(state=\?\)/,
      /SCAN delivery_outputs/,
    ],
    [
      `SELECT COUNT(*) AS record_count FROM delivery_outputs INDEXED BY delivery_outputs_state_record
       WHERE 1 = 1 AND state IN (?, ?, ?)`,
      ['manual_retry_required', 'exhausted', 'needs_reconciliation'],
      /SEARCH delivery_outputs USING COVERING INDEX delivery_outputs_state_record \(state=\?\)/,
      /SCAN delivery_outputs/,
    ],
  ];
  for (const [query, bindings, expected, forbidden] of indexedPlans) {
    const detail = plan(sql, query, ...bindings);
    assert.match(detail, expected);
    assert.doesNotMatch(detail, forbidden);
  }

  const unresolvedStates = ['manual_retry_required', 'exhausted', 'needs_reconciliation'];
  assert.equal(await store.count('delivery_outputs', { state: unresolvedStates }), 1_500);
  const firstOutputPage = await store.query('delivery_outputs', { state: unresolvedStates }, { limit: 1_000, offset: 0 });
  const secondOutputPage = await store.query('delivery_outputs', { state: unresolvedStates }, {
    limit: 1_000,
    offset: firstOutputPage.length,
  });
  assert.equal(firstOutputPage.length, 1_000);
  assert.equal(secondOutputPage.length, 500);
  assert.equal(new Set([...firstOutputPage, ...secondOutputPage].map(value => value.outputKey)).size, 1_500);

  assert.equal(await store.count('requests', { channelId: 'channel-a' }), 1_500);
  const firstRequestPage = await store.query('requests', { channelId: 'channel-a' }, {
    orderBy: 'createdAt', direction: 'desc', limit: 1_000, offset: 0,
  });
  const secondRequestPage = await store.query('requests', { channelId: 'channel-a' }, {
    orderBy: 'createdAt', direction: 'desc', limit: 1_000, offset: firstRequestPage.length,
  });
  assert.equal(firstRequestPage.length, 1_000);
  assert.equal(secondRequestPage.length, 500);
  assert.equal(firstRequestPage[0].requestId, 'status-request-1499');
  assert.equal(secondRequestPage[0].requestId, 'status-request-0499');
  assert.equal(new Set([...firstRequestPage, ...secondRequestPage].map(value => value.requestId)).size, 1_500);
});

test('finds earliest maintenance from bounded indexed state candidates', async t => {
  const workspace = await createTempDataDir(t);
  const { sql, store } = await openStore(workspace);

  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1204
    )
    INSERT INTO maintenance_outbox(
      record_id, record_json, version, updated_at,
      channel_id, state, next_attempt_at, created_at
    )
    SELECT
      printf('ordinary-maintenance-%04d', value),
      printf(
        '{"outboxId":"ordinary-maintenance-%04d","channelId":"channel-a","state":"pending","nextAttemptAt":"2026-07-21T00:00:00.000Z","version":1}',
        value
      ),
      1,
      '2026-07-20T00:00:00.000Z',
      'channel-a',
      'pending',
      '2026-07-21T00:00:00.000Z',
      printf('ordinary-created-%04d', value)
    FROM fixture
  `);
  const attempting = await store.transact(tx => tx.put('maintenance_outbox', 'paused-attempting', {
    outboxId: 'paused-attempting',
    channelId: 'channel-a',
    state: 'attempting',
    pauseOverrideActionId: 'operator-attempting',
    deadlineAt: '2026-07-20T00:02:00.000Z',
    nextAttemptAt: null,
    createdAt: '2026-07-20T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  const claimable = await store.transact(tx => tx.put('maintenance_outbox', 'paused-retry', {
    outboxId: 'paused-retry',
    channelId: 'channel-a',
    state: 'retry_pending',
    pauseOverrideActionId: 'operator-retry',
    deadlineAt: '2026-07-19T23:59:00.000Z',
    nextAttemptAt: '2026-07-20T00:03:00.000Z',
    createdAt: '2026-07-20T00:01:00.000Z',
  }, { expectedVersion: 0 }));
  sql.exec('ANALYZE maintenance_outbox');

  assert.deepEqual(await store.findPausedMaintenance('channel-a'), attempting);
  assert.deepEqual(await store.findPausedMaintenance('channel-a', { claimableOnly: true }), claimable);
  assert.deepEqual(await store.findMaintenance('channel-a'), attempting);
  assert.deepEqual(await store.findMaintenance('channel-a', { claimableOnly: true }), claimable);

  const due = await store.transact(tx => tx.put('maintenance_outbox', 'paused-pending-due', {
    outboxId: 'paused-pending-due',
    channelId: 'channel-a',
    state: 'pending',
    pauseOverrideActionId: 'operator-pending',
    deadlineAt: null,
    nextAttemptAt: null,
    createdAt: '2026-07-20T00:02:00.000Z',
  }, { expectedVersion: 0 }));
  assert.deepEqual(await store.findPausedMaintenance('channel-a'), due);
  assert.deepEqual(await store.findPausedMaintenance('channel-a', { claimableOnly: true }), due);
  assert.deepEqual(await store.findMaintenance('channel-a'), due);
  assert.deepEqual(await store.findMaintenance('channel-a', { claimableOnly: true }), due);
  assert.equal(await store.findPausedMaintenance('missing-channel', { claimableOnly: true }), null);
  assert.equal(await store.findMaintenance('missing-channel', { claimableOnly: true }), null);
  await assert.rejects(store.findPausedMaintenance('channel-a', { claimableOnly: 'yes' }), /claimableOnly.*boolean/i);
  await assert.rejects(store.findMaintenance('channel-a', { claimableOnly: 'yes' }), /claimableOnly.*boolean/i);

  const nextAttemptPlan = plan(sql, `
    SELECT record_json, version
    FROM maintenance_outbox INDEXED BY maintenance_outbox_hot_2
    WHERE channel_id = ? AND state = ?
    ORDER BY next_attempt_at ASC, record_id ASC
    LIMIT 1
  `, 'channel-a', 'pending');
  assert.match(nextAttemptPlan, /SEARCH maintenance_outbox USING INDEX maintenance_outbox_hot_2 \(channel_id=\? AND state=\?\)/);
  assert.doesNotMatch(nextAttemptPlan, /SCAN maintenance_outbox|USE TEMP B-TREE/);
});

test('summarizes every batch item in one indexed aggregate beyond the query page limit', async t => {
  const workspace = await createTempDataDir(t);
  const { sql, store } = await openStore(workspace);

  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1204
    )
    INSERT INTO batch_items(
      record_id, record_json, version, updated_at,
      batch_id, delivery_id, created_at
    )
    SELECT
      printf('summary-item-%04d', value),
      '{"version":1}',
      1,
      '2026-07-20T00:00:00.000Z',
      'summary-batch',
      printf('summary-delivery-%04d', value),
      printf('summary-created-%04d', value)
    FROM fixture
  `);
  sql.exec(`
    WITH RECURSIVE fixture(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM fixture WHERE value < 1199
    )
    INSERT INTO deliveries(
      record_id, record_json, version, updated_at,
      channel_id, state, created_at
    )
    SELECT
      printf('summary-delivery-%04d', value),
      '{"version":1}',
      1,
      '2026-07-20T00:00:00.000Z',
      'channel-a',
      CASE
        WHEN value < 100 THEN 'succeeded'
        WHEN value < 150 THEN 'abandoned'
        WHEN value < 1050 THEN CASE value % 6
          WHEN 0 THEN 'pending_generation'
          WHEN 1 THEN 'ready'
          WHEN 2 THEN 'generating'
          WHEN 3 THEN 'delivering'
          WHEN 4 THEN 'generation_retry_pending'
          ELSE 'partial_retryable'
        END
        ELSE 'needs_reconciliation'
      END,
      printf('summary-created-%04d', value)
    FROM fixture
  `);

  assert.deepEqual(await store.summarizeBatch('summary-batch'), { total: 1_205, remaining: 1_050, blocked: 150 });
  assert.deepEqual(await store.summarizeBatch('missing-batch'), { total: 0, remaining: 0, blocked: 0 });
  await assert.rejects(store.summarizeBatch(''), /invalid.*record id/i);
});

test('retention compaction prunes terminal delivery detail but keeps replayable operator tombstones', async t => {
  const workspace = await createTempDataDir(t);
  const opened = await openStore(workspace);
  let now = new Date('2026-07-20T00:00:00.000Z');
  const machineFor = store => new DeliveryStateMachine({
    store,
    channelId: 'telegram-main',
    clock: () => new Date(now),
    attemptTimeoutMs: 1_000,
  });
  const machine = machineFor(opened.store);

  const delivery = await machine.prepareDelivery({
    requestId: 'request-1',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [{
      id: 'article-1',
      title: 'Reliable delivery',
      url: 'https://example.com/reliable',
      content: 'content',
      source: 'Example',
    }],
    outputs: [new RecordingOutput({ key: 'telegram:one' })],
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'sensitive generated content' });
  const firstOutput = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(firstOutput.attempt.attemptId, { success: false, error: 'timeout' });
  const blockedOutput = await machine.getOutput(delivery.deliveryId, firstOutput.output.outputKey);
  const action = {
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: firstOutput.output.outputKey,
    expectedVersion: blockedOutput.version,
    idempotencyKey: 'retained-operator-retry',
    operatorId: 'ops-key-1',
    reason: 'provider confirms private target was not mutated',
    duplicateRiskAccepted: true,
    requestId: 'retained-operator-request',
  };
  const retry = await machine.reconcile(action);
  await machine.commitOutput(retry.attempt.attemptId, {
    success: true,
    messageId: 'message-after-retry',
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });
  const terminalDelivery = await machine.getDelivery(delivery.deliveryId);
  assert.equal(terminalDelivery.state, 'succeeded');

  now = new Date('2026-08-22T00:00:00.000Z');
  const firstPass = await machine.compactHistory();
  assert.equal(firstPass.status, 'compacted');
  assert.equal(firstPass.counts.deliveries, 1);
  assert.equal(await machine.getDelivery(delivery.deliveryId), null);
  assert.equal(await machine.getAttempt(retry.attempt.attemptId), null);
  assert.equal(await opened.store.count('delivery_outputs', { deliveryId: delivery.deliveryId }), 0);
  const afterDeliveryRetention = await machine.reconcile(action);
  assert.equal(afterDeliveryRetention.status, 'succeeded');
  assert.equal(afterDeliveryRetention.deliveryId, delivery.deliveryId);
  assert.equal(afterDeliveryRetention.deliveryVersion, terminalDelivery.version);
  assert.equal(afterDeliveryRetention.replayed, true);
  assert.equal((await machine.compactHistory()).reason, 'retention_interval');

  now = new Date('2026-11-22T00:00:00.000Z');
  await machine.compactHistory();
  const reopened = await reopenStore(workspace, opened);
  const compactedRequest = await reopened.store.get('requests', action.requestId);
  assert.equal(compactedRequest.compacted, true);
  assert.equal(compactedRequest.retentionStatus, 'compacted');
  assert.equal(compactedRequest.result.deliveryState, 'succeeded');
  assert.equal(JSON.stringify(compactedRequest).includes('sensitive generated content'), false);
  assert.deepEqual(rows(reopened.sql, 'SELECT retention_status FROM requests WHERE record_id = ?', action.requestId), [
    { retention_status: 'compacted' },
  ]);
  const afterRequestRetention = await machineFor(reopened.store).reconcile(action);
  assert.equal(afterRequestRetention.status, 'succeeded');
  assert.equal(afterRequestRetention.deliveryId, delivery.deliveryId);
  assert.equal(afterRequestRetention.deliveryState, 'succeeded');
  assert.equal(afterRequestRetention.deliveryVersion, terminalDelivery.version);
  assert.equal(afterRequestRetention.outputKey, firstOutput.output.outputKey);
  assert.equal(afterRequestRetention.replayed, true);
});
