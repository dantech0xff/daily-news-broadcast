import { DeliveryStore } from './delivery-store.js';

const MAX_RECORD_BYTES = 512 * 1024;
const SCHEMA_VERSION = '6';
const METADATA_MIGRATION_KEY = 'record_metadata_version';
const METADATA_MIGRATION_VERSION = '4';
const PAUSE_OVERRIDE_MIGRATION_KEY = 'pause_override_metadata_version';
const PAUSE_OVERRIDE_MIGRATION_VERSION = '1';
const MAX_QUERY_LIMIT = 1_000;
const MAX_STATE_FILTERS = 32;

const DOMAIN_TABLE_NAMES = Object.freeze([
  'channel_state',
  'articles',
  'day_batches',
  'batch_items',
  'deliveries',
  'delivery_outputs',
  'attempts',
  'maintenance_outbox',
  'legacy_seen_compat',
  'legacy_digest_compat',
  'requests',
  'operator_actions',
  'delivery_reservations',
  'retention_state',
  'canary_state',
  'coordinator_meta',
  'migration_state',
]);

const DOMAIN_TABLE_SQL = new Map(
  DOMAIN_TABLE_NAMES.map(table => [table, `"${table}"`]),
);

const SUPPORTED_LEGACY_SCHEMA_VERSIONS = new Set(['1', '2', '3', '4', '5', SCHEMA_VERSION]);

const DELIVERY_OUTPUT_STATE_INDEX = 'delivery_outputs_state_record';
const DAY_BATCHES_CHANNEL_CREATED_INDEX = 'day_batches_channel_created_record';
const BATCH_ITEMS_BATCH_CREATED_INDEX = 'batch_items_batch_created_record';
const REQUESTS_CHANNEL_STATE_DEADLINE_INDEX = 'requests_channel_state_deadline_record';
const DELIVERIES_CHANNEL_STATE_RECORD_INDEX = 'deliveries_channel_state_record';
const MAINTENANCE_OUTBOX_CHANNEL_STATE_RECORD_INDEX = 'maintenance_outbox_channel_state_record';
const MAINTENANCE_OUTBOX_CHANNEL_STATE_DEADLINE_INDEX = 'maintenance_outbox_channel_state_deadline_record';
const PAUSED_MAINTENANCE_INDEX = 'maintenance_outbox_paused_override_record';
const PAUSED_MAINTENANCE_STATES = Object.freeze([
  'pending',
  'retry_pending',
  'attempting',
]);
const CLAIMABLE_MAINTENANCE_STATES = Object.freeze([
  'pending',
  'retry_pending',
]);

const DOMAIN_INDEX_FIELDS = Object.freeze({
  channel_state: ['state, record_id'],
  articles: [
    'channel_id, state, created_at DESC, record_id DESC',
    'delivery_id, state, record_id',
  ],
  day_batches: [
    'channel_id, publishing_day, state, created_at DESC, record_id DESC',
  ],
  batch_items: [
    'batch_id, delivery_id, record_id',
    'channel_id, state, created_at DESC, record_id DESC',
  ],
  deliveries: [
    'channel_id, state, retention_status, updated_at, record_id',
    'channel_id, state, created_at DESC, record_id DESC',
    'channel_id, state, deadline_at, record_id',
    'publishing_day, state, created_at DESC, record_id DESC',
    'trigger_type, state, created_at DESC, record_id DESC',
    'request_id, record_id',
  ],
  delivery_outputs: [
    'delivery_id, output_key, record_id',
    'delivery_id, state, record_id',
  ],
  attempts: [
    'channel_id, state, deadline_at, record_id',
    'channel_id, state, next_attempt_at, record_id',
    'delivery_id, state, record_id',
    'request_id, record_id',
  ],
  maintenance_outbox: [
    'channel_id, state, retention_status, updated_at, record_id',
    'channel_id, state, next_attempt_at, record_id',
    'delivery_id, state, record_id',
  ],
  legacy_seen_compat: ['channel_id, state, created_at DESC, record_id DESC'],
  legacy_digest_compat: ['channel_id, publishing_day, record_id'],
  requests: [
    'channel_id, state, retention_status, updated_at, record_id',
    'channel_id, state, created_at DESC, record_id DESC',
    'channel_id, request_id, record_id',
    'trigger_type, state, created_at DESC, record_id DESC',
    'delivery_id, record_id',
  ],
  operator_actions: [
    'channel_id, state, created_at DESC, record_id DESC',
    'request_id, record_id',
    'delivery_id, record_id',
  ],
  delivery_reservations: [
    'channel_id, state, created_at DESC, record_id DESC',
    'delivery_id, record_id',
    'request_id, record_id',
  ],
  retention_state: ['channel_id, record_id'],
  canary_state: ['channel_id, state, created_at DESC, record_id DESC'],
  coordinator_meta: ['channel_id, record_id'],
  migration_state: ['channel_id, state, created_at DESC, record_id DESC'],
});

const MATERIALIZED_FIELDS = Object.freeze([
  { property: 'channelId', column: 'channel_id', maxLength: 500 },
  { property: 'state', column: 'state', maxLength: 128 },
  { property: 'triggerType', column: 'trigger_type', maxLength: 128 },
  { property: 'requestId', column: 'request_id', maxLength: 500 },
  { property: 'deliveryId', column: 'delivery_id', maxLength: 500 },
  { property: 'batchId', column: 'batch_id', maxLength: 500 },
  { property: 'publishingDay', column: 'publishing_day', maxLength: 32 },
  { property: 'outputKey', column: 'output_key', maxLength: 500 },
  { property: 'deadlineAt', column: 'deadline_at', maxLength: 64 },
  { property: 'nextAttemptAt', column: 'next_attempt_at', maxLength: 64 },
  { property: 'createdAt', column: 'created_at', maxLength: 64 },
  { property: 'retentionStatus', column: 'retention_status', maxLength: 128 },
  { property: 'pauseOverrideActionId', column: 'pause_override_action_id', maxLength: 500 },
]);

const MATERIALIZED_FIELD_BY_PROPERTY = new Map(
  MATERIALIZED_FIELDS.map(field => [field.property, field]),
);

const QUERY_ORDER_COLUMNS = Object.freeze({
  recordId: 'record_id',
  version: 'version',
  updatedAt: 'updated_at',
  ...Object.fromEntries(MATERIALIZED_FIELDS.map(field => [field.property, field.column])),
});

// These statements are intentionally static. Schema identifiers must never be
// derived from records or query input.
const ADD_MATERIALIZED_COLUMN_STATEMENTS = Object.freeze([
  ['channel_id', 'ALTER TABLE delivery_records ADD COLUMN channel_id TEXT'],
  ['state', 'ALTER TABLE delivery_records ADD COLUMN state TEXT'],
  ['trigger_type', 'ALTER TABLE delivery_records ADD COLUMN trigger_type TEXT'],
  ['request_id', 'ALTER TABLE delivery_records ADD COLUMN request_id TEXT'],
  ['delivery_id', 'ALTER TABLE delivery_records ADD COLUMN delivery_id TEXT'],
  ['batch_id', 'ALTER TABLE delivery_records ADD COLUMN batch_id TEXT'],
  ['publishing_day', 'ALTER TABLE delivery_records ADD COLUMN publishing_day TEXT'],
  ['output_key', 'ALTER TABLE delivery_records ADD COLUMN output_key TEXT'],
  ['deadline_at', 'ALTER TABLE delivery_records ADD COLUMN deadline_at TEXT'],
  ['next_attempt_at', 'ALTER TABLE delivery_records ADD COLUMN next_attempt_at TEXT'],
  ['created_at', 'ALTER TABLE delivery_records ADD COLUMN created_at TEXT'],
  ['retention_status', 'ALTER TABLE delivery_records ADD COLUMN retention_status TEXT'],
  ['pause_override_action_id', 'ALTER TABLE delivery_records ADD COLUMN pause_override_action_id TEXT'],
]);

const CREATE_INDEX_STATEMENTS = Object.freeze([
  `CREATE INDEX IF NOT EXISTS delivery_records_table_version
   ON delivery_records(table_name, version)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_created
   ON delivery_records(table_name, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_channel_state_created
   ON delivery_records(table_name, channel_id, state, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_channel_state_deadline
   ON delivery_records(table_name, channel_id, state, deadline_at, record_id)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_channel_state_next_attempt
   ON delivery_records(table_name, channel_id, state, next_attempt_at, record_id)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_delivery_state
   ON delivery_records(table_name, delivery_id, state, record_id)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_batch_delivery
   ON delivery_records(table_name, batch_id, delivery_id, record_id)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_publishing_state_created
   ON delivery_records(table_name, publishing_day, state, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_trigger_state_created
   ON delivery_records(table_name, trigger_type, state, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_channel_request
   ON delivery_records(table_name, channel_id, request_id, record_id)`,
  `CREATE INDEX IF NOT EXISTS delivery_records_table_delivery_output
   ON delivery_records(table_name, delivery_id, output_key, record_id)`,
]);

const ADDITIVE_DOMAIN_INDEX_STATEMENTS = Object.freeze([
  `CREATE INDEX IF NOT EXISTS ${DELIVERY_OUTPUT_STATE_INDEX}
   ON delivery_outputs(state, record_id)`,
  `CREATE INDEX IF NOT EXISTS requests_channel_created_record
   ON requests(channel_id, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS ${DAY_BATCHES_CHANNEL_CREATED_INDEX}
   ON day_batches(channel_id, created_at DESC, record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS ${BATCH_ITEMS_BATCH_CREATED_INDEX}
   ON batch_items(batch_id, created_at ASC, record_id ASC)`,
  `CREATE INDEX IF NOT EXISTS ${REQUESTS_CHANNEL_STATE_DEADLINE_INDEX}
   ON requests(channel_id, state, deadline_at, record_id)`,
  `CREATE INDEX IF NOT EXISTS ${DELIVERIES_CHANNEL_STATE_RECORD_INDEX}
   ON deliveries(channel_id, state, record_id)`,
  `CREATE INDEX IF NOT EXISTS ${MAINTENANCE_OUTBOX_CHANNEL_STATE_RECORD_INDEX}
   ON maintenance_outbox(channel_id, state, record_id)`,
  `CREATE INDEX IF NOT EXISTS ${MAINTENANCE_OUTBOX_CHANNEL_STATE_DEADLINE_INDEX}
   ON maintenance_outbox(channel_id, state, deadline_at, record_id)`,
  `CREATE INDEX IF NOT EXISTS ${PAUSED_MAINTENANCE_INDEX}
   ON maintenance_outbox(channel_id, state, next_attempt_at, deadline_at, record_id)
   WHERE pause_override_action_id IS NOT NULL`,
]);

const SUMMARIZE_BATCH_SQL = `
  SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE
      WHEN delivery.record_id IS NOT NULL
        AND (delivery.state IS NULL OR delivery.state NOT IN ('succeeded', 'abandoned'))
      THEN 1 ELSE 0
    END), 0) AS remaining,
    COALESCE(SUM(CASE
      WHEN delivery.record_id IS NOT NULL
        AND (
          delivery.state IS NULL
          OR delivery.state NOT IN (
            'succeeded', 'abandoned',
            'pending_generation', 'ready', 'generating', 'delivering',
            'generation_retry_pending', 'partial_retryable'
          )
        )
      THEN 1 ELSE 0
    END), 0) AS blocked
  FROM batch_items AS batch_item INDEXED BY batch_items_hot_1
  LEFT JOIN deliveries AS delivery ON delivery.record_id = batch_item.delivery_id
  WHERE batch_item.batch_id = ?
`;

const FIND_PAUSED_MAINTENANCE_SQL = `
  SELECT record_json, version
  FROM maintenance_outbox INDEXED BY ${PAUSED_MAINTENANCE_INDEX}
  WHERE channel_id = ?
    AND state = ?
    AND pause_override_action_id IS NOT NULL
  ORDER BY next_attempt_at ASC, deadline_at ASC, record_id ASC
  LIMIT 1
`;

const FIND_MAINTENANCE_BY_NEXT_ATTEMPT_SQL = `
  SELECT record_json, version
  FROM maintenance_outbox INDEXED BY maintenance_outbox_hot_2
  WHERE channel_id = ? AND state = ?
  ORDER BY next_attempt_at ASC, record_id ASC
  LIMIT 1
`;

const FIND_MAINTENANCE_BY_DEADLINE_SQL = `
  SELECT record_json, version
  FROM maintenance_outbox INDEXED BY ${MAINTENANCE_OUTBOX_CHANNEL_STATE_DEADLINE_INDEX}
  WHERE channel_id = ? AND state = 'attempting'
  ORDER BY deadline_at ASC, record_id ASC
  LIMIT 1
`;

const INSERT_RECORD_SQL = `
  INSERT INTO delivery_records(
    table_name, record_id, record_json, version, updated_at,
    channel_id, state, trigger_type, request_id, delivery_id, batch_id,
    publishing_day, output_key, deadline_at, next_attempt_at, created_at, retention_status,
    pause_override_action_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_RECORD_SQL = `
  UPDATE delivery_records SET
    record_json = ?, version = ?, updated_at = ?,
    channel_id = ?, state = ?, trigger_type = ?, request_id = ?, delivery_id = ?, batch_id = ?,
    publishing_day = ?, output_key = ?, deadline_at = ?, next_attempt_at = ?, created_at = ?,
    retention_status = ?, pause_override_action_id = ?
  WHERE table_name = ? AND record_id = ? AND version = ?
`;

const BACKFILL_RECORD_SQL = `
  UPDATE delivery_records SET
    channel_id = ?, state = ?, trigger_type = ?, request_id = ?, delivery_id = ?, batch_id = ?,
    publishing_day = ?, output_key = ?, deadline_at = ?, next_attempt_at = ?, created_at = ?,
    retention_status = ?, pause_override_action_id = ?
  WHERE table_name = ? AND record_id = ? AND version = ?
`;

/**
 * DeliveryStore backed by one SQLite Durable Object storage instance.
 * Transactions are synchronous by design; provider I/O must happen between
 * claim and commit transactions in DeliveryStateMachine.
 */
export class SQLiteDeliveryStore extends DeliveryStore {
  constructor(storage) {
    super();
    if (!storage?.sql || typeof storage.transactionSync !== 'function') {
      throw new Error('SQLiteDeliveryStore requires Durable Object storage with SQL');
    }
    this.storage = storage;
    this.sql = storage.sql;
    this._initialized = false;
  }

  get capabilities() {
    return {
      durable: true,
      transactional: true,
      compareAndSet: true,
      nonMutatingRead: true,
      query: true,
      processOwned: true,
    };
  }

  async initialize() {
    if (this._initialized) return;
    this.storage.transactionSync(() => {
      createGenericRecordTable(this.sql);
      createMigrationTables(this.sql);
      const schema = first(this.sql.exec(
        'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
        'schema_version',
      ));
      if (schema && !SUPPORTED_LEGACY_SCHEMA_VERSIONS.has(schema.schema_value)) {
        throw new Error('Unsupported SQLite delivery schema version');
      }
      ensureMaterializedColumns(this.sql);
      backfillMaterializedMetadata(this.sql);
      for (const statement of CREATE_INDEX_STATEMENTS) this.sql.exec(statement);
      createDomainTables(this.sql);
      ensureDomainMaterializedColumns(this.sql);
      migrateGenericDomainRecords(this.sql);
      backfillPauseOverrideMetadata(this.sql);
      createDomainIndexes(this.sql);
      recordSchemaMigrations(this.sql);
      this.sql.exec(
        'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
        'schema_version',
        SCHEMA_VERSION,
      );
    });
    this._initialized = true;
  }

  async get(table, id) {
    this._assertInitialized();
    validateTableAndId(table, id);
    return readRecord(this.sql, table, id);
  }

  async list(table, predicate = () => true) {
    this._assertInitialized();
    validateTable(table);
    const rows = listRows(this.sql, table);
    return rows.map(decode).filter(predicate).map(value => structuredClone(value));
  }

  async query(table, filters = {}, options = {}) {
    this._assertInitialized();
    return queryRecords(this.sql, table, filters, options);
  }

  async count(table, filters = {}) {
    this._assertInitialized();
    return countRecords(this.sql, table, filters);
  }

  async summarizeBatch(batchId) {
    this._assertInitialized();
    validateTableAndId('batch_items', batchId);
    const row = first(this.sql.exec(SUMMARIZE_BATCH_SQL, batchId));
    const summary = {
      total: Number(row?.total ?? 0),
      remaining: Number(row?.remaining ?? 0),
      blocked: Number(row?.blocked ?? 0),
    };
    if (!Object.values(summary).every(Number.isFinite)) {
      throw new Error('SQLite batch summary returned non-finite counts');
    }
    return summary;
  }

  async findPausedMaintenance(channelId, { claimableOnly = false } = {}) {
    this._assertInitialized();
    validateTableAndId('maintenance_outbox', channelId);
    if (typeof claimableOnly !== 'boolean') {
      throw new Error('Paused maintenance claimableOnly option must be a boolean');
    }
    const states = claimableOnly
      ? CLAIMABLE_MAINTENANCE_STATES
      : PAUSED_MAINTENANCE_STATES;
    const candidates = states
      .map(state => first(this.sql.exec(FIND_PAUSED_MAINTENANCE_SQL, channelId, state)))
      .filter(Boolean)
      .map(decode)
      .sort(compareMaintenanceByEffectiveTime);
    return candidates[0] ? structuredClone(candidates[0]) : null;
  }

  async findMaintenance(channelId, { claimableOnly = false } = {}) {
    this._assertInitialized();
    validateTableAndId('maintenance_outbox', channelId);
    if (typeof claimableOnly !== 'boolean') {
      throw new Error('Maintenance claimableOnly option must be a boolean');
    }
    const candidates = CLAIMABLE_MAINTENANCE_STATES
      .map(state => first(this.sql.exec(
        FIND_MAINTENANCE_BY_NEXT_ATTEMPT_SQL,
        channelId,
        state,
      )))
      .filter(Boolean);
    if (!claimableOnly) {
      const attempting = first(this.sql.exec(FIND_MAINTENANCE_BY_DEADLINE_SQL, channelId));
      if (attempting) candidates.push(attempting);
    }
    const records = candidates.map(decode).sort(compareMaintenanceByEffectiveTime);
    return records[0] ? structuredClone(records[0]) : null;
  }

  async transact(callback) {
    this._assertInitialized();
    return this.storage.transactionSync(() => {
      const transaction = createSQLiteTransaction(this.sql);
      const result = callback(transaction);
      if (result && typeof result.then === 'function') {
        throw new Error('SQLite delivery transactions must be synchronous; provider I/O belongs outside transactions');
      }
      return result === undefined ? undefined : structuredClone(result);
    });
  }

  _assertInitialized() {
    if (!this._initialized) throw new Error('SQLiteDeliveryStore.initialize() must succeed before use');
  }
}

function createSQLiteTransaction(sql) {
  return Object.freeze({
    get(table, id) {
      validateTableAndId(table, id);
      return readRecord(sql, table, id);
    },
    list(table, predicate = () => true) {
      validateTable(table);
      return listRows(sql, table).map(decode).filter(predicate).map(value => structuredClone(value));
    },
    query(table, filters = {}, options = {}) {
      return queryRecords(sql, table, filters, options);
    },
    count(table, filters = {}) {
      return countRecords(sql, table, filters);
    },
    put(table, id, record, { expectedVersion } = {}) {
      validateTableAndId(table, id);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('DeliveryStore record must be an object');
      const current = readRecord(sql, table, id);
      const currentVersion = current?.version ?? 0;
      if (expectedVersion === undefined || expectedVersion !== currentVersion) {
        throw new Error(`DeliveryStore version conflict for ${table}/${id}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      const next = structuredClone({ ...record, version: currentVersion + 1 });
      const json = encode(next);
      const updatedAt = typeof next.updatedAt === 'string' ? next.updatedAt : new Date().toISOString();
      const metadata = materializedValues(next);
      writeRecord(sql, table, id, json, next.version, updatedAt, metadata, currentVersion);
      return structuredClone(next);
    },
    delete(table, id, { expectedVersion } = {}) {
      validateTableAndId(table, id);
      const current = readRecord(sql, table, id);
      const currentVersion = current?.version ?? 0;
      if (expectedVersion === undefined || expectedVersion !== currentVersion) {
        throw new Error(`DeliveryStore version conflict for ${table}/${id}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      deleteRecord(sql, table, id, currentVersion);
    },
  });
}

function createGenericRecordTable(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS delivery_records (
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      updated_at TEXT NOT NULL,
      channel_id TEXT,
      state TEXT,
      trigger_type TEXT,
      request_id TEXT,
      delivery_id TEXT,
      batch_id TEXT,
      publishing_day TEXT,
      output_key TEXT,
      deadline_at TEXT,
      next_attempt_at TEXT,
      created_at TEXT,
      retention_status TEXT,
      pause_override_action_id TEXT,
      PRIMARY KEY (table_name, record_id)
    )
  `);
}

function createMigrationTables(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS delivery_schema (
      schema_key TEXT PRIMARY KEY,
      schema_value TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
}

function createDomainTables(sql) {
  for (const table of DOMAIN_TABLE_NAMES) {
    const sqlName = DOMAIN_TABLE_SQL.get(table);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ${sqlName} (
        record_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        updated_at TEXT NOT NULL,
        channel_id TEXT,
        state TEXT,
        trigger_type TEXT,
        request_id TEXT,
        delivery_id TEXT,
        batch_id TEXT,
        publishing_day TEXT,
        output_key TEXT,
        deadline_at TEXT,
        next_attempt_at TEXT,
        created_at TEXT,
        retention_status TEXT,
        pause_override_action_id TEXT
      )
    `);
  }
}

function ensureDomainMaterializedColumns(sql) {
  for (const table of DOMAIN_TABLE_NAMES) {
    const sqlName = DOMAIN_TABLE_SQL.get(table);
    const existing = new Set([...sql.exec(`PRAGMA table_info(${sqlName})`)].map(row => row.name));
    for (const field of MATERIALIZED_FIELDS) {
      if (!existing.has(field.column)) {
        sql.exec(`ALTER TABLE ${sqlName} ADD COLUMN "${field.column}" TEXT`);
      }
    }
  }
}

function createDomainIndexes(sql) {
  for (const table of DOMAIN_TABLE_NAMES) {
    const sqlName = DOMAIN_TABLE_SQL.get(table);
    const indexes = DOMAIN_INDEX_FIELDS[table] ?? [];
    indexes.forEach((fields, index) => {
      sql.exec(`
        CREATE INDEX IF NOT EXISTS "${table}_hot_${index + 1}"
        ON ${sqlName}(${fields})
      `);
    });
  }
  for (const statement of ADDITIVE_DOMAIN_INDEX_STATEMENTS) sql.exec(statement);
}

function migrateGenericDomainRecords(sql) {
  const columns = [
    'record_id',
    'record_json',
    'version',
    'updated_at',
    ...MATERIALIZED_FIELDS.map(field => field.column),
  ];
  const columnList = columns.join(', ');
  const updates = columns
    .filter(column => column !== 'record_id')
    .map(column => `${column} = excluded.${column}`)
    .join(', ');

  for (const table of DOMAIN_TABLE_NAMES) {
    const sqlName = DOMAIN_TABLE_SQL.get(table);
    sql.exec(`
      INSERT INTO ${sqlName}(${columnList})
      SELECT ${columnList}
      FROM delivery_records
      WHERE table_name = ?
      ON CONFLICT(record_id) DO UPDATE SET ${updates}
      WHERE excluded.version > ${sqlName}.version
    `, table);
    sql.exec(`
      DELETE FROM delivery_records
      WHERE table_name = ?
        AND EXISTS (
          SELECT 1 FROM ${sqlName}
          WHERE ${sqlName}.record_id = delivery_records.record_id
            AND ${sqlName}.version >= delivery_records.version
        )
    `, table);
  }
}

function backfillPauseOverrideMetadata(sql) {
  const migration = first(sql.exec(
    'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
    PAUSE_OVERRIDE_MIGRATION_KEY,
  ));
  if (migration?.schema_value === PAUSE_OVERRIDE_MIGRATION_VERSION) return;

  for (const row of sql.exec(`
    SELECT record_id, record_json, version
    FROM maintenance_outbox
    WHERE pause_override_action_id IS NULL
    ORDER BY record_id
  `)) {
    const record = decode(row);
    const value = record.pauseOverrideActionId;
    if (typeof value !== 'string' || value.length > 500) continue;
    sql.exec(`
      UPDATE maintenance_outbox
      SET pause_override_action_id = ?
      WHERE record_id = ? AND version = ?
    `, value, row.record_id, row.version);
  }
  sql.exec(
    'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
    PAUSE_OVERRIDE_MIGRATION_KEY,
    PAUSE_OVERRIDE_MIGRATION_VERSION,
  );
}

function recordSchemaMigrations(sql) {
  const appliedAt = new Date().toISOString();
  for (const [version, name] of [
    [1, 'generic-record-store'],
    [2, 'materialized-query-metadata'],
    [3, 'normalized-domain-tables'],
    [4, 'indexed-retention-tombstones'],
    [5, 'bounded-status-query-indexes'],
    [6, 'coordinator-hot-query-indexes'],
  ]) {
    sql.exec(
      'INSERT OR IGNORE INTO news_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
      version,
      name,
      appliedAt,
    );
  }
}

function storageTable(table) {
  const sqlName = DOMAIN_TABLE_SQL.get(table);
  if (sqlName) return { domain: true, logicalTable: table, sqlName };
  return { domain: false, logicalTable: table, sqlName: 'delivery_records' };
}

function readRecord(sql, table, id) {
  const storage = storageTable(table);
  const row = storage.domain
    ? first(sql.exec(
      `SELECT record_json, version FROM ${storage.sqlName} WHERE record_id = ?`,
      id,
    ))
    : first(sql.exec(
      'SELECT record_json, version FROM delivery_records WHERE table_name = ? AND record_id = ?',
      table,
      id,
    ));
  return decode(row);
}

function listRows(sql, table) {
  const storage = storageTable(table);
  return storage.domain
    ? [...sql.exec(
      `SELECT record_json, version FROM ${storage.sqlName} ORDER BY record_id`,
    )]
    : [...sql.exec(
      'SELECT record_json, version FROM delivery_records WHERE table_name = ? ORDER BY record_id',
      table,
    )];
}

function writeRecord(sql, table, id, json, version, updatedAt, metadata, currentVersion) {
  const storage = storageTable(table);
  if (!storage.domain) {
    if (currentVersion === 0) {
      sql.exec(INSERT_RECORD_SQL, table, id, json, version, updatedAt, ...metadata);
    } else {
      sql.exec(UPDATE_RECORD_SQL, json, version, updatedAt, ...metadata, table, id, currentVersion);
    }
    return;
  }

  const materializedColumns = MATERIALIZED_FIELDS.map(field => field.column).join(', ');
  if (currentVersion === 0) {
    sql.exec(`
      INSERT INTO ${storage.sqlName}(
        record_id, record_json, version, updated_at, ${materializedColumns}
      ) VALUES (?, ?, ?, ?, ${MATERIALIZED_FIELDS.map(() => '?').join(', ')})
    `, id, json, version, updatedAt, ...metadata);
  } else {
    const assignments = MATERIALIZED_FIELDS.map(field => `${field.column} = ?`).join(', ');
    sql.exec(`
      UPDATE ${storage.sqlName} SET
        record_json = ?, version = ?, updated_at = ?, ${assignments}
      WHERE record_id = ? AND version = ?
    `, json, version, updatedAt, ...metadata, id, currentVersion);
  }
}

function deleteRecord(sql, table, id, version) {
  const storage = storageTable(table);
  if (storage.domain) {
    sql.exec(`DELETE FROM ${storage.sqlName} WHERE record_id = ? AND version = ?`, id, version);
    return;
  }
  sql.exec(
    'DELETE FROM delivery_records WHERE table_name = ? AND record_id = ? AND version = ?',
    table,
    id,
    version,
  );
}

function ensureMaterializedColumns(sql) {
  const existing = new Set([...sql.exec('PRAGMA table_info(delivery_records)')].map(row => row.name));
  for (const [column, statement] of ADD_MATERIALIZED_COLUMN_STATEMENTS) {
    if (!existing.has(column)) sql.exec(statement);
  }
}

function backfillMaterializedMetadata(sql) {
  const migration = first(sql.exec(
    'SELECT schema_value FROM delivery_schema WHERE schema_key = ?',
    METADATA_MIGRATION_KEY,
  ));
  if (migration?.schema_value === METADATA_MIGRATION_VERSION) return;

  for (const row of sql.exec(
    'SELECT table_name, record_id, record_json, version FROM delivery_records ORDER BY table_name, record_id',
  )) {
    const record = decode(row);
    sql.exec(
      BACKFILL_RECORD_SQL,
      ...materializedValues(record),
      row.table_name,
      row.record_id,
      row.version,
    );
  }
  sql.exec(
    'INSERT OR REPLACE INTO delivery_schema(schema_key, schema_value) VALUES (?, ?)',
    METADATA_MIGRATION_KEY,
    METADATA_MIGRATION_VERSION,
  );
}

function materializedValues(record) {
  return MATERIALIZED_FIELDS.map(({ property, maxLength }) => {
    const value = record[property];
    return typeof value === 'string' && value.length <= maxLength ? value : null;
  });
}

function compareMaintenanceByEffectiveTime(left, right) {
  const leftAt = left.state === 'attempting' ? left.deadlineAt ?? null : left.nextAttemptAt ?? null;
  const rightAt = right.state === 'attempting' ? right.deadlineAt ?? null : right.nextAttemptAt ?? null;
  if (leftAt === null && rightAt !== null) return -1;
  if (leftAt !== null && rightAt === null) return 1;
  const timeOrder = leftAt === null ? 0 : String(leftAt).localeCompare(String(rightAt));
  if (timeOrder !== 0) return timeOrder;
  return String(left.outboxId ?? '').localeCompare(String(right.outboxId ?? ''));
}

function queryRecords(sql, table, filters, options) {
  validateTable(table);
  const storage = storageTable(table);
  validatePlainObject(options, 'DeliveryStore query options');
  for (const property of Object.keys(options)) {
    if (!['orderBy', 'direction', 'limit', 'offset'].includes(property)) {
      throw new Error(`Unsupported DeliveryStore query option: ${property}`);
    }
  }

  const orderBy = options.orderBy ?? 'recordId';
  if (typeof orderBy !== 'string' || !Object.hasOwn(QUERY_ORDER_COLUMNS, orderBy)) {
    throw new Error(`Unsupported DeliveryStore query order: ${String(orderBy)}`);
  }
  const orderColumn = QUERY_ORDER_COLUMNS[orderBy];
  const direction = options.direction ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error('DeliveryStore query direction must be "asc" or "desc"');
  }
  const limit = options.limit ?? MAX_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new Error(`DeliveryStore query limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new Error('DeliveryStore query offset must be an integer between 0 and 1000000');
  }
  const { predicates, parameters } = buildQueryWhere(storage, filters);
  const indexHint = orderBy === 'recordId'
    ? deliveryOutputStateIndexHint(storage, filters)
    : '';

  const tieBreak = orderColumn === 'record_id' ? '' : `, record_id ${direction.toUpperCase()}`;
  const statement = `
    SELECT record_json, version
    FROM ${storage.sqlName}${indexHint}
    WHERE ${predicates.join(' AND ')}
    ORDER BY ${orderColumn} ${direction.toUpperCase()}${tieBreak}
    LIMIT ? OFFSET ?
  `;
  return [...sql.exec(statement, ...parameters, limit, offset)]
    .map(decode)
    .map(value => structuredClone(value));
}

function countRecords(sql, table, filters) {
  validateTable(table);
  const storage = storageTable(table);
  const { predicates, parameters } = buildQueryWhere(storage, filters);
  const indexHint = deliveryOutputStateIndexHint(storage, filters);
  const row = first(sql.exec(
    `SELECT COUNT(*) AS record_count FROM ${storage.sqlName}${indexHint} WHERE ${predicates.join(' AND ')}`,
    ...parameters,
  ));
  return Number(row?.record_count ?? 0);
}

function deliveryOutputStateIndexHint(storage, filters) {
  const properties = Object.keys(filters);
  // These state-only reads drive unresolved status and canary safety checks.
  // Pin the selective index because SQLite can otherwise favor the primary-key
  // order after ANALYZE and scan every output before applying the state filter.
  return storage.logicalTable === 'delivery_outputs'
    && properties.length === 1
    && properties[0] === 'state'
    ? ` INDEXED BY ${DELIVERY_OUTPUT_STATE_INDEX}`
    : '';
}

function buildQueryWhere(storage, filters) {
  validatePlainObject(filters, 'DeliveryStore query filters');
  for (const property of Object.keys(filters)) {
    if (!MATERIALIZED_FIELD_BY_PROPERTY.has(property)) {
      throw new Error(`Unsupported DeliveryStore query filter: ${property}`);
    }
  }
  const predicates = storage.domain ? ['1 = 1'] : ['table_name = ?'];
  const parameters = storage.domain ? [] : [storage.logicalTable];
  for (const field of MATERIALIZED_FIELDS) {
    if (!Object.hasOwn(filters, field.property)) continue;
    const rawValue = filters[field.property];
    if (field.property === 'state' && Array.isArray(rawValue)) {
      if (rawValue.length === 0) {
        predicates.push('1 = 0');
        continue;
      }
      if (rawValue.length > MAX_STATE_FILTERS) {
        throw new Error(`DeliveryStore state filter cannot exceed ${MAX_STATE_FILTERS} values`);
      }
      const values = [...new Set(rawValue.map(value => validateFilterValue(field, value)))];
      predicates.push(`${field.column} IN (${values.map(() => '?').join(', ')})`);
      parameters.push(...values);
      continue;
    }
    if (Array.isArray(rawValue)) {
      throw new Error(`DeliveryStore query filter ${field.property} does not accept arrays`);
    }
    if (rawValue === null) {
      predicates.push(`${field.column} IS NULL`);
      continue;
    }
    predicates.push(`${field.column} = ?`);
    parameters.push(validateFilterValue(field, rawValue));
  }

  return { predicates, parameters };
}

function validateFilterValue(field, value) {
  if (typeof value !== 'string' || value.length > field.maxLength) {
    throw new Error(`Invalid DeliveryStore query filter ${field.property}`);
  }
  return value;
}

function validatePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function encode(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new Error('DeliveryStore record must be serializable'); }
  if (new TextEncoder().encode(json).byteLength > MAX_RECORD_BYTES) {
    throw new Error(`DeliveryStore record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return json;
}

function decode(row) {
  if (!row) return null;
  try {
    const value = JSON.parse(row.record_json);
    if (!value || typeof value !== 'object' || value.version !== row.version) {
      throw new Error('record/version mismatch');
    }
    return value;
  } catch (error) {
    throw new Error(`SQLite delivery record is corrupt: ${error.message}`);
  }
}

function first(cursor) {
  for (const row of cursor) return row;
  return null;
}

function validateTableAndId(table, id) {
  validateTable(table);
  if (typeof id !== 'string' || id.length === 0 || id.length > 500) throw new Error('Invalid DeliveryStore record id');
}

function validateTable(table) {
  if (typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(table)) {
    throw new Error('Invalid DeliveryStore table name');
  }
}
