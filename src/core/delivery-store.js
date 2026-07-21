const SCHEMA_VERSION = 2;
const MAX_DURABLE_STATE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const QUERY_FIELDS = new Set([
  'channelId', 'state', 'triggerType', 'requestId', 'deliveryId', 'batchId',
  'publishingDay', 'outputKey', 'deadlineAt', 'nextAttemptAt', 'createdAt',
  'retentionStatus',
]);
const QUERY_ORDER_FIELDS = new Set(['recordId', 'version', 'updatedAt', ...QUERY_FIELDS]);

export class DeliveryStore {
  get capabilities() {
    return {
      durable: false,
      transactional: false,
      compareAndSet: false,
      nonMutatingRead: false,
      query: false,
      processOwned: false,
    };
  }
  async initialize() {}
  async get() { throw new Error('DeliveryStore.get() is not implemented'); }
  async list() { throw new Error('DeliveryStore.list() is not implemented'); }
  async query() { throw new Error('DeliveryStore.query() is not implemented'); }
  async count() { throw new Error('DeliveryStore.count() is not implemented'); }
  async findMaintenance() { throw new Error('DeliveryStore.findMaintenance() is not implemented'); }
  async findPausedMaintenance() { throw new Error('DeliveryStore.findPausedMaintenance() is not implemented'); }
  async transact() { throw new Error('DeliveryStore.transact() is not implemented'); }
  async close() {}
}

export class MemoryDeliveryStore extends DeliveryStore {
  constructor({ durable = false, processOwned = true, initialState } = {}) {
    super();
    this._state = normalizeInitialState(initialState);
    this._durable = durable;
    this._processOwned = processOwned;
    this._tail = Promise.resolve();
  }

  get capabilities() {
    return {
      durable: this._durable,
      transactional: true,
      compareAndSet: true,
      nonMutatingRead: true,
      query: true,
      processOwned: this._processOwned,
    };
  }

  async get(table, id) {
    validateTableAndId(table, id);
    return clone(this._state.tables[table]?.[id] ?? null);
  }

  async list(table, predicate = () => true) {
    validateTable(table);
    const values = Object.values(this._state.tables[table] ?? {}).filter(predicate);
    return clone(values);
  }

  async query(table, filters = {}, options = {}) {
    validateTable(table);
    return queryMemoryRecords(this._state.tables[table] ?? {}, filters, options);
  }

  async count(table, filters = {}) {
    validateTable(table);
    return countMemoryRecords(this._state.tables[table] ?? {}, filters);
  }

  async findMaintenance(channelId, { claimableOnly = false } = {}) {
    validateTableAndId('maintenance_outbox', channelId);
    return clone(selectMaintenance(
      Object.values(this._state.tables.maintenance_outbox ?? {}),
      channelId,
      { claimableOnly, pauseOverrideOnly: false },
    ));
  }

  async findPausedMaintenance(channelId, { claimableOnly = false } = {}) {
    validateTableAndId('maintenance_outbox', channelId);
    return clone(selectMaintenance(
      Object.values(this._state.tables.maintenance_outbox ?? {}),
      channelId,
      { claimableOnly, pauseOverrideOnly: true },
    ));
  }

  async transact(callback) {
    return this._enqueue(async () => {
      const draft = clone(this._state);
      const tx = createTransaction(draft);
      const result = callback(tx);
      if (result && typeof result.then === 'function') {
        throw new Error('DeliveryStore transactions must be synchronous; perform external I/O outside the transaction');
      }
      this._state = draft;
      return clone(result);
    });
  }

  _enqueue(operation) {
    const current = this._tail.then(operation);
    this._tail = current.catch(() => {});
    return current;
  }
}

export class LocalFileDeliveryStore extends MemoryDeliveryStore {
  constructor(path = './.cache/delivery-state.json', options = {}) {
    super({ durable: true, processOwned: true });
    this._path = path;
    this._lockPath = `${path}.lock`;
    this._fs = options.fs ?? null;
    this._processIdentityReader = options.processIdentityReader ?? readProcessStartIdentity;
    this._ownerToken = options.ownerToken ?? crypto.randomUUID();
    this._ownerLockPath = `${this._lockPath}.owner.${crypto.randomUUID()}`;
    this._ownerCandidatePath = `${this._lockPath}.candidate.${crypto.randomUUID()}`;
    this._initialized = false;
    this._readOnly = false;
    this._lockHandle = null;
    this._initializing = null;
    this._durabilityFailure = null;
    this._processStartedAt = options.processStartedAt
      ?? new Date(Date.now() - process.uptime() * 1_000).toISOString();
  }

  async initialize({ readOnly = false } = {}) {
    while (this._initializing) await this._initializing;
    if (this._durabilityFailure && this._initialized) throw this._durabilityFailure;
    if (this._initialized && (!this._readOnly || readOnly)) return;
    const operation = this._initialize({ readOnly });
    this._initializing = operation;
    try {
      await operation;
    } finally {
      if (this._initializing === operation) this._initializing = null;
    }
  }

  async _initialize({ readOnly }) {
    const fs = await this._getFs();
    if (readOnly) {
      this._state = await readDurableState(fs, this._path);
      this._initialized = true;
      this._readOnly = true;
      this._durabilityFailure = null;
      return;
    }
    const { dirname } = await import('node:path');
    await fs.mkdir(dirname(this._path), { recursive: true, mode: 0o700 });
    try {
      await this._acquireOwnerLock(fs);
      this._state = await readDurableState(fs, this._path);
      this._initialized = true;
      this._readOnly = false;
      this._durabilityFailure = null;
    } catch (error) {
      await this._releaseOwnerLock(fs);
      throw error;
    }
  }

  async get(table, id) {
    this._assertInitialized();
    return super.get(table, id);
  }

  async list(table, predicate = () => true) {
    this._assertInitialized();
    return super.list(table, predicate);
  }

  async query(table, filters = {}, options = {}) {
    this._assertInitialized();
    return super.query(table, filters, options);
  }

  async count(table, filters = {}) {
    this._assertInitialized();
    return super.count(table, filters);
  }

  async findMaintenance(channelId, options = {}) {
    this._assertInitialized();
    return super.findMaintenance(channelId, options);
  }

  async findPausedMaintenance(channelId, options = {}) {
    this._assertInitialized();
    return super.findPausedMaintenance(channelId, options);
  }

  async transact(callback) {
    this._assertInitialized();
    if (this._readOnly) throw new Error('Read-only delivery store cannot mutate durable state');
    return this._enqueue(async () => {
      this._assertInitialized();
      if (this._readOnly) throw new Error('Read-only delivery store cannot mutate durable state');
      const durableBefore = this._state;
      const draft = clone(durableBefore);
      const tx = createTransaction(draft);
      const result = callback(tx);
      if (result && typeof result.then === 'function') {
        throw new Error('DeliveryStore transactions must be synchronous; perform external I/O outside the transaction');
      }
      await this._commit(draft);
      this._state = draft;
      return clone(result);
    });
  }

  async close() {
    await this._tail.catch(() => {});
    if (this._lockHandle) {
      const fs = await this._getFs();
      await this._releaseOwnerLock(fs);
    }
    this._initialized = false;
    this._readOnly = false;
  }

  async _commit(candidate) {
    const fs = await this._getFs();
    const { basename, dirname, join } = await import('node:path');
    const directory = dirname(this._path);
    const temporary = join(directory, `.${basename(this._path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    let renamed = false;
    try {
      compactDurableState(candidate);
      assertBoundedRecord(candidate, MAX_DURABLE_STATE_BYTES);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(candidate, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this._path);
      renamed = true;
      try {
        const directoryHandle = await fs.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        // Some platforms do not support syncing directory descriptors.
        if (!isUnsupportedDirectorySyncError(error)) throw error;
      }
    } catch (error) {
      try { if (handle) await handle.close(); } catch {}
      try { await fs.unlink(temporary); } catch {}
      try {
        this._state = await readDurableState(fs, this._path, { allowMissing: !renamed });
      } catch (recoveryError) {
        this._state = null;
        this._durabilityFailure = new Error(
          'Delivery store durable recovery failed; the instance is quarantined until it is closed and reinitialized',
          { cause: recoveryError },
        );
        throw this._durabilityFailure;
      }
      throw error;
    }
  }

  async _acquireOwnerLock(fs) {
    const currentProcessIdentity = await this._readProcessIdentity(fs, process.pid);
    const processStartedAt = this._processStartedAt;
    const payload = JSON.stringify({
      pid: process.pid,
      ownerToken: this._ownerToken,
      processStartedAt,
      processStartIdentity: currentProcessIdentity?.identity ?? null,
      acquiredAt: new Date().toISOString(),
    });
    let candidateHandle;
    try {
      candidateHandle = await fs.open(this._ownerCandidatePath, 'wx', 0o600);
      await candidateHandle.writeFile(payload, 'utf8');
      await candidateHandle.sync();
      await candidateHandle.close();
      candidateHandle = null;
      await fs.rename(this._ownerCandidatePath, this._ownerLockPath);
      this._lockHandle = await fs.open(this._ownerLockPath, 'r');
      const { basename, dirname, join } = await import('node:path');
      const directory = dirname(this._lockPath);
      const ownerPrefix = `${basename(this._lockPath)}.owner.`;
      const names = await fs.readdir(directory);
      for (const name of names) {
        if (!name.startsWith(ownerPrefix)) continue;
        const peerPath = join(directory, name);
        if (peerPath === this._ownerLockPath) continue;
        const owner = await readOwnerLock(fs, peerPath);
        const observedProcessIdentity = await this._readProcessIdentity(fs, owner.pid);
        if (isOwnerProcessLive(owner, processStartedAt, {
          currentProcessIdentity,
          observedProcessIdentity,
        })) {
          throw new Error(`Delivery store owner lock is owned by another live process (${owner.pid})`);
        }
        try {
          await fs.unlink(peerPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await this._claimLegacyOwnerLock(fs, processStartedAt, currentProcessIdentity);
    } catch (error) {
      try { if (candidateHandle) await candidateHandle.close(); } catch {}
      try { await fs.unlink(this._ownerCandidatePath); } catch {}
      await this._releaseOwnerLock(fs);
      throw error;
    }
  }

  async _claimLegacyOwnerLock(fs, processStartedAt, currentProcessIdentity) {
    // New runtimes retain the canonical lock as a hard link so an older binary
    // cannot start beside the owner-file protocol. Automatic conversion of a
    // stale canonical lock assumes the older runtime has been quiesced first.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.link(this._ownerLockPath, this._lockPath);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const owner = await readOwnerLock(fs, this._lockPath);
      if (owner.ownerToken === this._ownerToken) return;
      const observedProcessIdentity = await this._readProcessIdentity(fs, owner.pid);
      if (isOwnerProcessLive(owner, processStartedAt, {
        currentProcessIdentity,
        observedProcessIdentity,
      })) {
        throw new Error(`Delivery store owner lock is owned by another live process (${owner.pid})`);
      }
      const confirmed = await readOwnerLock(fs, this._lockPath);
      if (confirmed.ownerToken !== owner.ownerToken) continue;
      const confirmedIdentity = await this._readProcessIdentity(fs, confirmed.pid);
      if (isOwnerProcessLive(confirmed, processStartedAt, {
        currentProcessIdentity,
        observedProcessIdentity: confirmedIdentity,
      })) {
        throw new Error(`Delivery store owner lock is owned by another live process (${confirmed.pid})`);
      }
      const stalePath = `${this._lockPath}.stale.${Date.now()}.${crypto.randomUUID()}`;
      try {
        await fs.rename(this._lockPath, stalePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Unable to recover stale delivery store owner lock');
      }
    }
    throw new Error('Unable to claim the legacy delivery store owner lock');
  }

  async _releaseOwnerLock(fs) {
    if (this._lockHandle) {
      try { await this._lockHandle.close(); } catch {}
      this._lockHandle = null;
    }
    try {
      const legacyOwner = await readOwnerLock(fs, this._lockPath);
      if (legacyOwner.ownerToken === this._ownerToken) await fs.unlink(this._lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const owner = await readOwnerLock(fs, this._ownerLockPath);
      if (owner.ownerToken === this._ownerToken) await fs.unlink(this._ownerLockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async _getFs() {
    return this._fs ?? await import('node:fs/promises');
  }

  async _readProcessIdentity(fs, pid) {
    try {
      return normalizeProcessIdentity(await this._processIdentityReader(pid, { fs }));
    } catch {
      return null;
    }
  }

  _assertInitialized() {
    if (this._durabilityFailure) throw this._durabilityFailure;
    if (!this._initialized) throw new Error('LocalFileDeliveryStore.initialize() must succeed before use');
  }
}

export function isUnsupportedDirectorySyncError(error) {
  return ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM'].includes(error?.code);
}

export function assertDeliveryStore(store, { allowEphemeral = false } = {}) {
  if (!store
    || typeof store.get !== 'function'
    || typeof store.query !== 'function'
    || typeof store.count !== 'function'
    || typeof store.transact !== 'function') {
    throw new Error('A DeliveryStore is required before delivery');
  }
  const capabilities = store.capabilities ?? {};
  for (const capability of ['transactional', 'compareAndSet', 'nonMutatingRead', 'query', 'processOwned']) {
    if (capabilities[capability] !== true) {
      throw new Error(`DeliveryStore lacks required ${capability} capability`);
    }
  }
  if (!allowEphemeral && capabilities.durable !== true) {
    throw new Error('A durable DeliveryStore is required before non-dry delivery');
  }
  return store;
}

function createTransaction(state) {
  return Object.freeze({
    get(table, id) {
      validateTableAndId(table, id);
      return clone(state.tables[table]?.[id] ?? null);
    },
    list(table, predicate = () => true) {
      validateTable(table);
      return clone(Object.values(state.tables[table] ?? {}).filter(predicate));
    },
    query(table, filters = {}, options = {}) {
      validateTable(table);
      return queryMemoryRecords(state.tables[table] ?? {}, filters, options);
    },
    count(table, filters = {}) {
      validateTable(table);
      return countMemoryRecords(state.tables[table] ?? {}, filters);
    },
    put(table, id, record, { expectedVersion } = {}) {
      validateTableAndId(table, id);
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('DeliveryStore record must be an object');
      }
      const records = state.tables[table] ??= {};
      const current = records[id] ?? null;
      const currentVersion = current?.version ?? 0;
      if (expectedVersion === undefined || expectedVersion !== currentVersion) {
        throw new Error(`DeliveryStore version conflict for ${table}/${id}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      const next = clone({ ...record, version: currentVersion + 1 });
      assertBoundedRecord(next);
      records[id] = next;
      return clone(next);
    },
    delete(table, id, { expectedVersion } = {}) {
      validateTableAndId(table, id);
      const records = state.tables[table] ?? {};
      const currentVersion = records[id]?.version ?? 0;
      if (expectedVersion === undefined || expectedVersion !== currentVersion) {
        throw new Error(`DeliveryStore version conflict for ${table}/${id}: expected ${expectedVersion}, current ${currentVersion}`);
      }
      delete records[id];
    },
  });
}

function normalizeInitialState(value) {
  if (!value) return { schemaVersion: SCHEMA_VERSION, tables: {} };
  const state = clone(value);
  validateState(state);
  return state;
}

async function readDurableState(fs, path, { allowMissing = true } = {}) {
  let raw;
  try { raw = await fs.readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return normalizeInitialState();
    throw new Error(`Delivery state is unreadable: ${error.message}`);
  }
  try {
    const state = JSON.parse(raw);
    validateState(state);
    return state;
  } catch (error) {
    throw new Error(`Delivery state is corrupt or invalid: ${error.message}`);
  }
}

function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !state.tables || typeof state.tables !== 'object' || Array.isArray(state.tables)) {
    throw new Error(`Expected delivery state schemaVersion ${SCHEMA_VERSION}`);
  }
  assertBoundedRecord(state, MAX_DURABLE_STATE_BYTES);
}

function compactDurableState(state, now = Date.now()) {
  const tables = state.tables ?? {};
  const isOld = (record, days) => {
    const timestamp = Date.parse(
      record?.updatedAt
      ?? record?.completed_at
      ?? record?.finished_at
      ?? record?.createdAt
      ?? record?.requested_at
      ?? '',
    );
    return Number.isFinite(timestamp) && timestamp < now - days * DAY_MS;
  };

  const batches = tables.day_batches ?? {};
  const batchItems = tables.batch_items ?? {};
  const deliveries = tables.deliveries ?? {};
  for (const [batchId, batch] of Object.entries(batches)) {
    if (!isOld(batch, 90)) continue;
    const items = Object.entries(batchItems).filter(([, item]) => item.batchId === batchId);
    const allTerminal = items.every(([, item]) => ['succeeded', 'abandoned'].includes(deliveries[item.deliveryId]?.state));
    if (!allTerminal) continue;
    for (const [itemId] of items) delete batchItems[itemId];
    delete batches[batchId];
  }

  const prunedDeliveryIds = new Set();
  for (const [deliveryId, delivery] of Object.entries(deliveries)) {
    if (!['succeeded', 'abandoned'].includes(delivery.state) || !isOld(delivery, 30)) continue;
    if (delivery.forceKind) deliveries[deliveryId] = compactLocalDeliveryTombstone(delivery);
    else delete deliveries[deliveryId];
    prunedDeliveryIds.add(deliveryId);
  }
  for (const [outputId, output] of Object.entries(tables.delivery_outputs ?? {})) {
    if (prunedDeliveryIds.has(output.deliveryId)) delete tables.delivery_outputs[outputId];
  }
  for (const [attemptId, attempt] of Object.entries(tables.attempts ?? {})) {
    if (prunedDeliveryIds.has(attempt.deliveryId) && attempt.state !== 'attempting') delete tables.attempts[attemptId];
  }
  for (const [reservationId, reservation] of Object.entries(tables.delivery_reservations ?? {})) {
    if (prunedDeliveryIds.has(reservation.deliveryId) && isOld(reservation, 90)) {
      delete tables.delivery_reservations[reservationId];
    }
  }
  for (const [itemId, item] of Object.entries(tables.batch_items ?? {})) {
    if (prunedDeliveryIds.has(item.deliveryId)) delete tables.batch_items[itemId];
  }
  for (const [outboxId, outbox] of Object.entries(tables.maintenance_outbox ?? {})) {
    if (outbox.state === 'succeeded' && isOld(outbox, 30)) delete tables.maintenance_outbox[outboxId];
  }

  for (const [requestId, request] of Object.entries(tables.requests ?? {})) {
    if (!['completed', 'blocked'].includes(request.state) || !isOld(request, 90)) continue;
    if (!['force', 'canary', 'operator_retry'].includes(request.triggerType)) {
      delete tables.requests[requestId];
      continue;
    }
    tables.requests[requestId] = {
      requestId: request.requestId,
      channelId: request.channelId,
      triggerType: request.triggerType,
      state: request.state,
      outcome: request.outcome,
      reason: request.reason,
      result: compactRequestResult(request.result, request.deliveryId),
      payloadFingerprint: request.payloadFingerprint,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      version: request.version,
      retentionStatus: 'compacted',
      compacted: true,
    };
  }
  for (const [actionId, action] of Object.entries(tables.operator_actions ?? {})) {
    const agedOut = isOld(action, 365);
    const needsDataMinimization = Object.hasOwn(action, 'reason')
      || Boolean(action.result?.delivery || action.result?.articles || action.result?.content
        || action.result?.attempt || action.result?.outbox);
    if (!agedOut && !needsDataMinimization) continue;
    tables.operator_actions[actionId] = {
      actionId: action.actionId,
      action: action.action,
      deliveryId: action.deliveryId,
      outputKey: action.outputKey,
      outboxId: action.outboxId,
      channelId: action.channelId,
      requestId: action.requestId,
      operatorId: action.operatorId,
      reasonHash: action.reasonHash,
      duplicateRiskAckHash: action.duplicateRiskAckHash,
      duplicateRiskAccepted: action.duplicateRiskAccepted,
      payloadFingerprint: action.payloadFingerprint,
      state: agedOut ? 'compacted' : 'minimized',
      createdAt: action.createdAt,
      updatedAt: new Date(now).toISOString(),
      version: action.version,
      result: compactOperatorResult(action.result),
      compacted: action.compacted === true || agedOut,
    };
  }

  for (const [runId, run] of Object.entries(tables.dashboard_runs ?? {})) {
    if (run.status !== 'running' && isOld(run, 90)) delete tables.dashboard_runs[runId];
  }
  for (const [actionId, action] of Object.entries(tables.dashboard_force_actions ?? {})) {
    if (action.status !== 'completed' || action.compacted || !isOld(action, 90)) continue;
    tables.dashboard_force_actions[actionId] = {
      kind: action.kind,
      stream_id: action.stream_id,
      target_channel_id: action.target_channel_id,
      target_request_id: action.target_request_id,
      engine_idempotency_id: action.engine_idempotency_id,
      actor_key_id: action.actor_key_id,
      reason_hash: action.reason_hash,
      duplicate_risk_acknowledgement_hash: action.duplicate_risk_acknowledgement_hash,
      key_hash: action.key_hash,
      payload_hash: action.payload_hash,
      run_id: action.run_id,
      status: action.status,
      result: compactForceResult(action.result),
      requested_at: action.requested_at,
      completed_at: action.completed_at,
      compacted: true,
      version: action.version,
    };
  }
  for (const [actionId, action] of Object.entries(tables.local_force_actions ?? {})) {
    if (action.status !== 'completed' || action.compacted || !isOld(action, 90)) continue;
    tables.local_force_actions[actionId] = {
      kind: action.kind,
      action_id: action.action_id,
      target_channel_id: action.target_channel_id,
      target_request_id: action.target_request_id,
      engine_idempotency_id: action.engine_idempotency_id,
      actor_key_id: action.actor_key_id,
      reason_hash: action.reason_hash,
      duplicate_risk_acknowledgement_hash: action.duplicate_risk_acknowledgement_hash,
      payload_fingerprint: action.payload_fingerprint,
      status: action.status,
      result: compactForceResult(action.result),
      requested_at: action.requested_at,
      completed_at: action.completed_at,
      compacted: true,
      version: action.version,
    };
  }
}

function compactOperatorResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    status: result.status,
    outcome: result.outcome ?? null,
    requestId: result.requestId ?? null,
    deliveryId: result.delivery?.deliveryId ?? result.deliveryId ?? null,
    deliveryState: result.delivery?.state ?? result.deliveryState ?? null,
    deliveryVersion: result.delivery?.version ?? result.deliveryVersion ?? null,
    outputKey: result.output?.outputKey ?? result.outputKey ?? null,
    outboxId: result.outbox?.outboxId ?? result.outboxId ?? null,
    attemptId: result.attemptId ?? result.attempt?.attemptId ?? null,
  };
}

function compactLocalDeliveryTombstone(delivery) {
  if (delivery.compacted) return delivery;
  return {
    deliveryId: delivery.deliveryId,
    channelId: delivery.channelId,
    requestId: delivery.requestId,
    mode: delivery.mode,
    publishingDay: delivery.publishingDay,
    forceKind: delivery.forceKind,
    singleMutation: delivery.singleMutation === true,
    topologyFingerprint: delivery.topologyFingerprint,
    state: delivery.state,
    reason: delivery.reason ?? null,
    articleHashes: delivery.articleHashes ?? [],
    contentChecksum: delivery.contentChecksum ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    retentionStatus: 'compacted',
    compacted: true,
    version: delivery.version,
  };
}

function compactRequestResult(result, deliveryId) {
  if (!result || typeof result !== 'object') return deliveryId ? { deliveryId } : null;
  return {
    status: result.status ?? null,
    reason: result.reason ?? null,
    deliveryId: result.deliveryId ?? deliveryId ?? null,
    deliveryState: result.deliveryState ?? null,
    deliveryVersion: result.deliveryVersion ?? null,
    outputKey: result.outputKey ?? null,
  };
}

function compactForceResult(result) {
  if (Array.isArray(result)) return result.slice(0, 10).map(compactForceResult);
  if (!result || typeof result !== 'object') return result;
  return {
    id: result.id ?? null,
    channelId: result.channelId ?? result.stream_id ?? null,
    status: result.status ?? null,
    reason: result.reason ?? null,
    deliveryId: result.deliveryId ?? null,
    stats: result.stats && typeof result.stats === 'object' ? result.stats : null,
  };
}

function assertBoundedRecord(record, maximum = 512 * 1024) {
  let json;
  try { json = JSON.stringify(record); }
  catch { throw new Error('DeliveryStore record must be serializable'); }
  if (new TextEncoder().encode(json).byteLength > maximum) {
    throw new Error(`DeliveryStore record exceeds ${maximum} bytes`);
  }
}

async function readOwnerLock(fs, path) {
  try {
    const owner = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || !owner.ownerToken
      || (owner.processStartIdentity !== undefined
        && owner.processStartIdentity !== null
        && (typeof owner.processStartIdentity !== 'string' || owner.processStartIdentity.length > 500))) {
      throw new Error('invalid lock');
    }
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new Error('Delivery store owner lock is corrupt; manual recovery is required');
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function queryMemoryRecords(records, filters, options) {
  validateMemoryQueryFilters(filters);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('DeliveryStore query options must be an object');
  }
  for (const field of Object.keys(options)) {
    if (!['orderBy', 'direction', 'limit', 'offset'].includes(field)) {
      throw new Error(`Unsupported DeliveryStore query option: ${field}`);
    }
  }
  const orderBy = options.orderBy ?? 'recordId';
  if (!QUERY_ORDER_FIELDS.has(orderBy)) throw new Error(`Unsupported DeliveryStore query order: ${orderBy}`);
  const direction = options.direction ?? 'asc';
  if (!['asc', 'desc'].includes(direction)) throw new Error('DeliveryStore query direction must be "asc" or "desc"');
  const limit = options.limit ?? 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('DeliveryStore query limit must be an integer between 1 and 1000');
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new Error('DeliveryStore query offset must be an integer between 0 and 1000000');
  }

  const matches = Object.entries(records).filter(([, record]) => memoryRecordMatches(record, filters));
  const multiplier = direction === 'asc' ? 1 : -1;
  matches.sort(([leftId, left], [rightId, right]) => {
    const leftValue = orderBy === 'recordId' ? leftId : left[orderBy] ?? '';
    const rightValue = orderBy === 'recordId' ? rightId : right[orderBy] ?? '';
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));
    return comparison === 0 ? leftId.localeCompare(rightId) * multiplier : comparison * multiplier;
  });
  return clone(matches.slice(offset, offset + limit).map(([, record]) => record));
}

function countMemoryRecords(records, filters) {
  validateMemoryQueryFilters(filters);
  return Object.values(records).filter(record => memoryRecordMatches(record, filters)).length;
}

function selectMaintenance(records, channelId, { claimableOnly, pauseOverrideOnly }) {
  const eligibleStates = claimableOnly
    ? new Set(['pending', 'retry_pending'])
    : new Set(['pending', 'retry_pending', 'attempting']);
  return records
    .filter(record => (
      record.channelId === channelId
      && eligibleStates.has(record.state)
      && (!pauseOverrideOnly || (
        typeof record.pauseOverrideActionId === 'string'
        && record.pauseOverrideActionId.length > 0
      ))
    ))
    .sort((left, right) => {
      const leftTime = maintenanceRepairTime(left);
      const rightTime = maintenanceRepairTime(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.outboxId ?? '').localeCompare(String(right.outboxId ?? ''));
    })[0] ?? null;
}

function maintenanceRepairTime(record) {
  const value = record.state === 'attempting' ? record.deadlineAt : record.nextAttemptAt;
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function validateMemoryQueryFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('DeliveryStore query filters must be an object');
  }
  for (const field of Object.keys(filters)) {
    if (!QUERY_FIELDS.has(field)) throw new Error(`Unsupported DeliveryStore query filter: ${field}`);
    const value = filters[field];
    if (field === 'state' && Array.isArray(value)) {
      if (value.length > 32) throw new Error('DeliveryStore state filter cannot exceed 32 values');
      for (const state of value) validateQueryValue(state, field);
    } else if (Array.isArray(value)) {
      throw new Error(`DeliveryStore query filter ${field} does not accept arrays`);
    } else if (value !== null) {
      validateQueryValue(value, field);
    }
  }
}

function memoryRecordMatches(record, filters) {
  return Object.entries(filters).every(([field, expected]) => {
    const actual = record[field] ?? null;
    if (field === 'state' && Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

function validateQueryValue(value, field) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error(`Invalid DeliveryStore query filter ${field}`);
  }
}

export function isOwnerProcessLive(owner, currentProcessStartedAt, {
  currentProcessIdentity = null,
  observedProcessIdentity = null,
} = {}) {
  if (!isProcessAlive(owner?.pid)) return false;

  const recordedIdentity = normalizeProcessIdentity({ identity: owner.processStartIdentity });
  const observedIdentity = normalizeProcessIdentity(observedProcessIdentity);
  if (recordedIdentity?.identity && observedIdentity?.identity) {
    return recordedIdentity.identity === observedIdentity.identity;
  }

  if (owner.pid !== process.pid) {
    if (observedIdentity?.startedAt) {
      return processStartedAtMatches(owner.processStartedAt, observedIdentity.startedAt);
    }
    // A live foreign PID is treated as the owner unless its start identity can
    // positively prove that the PID has been reused.
    return true;
  }

  const normalizedCurrentIdentity = normalizeProcessIdentity(currentProcessIdentity);
  if (recordedIdentity?.identity && normalizedCurrentIdentity?.identity) {
    return recordedIdentity.identity === normalizedCurrentIdentity.identity;
  }
  return processStartedAtMatches(owner.processStartedAt, currentProcessStartedAt);
}

function processStartedAtMatches(recorded, observed) {
  const ownerStartedAt = Date.parse(recorded ?? '');
  const currentStartedAt = Date.parse(observed ?? '');
  if (!Number.isFinite(ownerStartedAt) || !Number.isFinite(currentStartedAt)) return true;
  return Math.abs(ownerStartedAt - currentStartedAt) < 5_000;
}

function normalizeProcessIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const identity = typeof value.identity === 'string' && value.identity.length <= 500
    ? value.identity
    : null;
  const startedAt = typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
    ? new Date(value.startedAt).toISOString()
    : null;
  return identity || startedAt ? { identity, startedAt } : null;
}

async function readProcessStartIdentity(pid, { fs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    const filesystem = fs ?? await import('node:fs/promises');
    try {
      const [stat, bootId] = await Promise.all([
        filesystem.readFile(`/proc/${pid}/stat`, 'utf8'),
        filesystem.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks) || !bootId.trim()) return null;
      return { identity: `linux:${bootId.trim()}:${startTicks}`, startedAt: null };
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  try {
    const { execFile } = await import('node:child_process');
    const stdout = await new Promise((resolve, reject) => {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2_000,
        env: { ...process.env, LC_ALL: 'C' },
      }, (error, output) => error ? reject(error) : resolve(output));
    });
    const startedAtMs = Date.parse(stdout.trim());
    if (!Number.isFinite(startedAtMs)) return null;
    const startedAt = new Date(startedAtMs).toISOString();
    return { identity: `darwin:${startedAt}`, startedAt };
  } catch {
    return null;
  }
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

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
