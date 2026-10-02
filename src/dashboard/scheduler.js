/** Per-stream cron scheduler with persistent, redacted run summaries. */

import { createHash, randomUUID } from 'node:crypto';
import cronModule from 'node-cron';

import { projectSelectionStats } from '../core/delivery.js';
import { assertDeliveryStore } from '../core/delivery-store.js';
import {
  deriveLocalForceIdentifiers,
  listUnresolvedTargets as readUnresolvedTargets,
  sanitizeRuntimeError,
  validateCronExpression,
} from '../channels/runner.js';
import {
  executeStream as defaultExecuteStream,
  executeStreamControl as defaultExecuteStreamControl,
} from './stream-runner.js';

const MAX_HISTORY = 200;
const RUNS_TABLE = 'dashboard_runs';
const FORCE_ACTIONS_TABLE = 'dashboard_force_actions';
const CONTROL_ACTIONS = new Set([
  'pause', 'resume', 'retry-generation', 'retry-output',
  'restore-topology', 'confirm-delivered', 'abandon', 'retry-maintenance',
]);

export function createScheduler(dependencies = {}) {
  const runtime = { ...dependencies };
  const jobs = new Map();
  const running = new Set();
  const runs = [];
  const streams = new Map();
  const pendingForces = new Map();
  const activeOperations = new Set();
  let eventEmitter = null;
  let accepting = false;
  let shutdownPromise = null;

  function logger() { return runtime.logger ?? console; }
  function now() { return (runtime.clock ?? (() => new Date()))(); }
  function emit(type, data) {
    if (eventEmitter) eventEmitter({ type, data, time: now().toISOString() });
  }

  function setEventEmitter(fn) { eventEmitter = fn; }

  function listStreams() {
    return [...streams.values()].map(stream => ({
      ...stream,
      is_running: running.has(stream.id),
      is_scheduled: jobs.has(stream.id),
      last_run: getLastRun(stream.id),
    }));
  }

  function getStream(id) {
    const stream = streams.get(id);
    if (!stream) return null;
    return {
      ...stream,
      is_running: running.has(id),
      is_scheduled: jobs.has(id),
      last_run: getLastRun(id),
    };
  }

  function getLastRun(streamId) {
    return runs.find(run => run.stream_id === streamId) ?? null;
  }

  function listRuns(streamId, limit = 20, offset = 0) {
    const safeLimit = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 20));
    const safeOffset = Math.max(0, Number.isSafeInteger(offset) ? offset : 0);
    const filtered = runs.filter(run => run.stream_id === streamId);
    return { runs: filtered.slice(safeOffset, safeOffset + safeLimit), total: filtered.length };
  }

  function getRun(id) {
    return runs.find(run => run.id === id) ?? null;
  }

  async function listUnresolvedTargets(streamId, options = {}) {
    if (!streams.has(streamId)) return null;
    return readUnresolvedTargets(runtime.deliveryStore, streamId, options);
  }

  async function persistRun(run) {
    const store = runtime.deliveryStore;
    const persisted = await store.transact(tx => {
      const current = tx.get(RUNS_TABLE, run.id);
      const candidate = { ...run };
      delete candidate.version;
      return tx.put(RUNS_TABLE, run.id, candidate, { expectedVersion: current?.version ?? 0 });
    });
    const index = runs.findIndex(value => value.id === persisted.id);
    if (index === -1) runs.unshift(persisted);
    else runs[index] = persisted;
    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    if (runs.length > MAX_HISTORY) runs.length = MAX_HISTORY;
    return persisted;
  }

  async function addRun(streamId, triggerType, idempotency = null, requestedAt = now(), runId = null) {
    const run = {
      id: runId || String((runtime.idFactory ?? randomUUID)()),
      kind: 'dashboard_run',
      stream_id: streamId,
      status: 'running',
      reason: null,
      trigger_type: triggerType,
      stats: null,
      ai_usage: null,
      output_results: [],
      output_summary: { total: 0, succeeded: 0, failed: 0 },
      error: null,
      started_at: requestedAt.toISOString(),
      finished_at: null,
      ...(idempotency ?? {}),
    };
    return persistRun(run);
  }

  async function completeRun(runId, result) {
    const run = runs.find(value => value.id === runId)
      ?? await runtime.deliveryStore.get(RUNS_TABLE, runId);
    if (!run) return null;
    const outputs = Array.isArray(result.outputs) ? result.outputs.map(projectOutput) : [];
    const completed = {
      ...run,
      status: result.status || 'success',
      reason: result.reason ? bounded(sanitizeRuntimeError(result.reason), 200) : null,
      stats: projectStats(result.stats),
      ai_usage: projectUsage(result.aiUsage),
      output_results: outputs,
      output_summary: {
        total: outputs.length,
        succeeded: outputs.filter(output => output.success).length,
        failed: outputs.filter(output => !output.success).length,
      },
      error: result.error ? bounded(sanitizeRuntimeError(result.error), 500) : null,
      finished_at: now().toISOString(),
    };
    return persistRun(completed);
  }

  async function performRunStream(streamId, options = {}) {
    const normalized = typeof options === 'string' ? { triggerType: options } : options;
    const triggerType = normalized.triggerType || 'manual';
    if (!['scheduled', 'manual', 'force'].includes(triggerType)) {
      return { status: 'error', error: `Invalid trigger type: ${triggerType}` };
    }
    if (triggerType === 'force' && normalized._operatorForce !== true) {
      return { status: 'error', error: 'Use forceStream for operator force' };
    }
    if (running.has(streamId)) return { status: 'skipped', reason: 'already_running' };

    const stream = streams.get(streamId);
    if (!stream) return { status: 'error', error: 'Stream not found' };
    if (!stream.enabled) return { status: 'skipped', reason: 'stream_disabled' };

    running.add(streamId);
    const requestedAt = normalized.requestedAt ?? now();
    let run;
    try {
      run = await addRun(streamId, triggerType, normalized.idempotency, requestedAt, normalized.runId);
      emit('run:started', { streamId, runId: run.id, trigger: triggerType });
      const executeStream = runtime.executeStream ?? defaultExecuteStream;
      const result = await executeStream(stream, {
        triggerType,
        force: triggerType === 'force',
        ...(normalized.idempotencyKey && { idempotencyKey: normalized.idempotencyKey }),
        ...(normalized.requestId && { requestId: normalized.requestId }),
        requestedAt,
      }, {
        cache: runtime.cache,
        deliveryStore: runtime.deliveryStore,
        clock: runtime.clock,
        env: runtime.env,
      });
      const completed = await completeRun(run.id, result);
      emit('run:completed', {
        streamId, runId: run.id, status: result.status,
        reason: result.reason, stats: projectStats(result.stats),
      });
      return completed;
    } catch (error) {
      if (!run) return { status: 'error', error: sanitizeRuntimeError(error) };
      const completed = await completeRun(run.id, { status: 'error', error: sanitizeRuntimeError(error) });
      emit('run:completed', { streamId, runId: run.id, status: 'error' });
      return completed;
    } finally {
      running.delete(streamId);
    }
  }

  function runStream(streamId, options = {}) {
    if (!accepting) return Promise.resolve({ status: 'skipped', reason: 'shutting_down' });
    return trackOperation(performRunStream(streamId, options));
  }

  async function forceStream(streamId, options = {}) {
    if (typeof options.idempotencyKey !== 'string'
      || options.idempotencyKey.length === 0
      || options.idempotencyKey.length > 200
      || !/^[\x21-\x7e]+$/.test(options.idempotencyKey)) {
      throw new Error('Force requires a valid idempotency key');
    }
    if (options.confirmDuplicateRisk !== true) throw new Error('Force requires duplicate-risk acknowledgement');
    const actorKeyId = requiredText(options.operatorId, 'Force actor key id', 100);
    const reason = requiredText(options.reason, 'Force reason', 500);
    if (!accepting) return { status: 'skipped', reason: 'shutting_down' };
    const identifiers = await deriveLocalForceIdentifiers(streamId, options.idempotencyKey);
    const keyHash = identifiers.idempotencyKey;
    const reasonHash = hashValue(reason);
    const duplicateRiskAcknowledgementHash = hashValue('duplicate-risk-accepted');
    const payloadHash = hashValue(JSON.stringify({
      streamId,
      requestId: identifiers.requestId,
      idempotencyId: identifiers.idempotencyKey,
      actorKeyId,
      reasonHash,
      duplicateRiskAcknowledgementHash,
    }));
    const claimKey = `${streamId}:${keyHash}`;
    const pending = pendingForces.get(claimKey);
    if (pending) {
      if (pending.payloadHash !== payloadHash) throw new Error('Idempotency key conflicts with a different force payload');
      return pending.promise;
    }
    const promise = trackOperation(performForceStream({
      streamId,
      identifiers,
      actorKeyId,
      reasonHash,
      duplicateRiskAcknowledgementHash,
      keyHash,
      payloadHash,
      claimKey,
    }));
    pendingForces.set(claimKey, { payloadHash, promise });
    try { return await promise; }
    finally { pendingForces.delete(claimKey); }
  }

  async function performForceStream({
    streamId,
    identifiers,
    actorKeyId,
    reasonHash,
    duplicateRiskAcknowledgementHash,
    keyHash,
    payloadHash,
    claimKey,
  }) {
    const requestedAt = now();
    const proposedRunId = String((runtime.idFactory ?? randomUUID)());
    let action = await runtime.deliveryStore.get(FORCE_ACTIONS_TABLE, claimKey);
    if (action && action.payload_hash !== payloadHash) {
      throw new Error('Idempotency key conflicts with a different force payload');
    }
    if (!action) {
      const stream = streams.get(streamId);
      if (!stream) return { status: 'error', error: 'Stream not found' };
      if (!stream.enabled) return { status: 'skipped', reason: 'stream_disabled' };
    }
    action ??= await runtime.deliveryStore.transact(tx => {
      const current = tx.get(FORCE_ACTIONS_TABLE, claimKey);
      if (current) {
        if (current.payload_hash !== payloadHash) {
          throw new Error('Idempotency key conflicts with a different force payload');
        }
        return current;
      }
      return tx.put(FORCE_ACTIONS_TABLE, claimKey, {
        kind: 'dashboard_force_action',
        stream_id: streamId,
        target_channel_id: streamId,
        target_request_id: identifiers.requestId,
        engine_idempotency_id: identifiers.idempotencyKey,
        actor_key_id: actorKeyId,
        reason_hash: reasonHash,
        duplicate_risk_acknowledgement_hash: duplicateRiskAcknowledgementHash,
        key_hash: keyHash,
        payload_hash: payloadHash,
        run_id: proposedRunId,
        status: 'accepted',
        result: null,
        requested_at: requestedAt.toISOString(),
        completed_at: null,
      }, { expectedVersion: 0 });
    });

    if (action.status === 'completed') return action.result;
    const existingRun = await runtime.deliveryStore.get(RUNS_TABLE, action.run_id);
    if (existingRun && existingRun.status !== 'running' && !isRecoverableInterruptedForce(existingRun)) {
      return finalizeForceAction(claimKey, payloadHash, existingRun);
    }

    const actionRequestedAt = new Date(action.requested_at);
    const result = await performRunStream(streamId, {
      triggerType: 'force',
      _operatorForce: true,
      ...identifiers,
      runId: action.run_id,
      requestedAt: Number.isNaN(actionRequestedAt.getTime()) ? requestedAt : actionRequestedAt,
      idempotency: { idempotency_key_hash: keyHash, idempotency_payload_hash: payloadHash },
    });
    return finalizeForceAction(claimKey, payloadHash, result);
  }

  async function finalizeForceAction(claimKey, payloadHash, result) {
    const completedAt = now().toISOString();
    const action = await runtime.deliveryStore.transact(tx => {
      const current = tx.get(FORCE_ACTIONS_TABLE, claimKey);
      if (!current || current.payload_hash !== payloadHash) {
        throw new Error('Force idempotency action is missing or conflicts with the request');
      }
      if (current.status === 'completed') return current;
      return tx.put(FORCE_ACTIONS_TABLE, claimKey, {
        ...current,
        status: 'completed',
        result,
        completed_at: completedAt,
      }, { expectedVersion: current.version });
    });
    return action.result;
  }

  async function performPreviewStream(streamId) {
    const stream = streams.get(streamId);
    if (!stream) return { status: 'error', error: 'Stream not found' };
    const executeStream = runtime.executeStream ?? defaultExecuteStream;
    const requestedAt = now();
    const result = await executeStream(stream, {
      triggerType: 'preview', dryRun: true, force: false, requestedAt,
    }, {
      cache: runtime.cache,
      deliveryStore: runtime.deliveryStore,
      clock: runtime.clock,
      env: runtime.env,
    });
    return projectPreview(result);
  }

  function previewStream(streamId) {
    if (!accepting) return Promise.resolve({ status: 'skipped', reason: 'shutting_down' });
    return trackOperation(performPreviewStream(streamId));
  }

  async function performControlStream(streamId, action, options = {}) {
    const stream = streams.get(streamId);
    if (!stream) return { status: 'error', error: 'Stream not found' };
    const normalized = normalizeControlAction(action, options);
    const executeStreamControl = runtime.executeStreamControl ?? defaultExecuteStreamControl;
    return executeStreamControl(stream, normalized, {
      cache: runtime.cache,
      deliveryStore: runtime.deliveryStore,
      clock: runtime.clock,
      env: runtime.env,
      buildEngine: runtime.buildEngine,
      machineFactory: runtime.machineFactory,
    });
  }

  function controlStream(streamId, action, options = {}) {
    if (!accepting) return Promise.resolve({ status: 'skipped', reason: 'shutting_down' });
    return trackOperation(performControlStream(streamId, action, options));
  }

  function trackOperation(operation) {
    const tracked = Promise.resolve(operation);
    activeOperations.add(tracked);
    tracked.then(
      () => activeOperations.delete(tracked),
      () => activeOperations.delete(tracked),
    );
    return tracked;
  }

  function scheduleStream(stream) {
    stopStream(stream.id);
    if (!stream.enabled) return;
    const cron = runtime.cron ?? cronModule;
    const task = cron.schedule(stream.cron, () => runStream(stream.id, { triggerType: 'scheduled' }), {
      timezone: stream.timezone || 'UTC',
    });
    jobs.set(stream.id, task);
    logger().log(`[Scheduler] "${stream.name}" -> ${stream.cron} (${stream.timezone})`);
  }

  function stopStream(streamId) {
    const task = jobs.get(streamId);
    if (task) { task.stop(); jobs.delete(streamId); }
  }

  async function init(streamList, overrides = {}) {
    await shutdown({ quiet: true });
    Object.assign(runtime, overrides);
    assertDeliveryStore(runtime.deliveryStore);
    validateStreams(streamList, runtime.cron ?? cronModule);
    await runtime.deliveryStore.initialize();
    streams.clear();
    runs.length = 0;
    const interrupted = await interruptStaleRuns(runtime.deliveryStore, now().toISOString());
    const persisted = await runtime.deliveryStore.list(RUNS_TABLE);
    runs.push(...persisted.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, MAX_HISTORY));
    for (const stream of streamList) {
      streams.set(stream.id, stream);
    }
    accepting = true;
    for (const stream of streamList) scheduleStream(stream);
    const enabled = streamList.filter(stream => stream.enabled).length;
    logger().log(`[Scheduler] Loaded ${streamList.length} stream(s), ${enabled} active`);
    if (interrupted > 0) logger().log(`[Scheduler] Reconciled ${interrupted} interrupted run(s)`);
  }

  async function shutdown({ quiet = false } = {}) {
    if (shutdownPromise) return shutdownPromise;
    accepting = false;
    const operation = (async () => {
      for (const task of jobs.values()) task.stop();
      jobs.clear();
      await Promise.allSettled([...activeOperations]);
      running.clear();
      pendingForces.clear();
      if (!quiet) logger().log('[Scheduler] All jobs stopped.');
    })();
    shutdownPromise = operation;
    try { await operation; }
    finally { if (shutdownPromise === operation) shutdownPromise = null; }
  }

  return Object.freeze({
    setEventEmitter,
    listStreams,
    getStream,
    listRuns,
    getRun,
    listUnresolvedTargets,
    runStream,
    forceStream,
    controlStream,
    previewStream,
    init,
    isRunning: streamId => running.has(streamId),
    shutdown,
  });
}

async function interruptStaleRuns(store, interruptedAt) {
  return store.transact(tx => {
    const stale = tx.list(RUNS_TABLE, run => run.status === 'running');
    for (const run of stale) {
      tx.put(RUNS_TABLE, run.id, {
        ...run,
        status: 'interrupted',
        reason: 'runtime_restarted',
        error: null,
        finished_at: interruptedAt,
      }, { expectedVersion: run.version });
    }
    return stale.length;
  });
}

function isRecoverableInterruptedForce(run) {
  return run.status === 'interrupted'
    && run.trigger_type === 'force'
    && run.reason === 'runtime_restarted';
}

function normalizeControlAction(action, options) {
  if (!CONTROL_ACTIONS.has(action)) throw new Error(`Unsupported recovery action: ${action}`);
  const normalized = {
    action,
    idempotencyKey: requiredVisibleAscii(options.idempotencyKey, 'idempotencyKey', 200),
    expectedVersion: positiveInteger(options.expectedVersion, 'expectedVersion'),
    operatorId: requiredText(options.operatorId, 'operatorId', 100),
    reason: requiredText(options.reason, 'reason', 500),
    confirmPausedMutation: options.confirmPausedMutation === true,
    confirmDuplicateRisk: options.confirmDuplicateRisk === true,
  };
  if (['retry-generation', 'retry-output', 'restore-topology', 'confirm-delivered', 'abandon'].includes(action)) {
    normalized.deliveryId = requiredText(options.deliveryId, 'deliveryId', 500);
  }
  if (['retry-output', 'confirm-delivered'].includes(action)) {
    normalized.outputKey = requiredText(options.outputKey, 'outputKey', 500);
  }
  if (action === 'retry-maintenance') {
    normalized.outboxId = requiredText(options.outboxId, 'outboxId', 500);
  }
  if (options.messageId !== undefined) normalized.messageId = requiredText(options.messageId, 'messageId', 200);
  return normalized;
}

function requiredVisibleAscii(value, label, maximum) {
  const text = String(value ?? '');
  if (!text || text.length > maximum || !/^[\x21-\x7e]+$/.test(text)) {
    throw new Error(`${label} must contain 1-${maximum} visible ASCII characters`);
  }
  return text;
}

function requiredText(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer`);
  return number;
}

function validateStreams(streamList, cron) {
  if (!Array.isArray(streamList)) throw new Error('Streams must be an array');
  const ids = new Set();
  for (const stream of streamList) {
    if (typeof stream?.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(stream.id)) {
      throw new Error(`Invalid stream id: ${stream?.id}`);
    }
    if (ids.has(stream.id)) throw new Error(`Duplicate stream id: ${stream.id}`);
    ids.add(stream.id);
    if (!['digest', 'drip'].includes(stream.mode || 'digest')) throw new Error(`Invalid mode for stream ${stream.id}`);
    if (!validateCronExpression(stream.cron) || (cron.validate && !cron.validate(stream.cron))) {
      throw new Error(`Invalid cron for stream ${stream.id}: ${stream.cron}`);
    }
    try { new Intl.DateTimeFormat('en', { timeZone: stream.timezone || 'UTC' }).format(); }
    catch { throw new Error(`Invalid timezone for stream ${stream.id}: ${stream.timezone}`); }
  }
}

function projectOutput(output) {
  return {
    id: bounded(output.id, 100),
    name: bounded(output.name, 100),
    success: output.success === true,
    ...(output.error ? { error: bounded(sanitizeRuntimeError(output.error), 300) } : {}),
  };
}

function projectStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const projected = {};
  for (const key of ['sources', 'articles', 'outputs', 'durationMs', 'remaining', 'blocked']) {
    if (Number.isFinite(stats[key])) projected[key] = stats[key];
  }
  if (typeof stats.mode === 'string') projected.mode = bounded(stats.mode, 20);
  if (typeof stats.ai === 'string') projected.ai = bounded(stats.ai, 100);
  const selection = projectSelectionStats(stats.selection);
  if (selection) projected.selection = selection;
  return projected;
}

function projectUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    ...(Number.isFinite(usage.input) ? { input: usage.input } : {}),
    ...(Number.isFinite(usage.output) ? { output: usage.output } : {}),
  };
}

function projectPreview(result) {
  return {
    status: result.status,
    ...(result.reason ? { reason: bounded(sanitizeRuntimeError(result.reason), 200) } : {}),
    ...(result.error ? { error: bounded(sanitizeRuntimeError(result.error), 500) } : {}),
    ...(result.content ? { content: bounded(result.content, 64 * 1024) } : {}),
    ...(Array.isArray(result.articles) ? { articles: result.articles.slice(0, 50).map(article => ({
      article: bounded(article.article, 500), hook: bounded(article.hook, 4_000), dryRun: true,
    })) } : {}),
    stats: projectStats(result.stats),
  };
}

function bounded(value, maximum) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, maximum);
}

function hashValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const defaultScheduler = createScheduler();
export const setEventEmitter = (...args) => defaultScheduler.setEventEmitter(...args);
export const listStreams = (...args) => defaultScheduler.listStreams(...args);
export const getStream = (...args) => defaultScheduler.getStream(...args);
export const listRuns = (...args) => defaultScheduler.listRuns(...args);
export const getRun = (...args) => defaultScheduler.getRun(...args);
export const listUnresolvedTargets = (...args) => defaultScheduler.listUnresolvedTargets(...args);
export const runStream = (...args) => defaultScheduler.runStream(...args);
export const forceStream = (...args) => defaultScheduler.forceStream(...args);
export const controlStream = (...args) => defaultScheduler.controlStream(...args);
export const previewStream = (...args) => defaultScheduler.previewStream(...args);
export const init = (...args) => defaultScheduler.init(...args);
export const isRunning = (...args) => defaultScheduler.isRunning(...args);
export const shutdown = (...args) => defaultScheduler.shutdown(...args);
