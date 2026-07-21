import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

function coordinator(name) {
  return env.NEWS_COORDINATOR.getByName(name);
}

describe('SQLiteDeliveryStore in a real Durable Object', () => {
  it('initializes the v6 normalized schema and enforces compare-and-set versions', async () => {
    const stub = coordinator('sqlite-schema-and-cas');

    await runInDurableObject(stub, async (instance, state) => {
      await instance.store.initialize();
      const schemaRows = [...state.storage.sql.exec(
        'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
        'schema_version',
      )];
      expect(schemaRows).toEqual([{ schema_value: '6' }]);
      const domainTables = [...state.storage.sql.exec(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('requests', 'deliveries', 'attempts', 'delivery_outputs')
        ORDER BY name
      `)].map(row => row.name);
      expect(domainTables).toEqual(['attempts', 'deliveries', 'delivery_outputs', 'requests']);
      const migrations = [...state.storage.sql.exec(`
        SELECT version, name FROM news_schema_migrations ORDER BY version
      `)];
      expect(migrations).toEqual([
        { version: 1, name: 'generic-record-store' },
        { version: 2, name: 'materialized-query-metadata' },
        { version: 3, name: 'normalized-domain-tables' },
        { version: 4, name: 'indexed-retention-tombstones' },
        { version: 5, name: 'bounded-status-query-indexes' },
        { version: 6, name: 'coordinator-hot-query-indexes' },
      ]);

      const created = await instance.store.transact(tx => tx.put('test_records', 'record-1', {
        value: 'created',
        channelId: 'channel-a',
        state: 'accepted',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }, { expectedVersion: 0 }));
      expect(created.version).toBe(1);

      const updated = await instance.store.transact(tx => tx.put('test_records', 'record-1', {
        ...created,
        value: 'updated',
        channelId: 'channel-b',
        state: 'completed',
      }, { expectedVersion: created.version }));
      expect(updated).toMatchObject({ value: 'updated', version: 2 });

      await expect(instance.store.transact(tx => tx.put('test_records', 'record-1', {
        ...updated,
        value: 'stale-write',
      }, { expectedVersion: 1 }))).rejects.toThrow(/version conflict/i);

      expect(await instance.store.get('test_records', 'record-1')).toMatchObject({
        value: 'updated',
        version: 2,
      });
      const [metadata] = [...state.storage.sql.exec(`
        SELECT channel_id, state, created_at
        FROM delivery_records
        WHERE table_name = ? AND record_id = ?
      `, 'test_records', 'record-1')];
      expect(metadata).toEqual({
        channel_id: 'channel-b',
        state: 'completed',
        created_at: '2026-07-20T00:00:00.000Z',
      });

      const cleared = await instance.store.transact(tx => tx.put('test_records', 'record-1', {
        value: 'metadata-cleared',
      }, { expectedVersion: updated.version }));
      expect(cleared.version).toBe(3);
      const [clearedMetadata] = [...state.storage.sql.exec(`
        SELECT channel_id, state, created_at
        FROM delivery_records
        WHERE table_name = ? AND record_id = ?
      `, 'test_records', 'record-1')];
      expect(clearedMetadata).toEqual({
        channel_id: null,
        state: null,
        created_at: null,
      });
    });

    const ids = await listDurableObjectIds(env.NEWS_COORDINATOR);
    expect(ids.some(id => id.equals(env.NEWS_COORDINATOR.idFromName('sqlite-schema-and-cas')))).toBe(true);
  });

  it('rolls back every write when a transaction throws', async () => {
    const stub = coordinator('sqlite-transaction-rollback');

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.store.transact(tx => {
        tx.put('test_records', 'first', { value: 1 }, { expectedVersion: 0 });
        tx.put('test_records', 'second', { value: 2 }, { expectedVersion: 0 });
        throw new Error('abort the transaction');
      })).rejects.toThrow('abort the transaction');

      expect(await instance.store.list('test_records')).toEqual([]);
    });
  });

  it('preserves SQLite state and replays schema initialization after eviction', async () => {
    const stub = coordinator('sqlite-eviction-persistence');

    await runInDurableObject(stub, async instance => {
      instance.memoryOnlyMarker = 'discard-on-eviction';
      await instance.store.transact(tx => tx.put('test_records', 'durable', {
        value: 'survives',
      }, { expectedVersion: 0 }));
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance, state) => {
      expect(instance.memoryOnlyMarker).toBeUndefined();
      expect(await instance.store.get('test_records', 'durable')).toMatchObject({
        value: 'survives',
        version: 1,
      });
      const schemaRows = [...state.storage.sql.exec(
        'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
        'schema_version',
      )];
      expect(schemaRows).toHaveLength(1);
      expect(schemaRows[0].schema_value).toBe('6');
    });
  });

  it('upgrades v5 coordinator indexes and paused-maintenance metadata idempotently', async () => {
    const stub = coordinator('sqlite-v5-coordinator-index-upgrade');
    const pausedRecord = {
      outboxId: 'paused-outbox',
      channelId: 'channel-a',
      state: 'retry_pending',
      pauseOverrideActionId: 'operator-action-1',
      createdAt: '2026-07-20T00:00:00.000Z',
      version: 1,
    };

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
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
      state.storage.sql.exec('DROP INDEX IF EXISTS day_batches_channel_created_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS batch_items_batch_created_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS requests_channel_state_deadline_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS deliveries_channel_state_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS maintenance_outbox_channel_state_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS maintenance_outbox_channel_state_deadline_record');
      state.storage.sql.exec('DROP INDEX IF EXISTS maintenance_outbox_paused_override_record');
      state.storage.sql.exec('ALTER TABLE maintenance_outbox DROP COLUMN pause_override_action_id');
      state.storage.sql.exec('ALTER TABLE delivery_records DROP COLUMN pause_override_action_id');
      state.storage.sql.exec('DELETE FROM news_schema_migrations WHERE version = 6');
      state.storage.sql.exec(
        'DELETE FROM delivery_schema WHERE schema_key = ?',
        'pause_override_metadata_version',
      );
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
        'record_metadata_version',
        '3',
      );
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
        'schema_version',
        '5',
      );
    });

    await evictDurableObject(stub);

    for (let replay = 0; replay < 2; replay += 1) {
      await runInDurableObject(stub, async (_instance, state) => {
        const schema = [...state.storage.sql.exec(
          'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
          'schema_version',
        )];
        expect(schema).toEqual([{ schema_value: '6' }]);
        const migrations = [...state.storage.sql.exec(`
          SELECT version, name FROM news_schema_migrations WHERE version = 6
        `)];
        expect(migrations).toEqual([{
          version: 6,
          name: 'coordinator-hot-query-indexes',
        }]);
        const indexes = [...state.storage.sql.exec(`
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
        `)].map(row => row.name);
        expect(indexes).toEqual([
          'batch_items_batch_created_record',
          'day_batches_channel_created_record',
          'deliveries_channel_state_record',
          'maintenance_outbox_channel_state_deadline_record',
          'maintenance_outbox_channel_state_record',
          'maintenance_outbox_paused_override_record',
          'requests_channel_state_deadline_record',
        ]);
        const [pausedIndex] = [...state.storage.sql.exec(`
          SELECT sql FROM sqlite_master
          WHERE type = 'index' AND name = 'maintenance_outbox_paused_override_record'
        `)];
        expect(pausedIndex.sql.replace(/\s+/g, ' ').trim()).toContain(
          'ON maintenance_outbox(channel_id, state, next_attempt_at, deadline_at, record_id) WHERE pause_override_action_id IS NOT NULL',
        );
        const [pausedMetadata] = [...state.storage.sql.exec(`
          SELECT pause_override_action_id
          FROM maintenance_outbox
          WHERE record_id = ?
        `, pausedRecord.outboxId)];
        expect(pausedMetadata).toEqual({
          pause_override_action_id: pausedRecord.pauseOverrideActionId,
        });
        expect(await _instance.store.findPausedMaintenance(pausedRecord.channelId))
          .toEqual(pausedRecord);
        const pausedPlan = [...state.storage.sql.exec(`
          EXPLAIN QUERY PLAN
          SELECT record_json, version
          FROM maintenance_outbox INDEXED BY maintenance_outbox_paused_override_record
          WHERE channel_id = ?
            AND state = ?
            AND pause_override_action_id IS NOT NULL
          ORDER BY next_attempt_at ASC, deadline_at ASC, record_id ASC
          LIMIT 1
        `, pausedRecord.channelId, pausedRecord.state)].map(row => row.detail).join('\n');
        expect(pausedPlan)
          .toMatch(/SEARCH maintenance_outbox USING INDEX maintenance_outbox_paused_override_record \(channel_id=\? AND state=\?\)/);
        expect(pausedPlan).not.toMatch(/SCAN maintenance_outbox|USE TEMP B-TREE/);
      });
      await evictDurableObject(stub);
    }
  });

  it('migrates and backfills legacy generic records into domain tables idempotently across eviction', async () => {
    const stub = coordinator('sqlite-materialized-migration');
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

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('DROP TABLE delivery_records');
      state.storage.sql.exec(`
        CREATE TABLE delivery_records (
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (table_name, record_id)
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO delivery_records(
          table_name, record_id, record_json, version, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        'requests',
        'legacy-record',
        JSON.stringify(legacyRecord),
        legacyRecord.version,
        '2026-07-20T00:01:00.000Z',
      );
      state.storage.sql.exec(
        'DELETE FROM delivery_schema WHERE schema_key = ?',
        'record_metadata_version',
      );
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
        'schema_version',
        '2',
      );
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const columns = [...state.storage.sql.exec('PRAGMA table_info(delivery_records)')]
        .map(row => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        'channel_id',
        'state',
        'trigger_type',
        'request_id',
        'delivery_id',
        'batch_id',
        'publishing_day',
        'output_key',
        'deadline_at',
        'next_attempt_at',
        'created_at',
        'retention_status',
        'pause_override_action_id',
      ]));
      const [row] = [...state.storage.sql.exec(`
        SELECT
          channel_id, state, trigger_type, request_id, delivery_id, batch_id,
          publishing_day, output_key, deadline_at, next_attempt_at, created_at,
          pause_override_action_id
        FROM requests
        WHERE record_id = ?
      `, 'legacy-record')];
      expect(row).toEqual({
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
      });
      expect(await instance.store.get('requests', 'legacy-record')).toEqual(legacyRecord);
      expect(await instance.store.query('requests', {
        channelId: legacyRecord.channelId,
        state: legacyRecord.state,
      })).toEqual([legacyRecord]);
      const [normalized] = [...state.storage.sql.exec(`
        SELECT record_id, channel_id, state, request_id
        FROM requests
        WHERE record_id = ?
      `, 'legacy-record')];
      expect(normalized).toEqual({
        record_id: 'legacy-record',
        channel_id: legacyRecord.channelId,
        state: legacyRecord.state,
        request_id: legacyRecord.requestId,
      });
      const legacyRows = [...state.storage.sql.exec(`
        SELECT record_id FROM delivery_records
        WHERE table_name = ? AND record_id = ?
      `, 'requests', 'legacy-record')];
      expect(legacyRows).toEqual([]);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance, state) => {
      expect(await instance.store.get('requests', 'legacy-record')).toEqual(legacyRecord);
      const migrationRows = [...state.storage.sql.exec(
        'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
        'record_metadata_version',
      )];
      expect(migrationRows).toEqual([{ schema_value: '4' }]);
      const columnCount = [...state.storage.sql.exec('PRAGMA table_info(delivery_records)')]
        .filter(row => row.name === 'channel_id').length;
      expect(columnCount).toBe(1);
    });
  });

  it('queries exact metadata with bounded state arrays, ordering, and transaction parity', async () => {
    const stub = coordinator('sqlite-bounded-query');

    await runInDurableObject(stub, async (instance, state) => {
      await instance.store.transact(tx => {
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

      const active = await instance.store.query('requests', {
        channelId: 'channel-a',
        state: ['accepted', 'running'],
      }, { orderBy: 'createdAt', direction: 'desc', limit: 2 });
      expect(active.map(record => record.requestId)).toEqual(['running-new', 'accepted-old']);
      const normalizedPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM requests
        WHERE channel_id = ? AND state = ?
        ORDER BY created_at DESC, record_id DESC
        LIMIT ?
      `, 'channel-a', 'accepted', 10)];
      expect(normalizedPlan.map(row => row.detail).join('\n')).toMatch(/requests_hot_[0-9]+/);

      const exact = await instance.store.transact(tx => tx.query('requests', {
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
      expect(exact.map(record => record.requestId)).toEqual(['running-new']);
      expect(await instance.store.count('requests', { channelId: 'channel-a' })).toBe(2);
      expect(await instance.store.transact(tx => tx.count('requests', {
        channelId: 'channel-a', state: ['accepted', 'running'],
      }))).toBe(2);
      expect((await instance.store.query('requests', { channelId: 'channel-a' }, {
        orderBy: 'createdAt', direction: 'desc', limit: 1, offset: 1,
      })).map(record => record.requestId)).toEqual(['accepted-old']);

      expect(await instance.store.query('requests', { nextAttemptAt: null }))
        .toHaveLength(2);
      expect((await instance.store.query('requests', { retentionStatus: 'compacted' }))[0].requestId)
        .toBe('other-channel');
      expect(await instance.store.count('requests', {
        channelId: 'channel-a', retentionStatus: null,
      })).toBe(2);
      expect(await instance.store.query('requests', {
        state: "accepted') OR 1=1 --",
      })).toEqual([]);

      await expect(instance.store.query('requests; DROP TABLE delivery_records', {}))
        .rejects.toThrow(/invalid.*table/i);
      await expect(instance.store.query('requests', { unknown: 'value' }))
        .rejects.toThrow(/unsupported.*filter/i);
      await expect(instance.store.query('requests', { deliveryId: ['delivery-a'] }))
        .rejects.toThrow(/does not accept arrays/i);
      await expect(instance.store.query('requests', { state: Array(33).fill('accepted') }))
        .rejects.toThrow(/cannot exceed 32/i);
      await expect(instance.store.query('requests', { deliveryId: 'x'.repeat(501) }))
        .rejects.toThrow(/invalid.*deliveryId/i);
      await expect(instance.store.query('requests', {}, { limit: 0 }))
        .rejects.toThrow(/limit/i);
      await expect(instance.store.query('requests', {}, { limit: 1_001 }))
        .rejects.toThrow(/limit/i);
      await expect(instance.store.query('requests', {}, { offset: -1 }))
        .rejects.toThrow(/offset/i);
      await expect(instance.store.query('requests', {}, { offset: 1_000_001 }))
        .rejects.toThrow(/offset/i);
      await expect(instance.store.query('requests', {}, { orderBy: 'createdAt; DROP TABLE delivery_records' }))
        .rejects.toThrow(/unsupported.*order/i);
      await expect(instance.store.query('requests', {}, { orderBy: '__proto__' }))
        .rejects.toThrow(/unsupported.*order/i);
      await expect(instance.store.query('requests', {}, { direction: 'sideways' }))
        .rejects.toThrow(/direction/i);
    });
  });

  it('uses exact hot-query indexes and supports bounded multi-page aggregation beyond 1,000 rows', async () => {
    const stub = coordinator('sqlite-query-plan');

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`
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
      state.storage.sql.exec(`
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
      state.storage.sql.exec(`
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
      state.storage.sql.exec('ANALYZE delivery_records');
      state.storage.sql.exec('ANALYZE requests');
      state.storage.sql.exec('ANALYZE delivery_outputs');

      const channelPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM delivery_records
        WHERE table_name = ? AND channel_id = ? AND state = ?
        ORDER BY created_at DESC, record_id DESC
        LIMIT ?
      `, 'query_plan_fixture', 'channel-a', 'accepted', 10)];
      expect(channelPlan.map(row => row.detail).join('\n'))
        .toMatch(/delivery_records_table_channel_state_created/);

      const deadlinePlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM delivery_records
        WHERE table_name = ? AND channel_id = ? AND state = ?
        ORDER BY deadline_at ASC, record_id ASC
        LIMIT ?
      `, 'query_plan_fixture', 'channel-a', 'accepted', 10)];
      expect(deadlinePlan.map(row => row.detail).join('\n'))
        .toMatch(/delivery_records_table_channel_state_deadline/);

      const nextAttemptPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM delivery_records
        WHERE table_name = ? AND channel_id = ? AND state = ?
        ORDER BY next_attempt_at ASC, record_id ASC
        LIMIT ?
      `, 'query_plan_fixture', 'channel-a', 'accepted', 10)];
      expect(nextAttemptPlan.map(row => row.detail).join('\n'))
        .toMatch(/delivery_records_table_channel_state_next_attempt/);

      expect(await instance.store.query('query_plan_fixture')).toHaveLength(1_000);

      const requestStatusPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM requests
        WHERE 1 = 1 AND channel_id = ?
        ORDER BY created_at DESC, record_id DESC
        LIMIT ? OFFSET ?
      `, 'channel-a', 100, 0)].map(row => row.detail).join('\n');
      expect(requestStatusPlan).toMatch(/SEARCH requests USING INDEX requests_channel_created_record \(channel_id=\?\)/);
      expect(requestStatusPlan).not.toMatch(/SCAN requests|USE TEMP B-TREE/);

      const dayBatchPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM day_batches
        WHERE 1 = 1 AND channel_id = ?
        ORDER BY created_at DESC, record_id DESC
        LIMIT ? OFFSET ?
      `, 'channel-a', 100, 0)].map(row => row.detail).join('\n');
      expect(dayBatchPlan)
        .toMatch(/SEARCH day_batches USING INDEX day_batches_channel_created_record \(channel_id=\?\)/);
      expect(dayBatchPlan).not.toMatch(/SCAN day_batches|USE TEMP B-TREE/);

      const batchItemPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM batch_items
        WHERE 1 = 1 AND batch_id = ?
        ORDER BY created_at ASC, record_id ASC
        LIMIT ? OFFSET ?
      `, 'batch-a', 100, 0)].map(row => row.detail).join('\n');
      expect(batchItemPlan)
        .toMatch(/SEARCH batch_items USING INDEX batch_items_batch_created_record \(batch_id=\?\)/);
      expect(batchItemPlan).not.toMatch(/SCAN batch_items|USE TEMP B-TREE/);

      const requestDeadlinePlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM requests
        WHERE channel_id = ? AND state = ? AND deadline_at <= ?
        ORDER BY deadline_at ASC, record_id ASC
        LIMIT ? OFFSET ?
      `, 'channel-a', 'accepted', '2026-07-20T00:10:00.000Z', 100, 0)]
        .map(row => row.detail).join('\n');
      expect(requestDeadlinePlan)
        .toMatch(/SEARCH requests USING INDEX requests_channel_state_deadline_record \(channel_id=\? AND state=\? AND deadline_at<\?\)/);
      expect(requestDeadlinePlan).not.toMatch(/SCAN requests|USE TEMP B-TREE/);

      const deliveryTargetPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM deliveries
        WHERE 1 = 1 AND channel_id = ? AND state = ?
        ORDER BY record_id ASC
        LIMIT ? OFFSET ?
      `, 'channel-a', 'generation_exhausted', 100, 0)]
        .map(row => row.detail).join('\n');
      expect(deliveryTargetPlan)
        .toMatch(/SEARCH deliveries USING INDEX deliveries_channel_state_record \(channel_id=\? AND state=\?\)/);
      expect(deliveryTargetPlan).not.toMatch(/SCAN deliveries|USE TEMP B-TREE/);

      const maintenanceTargetPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM maintenance_outbox
        WHERE 1 = 1 AND channel_id = ? AND state = ?
        ORDER BY record_id ASC
        LIMIT ? OFFSET ?
      `, 'channel-a', 'dead_letter', 100, 0)]
        .map(row => row.detail).join('\n');
      expect(maintenanceTargetPlan)
        .toMatch(/SEARCH maintenance_outbox USING INDEX maintenance_outbox_channel_state_record \(channel_id=\? AND state=\?\)/);
      expect(maintenanceTargetPlan).not.toMatch(/SCAN maintenance_outbox|USE TEMP B-TREE/);

      const unresolvedOutputPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM delivery_outputs INDEXED BY delivery_outputs_state_record
        WHERE 1 = 1 AND state IN (?, ?, ?)
        ORDER BY record_id ASC
        LIMIT ? OFFSET ?
      `, 'manual_retry_required', 'exhausted', 'needs_reconciliation', 1_000, 0)]
        .map(row => row.detail).join('\n');
      expect(unresolvedOutputPlan)
        .toMatch(/SEARCH delivery_outputs USING INDEX delivery_outputs_state_record \(state=\?\)/);
      expect(unresolvedOutputPlan).not.toMatch(/SCAN delivery_outputs/);

      const unresolvedOutputCountPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) AS record_count
        FROM delivery_outputs INDEXED BY delivery_outputs_state_record
        WHERE 1 = 1 AND state IN (?, ?, ?)
      `, 'manual_retry_required', 'exhausted', 'needs_reconciliation')]
        .map(row => row.detail).join('\n');
      expect(unresolvedOutputCountPlan)
        .toMatch(/SEARCH delivery_outputs USING COVERING INDEX delivery_outputs_state_record \(state=\?\)/);
      expect(unresolvedOutputCountPlan).not.toMatch(/SCAN delivery_outputs/);

      const canaryOutputPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM delivery_outputs INDEXED BY delivery_outputs_state_record
        WHERE 1 = 1 AND state IN (?, ?, ?, ?)
        ORDER BY record_id ASC
        LIMIT ? OFFSET ?
      `, 'attempting', 'manual_retry_required', 'exhausted', 'needs_reconciliation', 1_000, 0)]
        .map(row => row.detail).join('\n');
      expect(canaryOutputPlan)
        .toMatch(/SEARCH delivery_outputs USING INDEX delivery_outputs_state_record \(state=\?\)/);
      expect(canaryOutputPlan).not.toMatch(/SCAN delivery_outputs/);

      const unresolvedStates = [
        'manual_retry_required',
        'exhausted',
        'needs_reconciliation',
      ];
      expect(await instance.store.count('delivery_outputs', { state: unresolvedStates }))
        .toBe(1_500);
      const firstOutputPage = await instance.store.query('delivery_outputs', {
        state: unresolvedStates,
      }, { limit: 1_000, offset: 0 });
      const secondOutputPage = await instance.store.query('delivery_outputs', {
        state: unresolvedStates,
      }, { limit: 1_000, offset: firstOutputPage.length });
      expect(firstOutputPage).toHaveLength(1_000);
      expect(secondOutputPage).toHaveLength(500);
      expect(new Set([...firstOutputPage, ...secondOutputPage].map(value => value.outputKey)).size)
        .toBe(1_500);

      expect(await instance.store.count('requests', { channelId: 'channel-a' })).toBe(1_500);
      const firstRequestPage = await instance.store.query('requests', { channelId: 'channel-a' }, {
        orderBy: 'createdAt', direction: 'desc', limit: 1_000, offset: 0,
      });
      const secondRequestPage = await instance.store.query('requests', { channelId: 'channel-a' }, {
        orderBy: 'createdAt', direction: 'desc', limit: 1_000, offset: firstRequestPage.length,
      });
      expect(firstRequestPage).toHaveLength(1_000);
      expect(secondRequestPage).toHaveLength(500);
      expect(firstRequestPage[0].requestId).toBe('status-request-1499');
      expect(secondRequestPage[0].requestId).toBe('status-request-0499');
      expect(new Set([...firstRequestPage, ...secondRequestPage].map(value => value.requestId)).size)
        .toBe(1_500);
    });
  });

  it('finds earliest maintenance from bounded indexed state candidates', async () => {
    const stub = coordinator('sqlite-paused-maintenance');

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`
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
      const attempting = await instance.store.transact(tx => tx.put(
        'maintenance_outbox',
        'paused-attempting',
        {
          outboxId: 'paused-attempting',
          channelId: 'channel-a',
          state: 'attempting',
          pauseOverrideActionId: 'operator-attempting',
          deadlineAt: '2026-07-20T00:02:00.000Z',
          nextAttemptAt: null,
          createdAt: '2026-07-20T00:00:00.000Z',
        },
        { expectedVersion: 0 },
      ));
      const claimable = await instance.store.transact(tx => tx.put(
        'maintenance_outbox',
        'paused-retry',
        {
          outboxId: 'paused-retry',
          channelId: 'channel-a',
          state: 'retry_pending',
          pauseOverrideActionId: 'operator-retry',
          deadlineAt: '2026-07-19T23:59:00.000Z',
          nextAttemptAt: '2026-07-20T00:03:00.000Z',
          createdAt: '2026-07-20T00:01:00.000Z',
        },
        { expectedVersion: 0 },
      ));
      state.storage.sql.exec('ANALYZE maintenance_outbox');

      expect(await instance.store.findPausedMaintenance('channel-a')).toEqual(attempting);
      expect(await instance.store.findPausedMaintenance('channel-a', { claimableOnly: true }))
        .toEqual(claimable);
      expect(await instance.store.findMaintenance('channel-a')).toEqual(attempting);
      expect(await instance.store.findMaintenance('channel-a', { claimableOnly: true }))
        .toEqual(claimable);
      const due = await instance.store.transact(tx => tx.put(
        'maintenance_outbox',
        'paused-pending-due',
        {
          outboxId: 'paused-pending-due',
          channelId: 'channel-a',
          state: 'pending',
          pauseOverrideActionId: 'operator-pending',
          deadlineAt: null,
          nextAttemptAt: null,
          createdAt: '2026-07-20T00:02:00.000Z',
        },
        { expectedVersion: 0 },
      ));
      expect(await instance.store.findPausedMaintenance('channel-a')).toEqual(due);
      expect(await instance.store.findPausedMaintenance('channel-a', { claimableOnly: true }))
        .toEqual(due);
      expect(await instance.store.findMaintenance('channel-a')).toEqual(due);
      expect(await instance.store.findMaintenance('channel-a', { claimableOnly: true }))
        .toEqual(due);
      expect(await instance.store.findPausedMaintenance('missing-channel', { claimableOnly: true }))
        .toBeNull();
      expect(await instance.store.findMaintenance('missing-channel', { claimableOnly: true }))
        .toBeNull();
      await expect(instance.store.findPausedMaintenance('channel-a', { claimableOnly: 'yes' }))
        .rejects.toThrow(/claimableOnly.*boolean/i);
      await expect(instance.store.findMaintenance('channel-a', { claimableOnly: 'yes' }))
        .rejects.toThrow(/claimableOnly.*boolean/i);

      const plan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM maintenance_outbox INDEXED BY maintenance_outbox_paused_override_record
        WHERE channel_id = ?
          AND state = ?
          AND pause_override_action_id IS NOT NULL
        ORDER BY next_attempt_at ASC, deadline_at ASC, record_id ASC
        LIMIT 1
      `, 'channel-a', 'retry_pending')].map(row => row.detail).join('\n');
      expect(plan)
        .toMatch(/SEARCH maintenance_outbox USING INDEX maintenance_outbox_paused_override_record \(channel_id=\? AND state=\?\)/);
      expect(plan).not.toMatch(/SCAN maintenance_outbox|USE TEMP B-TREE/);

      const nextAttemptPlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM maintenance_outbox INDEXED BY maintenance_outbox_hot_2
        WHERE channel_id = ? AND state = ?
        ORDER BY next_attempt_at ASC, record_id ASC
        LIMIT 1
      `, 'channel-a', 'pending')].map(row => row.detail).join('\n');
      expect(nextAttemptPlan)
        .toMatch(/SEARCH maintenance_outbox USING INDEX maintenance_outbox_hot_2 \(channel_id=\? AND state=\?\)/);
      expect(nextAttemptPlan).not.toMatch(/SCAN maintenance_outbox|USE TEMP B-TREE/);

      const deadlinePlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT record_json, version
        FROM maintenance_outbox INDEXED BY maintenance_outbox_channel_state_deadline_record
        WHERE channel_id = ? AND state = 'attempting'
        ORDER BY deadline_at ASC, record_id ASC
        LIMIT 1
      `, 'channel-a')].map(row => row.detail).join('\n');
      expect(deadlinePlan)
        .toMatch(/SEARCH maintenance_outbox USING INDEX maintenance_outbox_channel_state_deadline_record \(channel_id=\? AND state=\?\)/);
      expect(deadlinePlan).not.toMatch(/SCAN maintenance_outbox|USE TEMP B-TREE/);
    });
  });

  it('summarizes every batch item in one indexed aggregate beyond the query page limit', async () => {
    const stub = coordinator('sqlite-batch-summary');

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`
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
      state.storage.sql.exec(`
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

      expect(await instance.store.summarizeBatch('summary-batch')).toEqual({
        total: 1_205,
        remaining: 1_050,
        blocked: 150,
      });
      expect(await instance.store.summarizeBatch('missing-batch')).toEqual({
        total: 0,
        remaining: 0,
        blocked: 0,
      });
      await expect(instance.store.summarizeBatch(''))
        .rejects.toThrow(/invalid.*record id/i);

      const aggregatePlan = [...state.storage.sql.exec(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*)
        FROM batch_items AS batch_item INDEXED BY batch_items_hot_1
        LEFT JOIN deliveries AS delivery ON delivery.record_id = batch_item.delivery_id
        WHERE batch_item.batch_id = ?
      `, 'summary-batch')].map(row => row.detail).join('\n');
      expect(aggregatePlan)
        .toMatch(/SEARCH batch_item USING COVERING INDEX batch_items_hot_1 \(batch_id=\?\)/);
      expect(aggregatePlan)
        .toMatch(/SEARCH delivery USING (?:COVERING )?INDEX sqlite_autoindex_deliveries_1 \(record_id=\?\) LEFT-JOIN/);
      expect(aggregatePlan).not.toMatch(/SCAN batch_item|SCAN delivery|USE TEMP B-TREE/);
    });
  });
});
