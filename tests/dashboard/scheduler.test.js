import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { deriveLocalForceIdentifiers } from '../../src/channels/runner.js';
import { createScheduler } from '../../src/dashboard/scheduler.js';

function forceOptions(idempotencyKey, overrides = {}) {
  return {
    idempotencyKey,
    operatorId: 'dashboard-operator-key',
    reason: 'operator approved explicit duplicate risk',
    confirmDuplicateRisk: true,
    ...overrides,
  };
}

function setup() {
  const jobs = [];
  const calls = [];
  const store = new MemoryDeliveryStore({ durable: true });
  const scheduler = createScheduler({
    cron: {
      validate: () => true,
      schedule(expression, callback, options) {
        jobs.push({ expression, callback, options });
        return { stop() {} };
      },
    },
    deliveryStore: store,
    cache: {},
    clock: () => new Date('2026-07-20T01:15:00.000Z'),
    idFactory: (() => { let id = 0; return () => `run-${++id}`; })(),
    executeStream: async (stream, options) => {
      calls.push({ stream, options });
      return { status: 'success', reason: 'sent', outputs: [{ id: 'telegram', success: true }], stats: { articles: 1 } };
    },
    logger: { log() {}, error() {} },
  });
  const streams = [{
    id: 'drip', name: 'Drip', enabled: true, mode: 'drip', cron: '15 9 * * *',
    timezone: 'Asia/Singapore', sources: [], ai: null, outputs: [], options: {},
  }];
  return { scheduler, jobs, calls, store, streams };
}

test('scheduler uses exact cron and scheduled/manual non-force modes', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  assert.equal(runtime.jobs[0].expression, '15 9 * * *');
  assert.equal(runtime.jobs[0].options.timezone, 'Asia/Singapore');
  await runtime.jobs[0].callback();
  await runtime.scheduler.runStream('drip', { triggerType: 'manual' });
  assert.deepEqual(runtime.calls.map(call => [call.options.triggerType, call.options.force]), [
    ['scheduled', false], ['manual', false],
  ]);
});

test('force is explicit, single-stream, and carries operator acknowledgement', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  assert.rejects(runtime.scheduler.forceStream('drip', {}), /idempotency/i);
  assert.rejects(runtime.scheduler.forceStream('drip', { idempotencyKey: 'key' }), /duplicate/i);
  await runtime.scheduler.forceStream('drip', forceOptions('key'));
  assert.equal(runtime.calls[0].options.triggerType, 'force');
  assert.equal(runtime.calls[0].options.force, true);
  assert.match(runtime.calls[0].options.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.match(runtime.calls[0].options.requestId, /^[a-f0-9]{64}$/);
  assert.notEqual(runtime.calls[0].options.idempotencyKey, 'key');
  const [audit] = await runtime.store.list('dashboard_force_actions');
  assert.equal(audit.actor_key_id, 'dashboard-operator-key');
  assert.equal(audit.target_channel_id, 'drip');
  assert.equal(audit.target_request_id, runtime.calls[0].options.requestId);
  assert.match(audit.reason_hash, /^[a-f0-9]{64}$/);
  assert.match(audit.duplicate_risk_acknowledgement_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(audit).includes('operator approved explicit duplicate risk'), false);
  assert.equal(JSON.stringify(audit).includes('"key"'), false);
});

test('concurrent force replay shares one persisted execution', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = setup();
  runtime.scheduler = createScheduler({
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    deliveryStore: runtime.store,
    cache: {},
    idFactory: () => 'force-run',
    executeStream: async (_stream, options) => {
      runtime.calls.push({ options });
      await gate;
      return { status: 'success', outputs: [] };
    },
    logger: { log() {}, error() {} },
  });
  await runtime.scheduler.init(runtime.streams);
  const first = runtime.scheduler.forceStream('drip', forceOptions('same'));
  const replay = runtime.scheduler.forceStream('drip', forceOptions('same'));
  release();
  const [firstResult, replayResult] = await Promise.all([first, replay]);
  assert.equal(runtime.calls.length, 1);
  assert.equal(firstResult.id, replayResult.id);
});

test('force idempotency survives history eviction and scheduler restart', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  const first = await runtime.scheduler.forceStream('drip', forceOptions('durable'));
  for (let index = 0; index < 205; index++) {
    await runtime.scheduler.runStream('drip', { triggerType: 'manual' });
  }
  runtime.scheduler.shutdown();

  const restarted = createScheduler({
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    deliveryStore: runtime.store,
    cache: {},
    idFactory: (() => { let id = 1_000; return () => `run-${++id}`; })(),
    executeStream: async (_stream, options) => {
      runtime.calls.push({ options });
      return { status: 'success', outputs: [] };
    },
    logger: { log() {}, error() {} },
  });
  await restarted.init(runtime.streams);
  const replay = await restarted.forceStream('drip', forceOptions('durable'));
  assert.equal(replay.id, first.id);
  assert.equal(runtime.calls.filter(call => call.options.force).length, 1);
  assert.equal((await runtime.store.list('dashboard_force_actions')).length, 1);
  await assert.rejects(
    restarted.forceStream('drip', forceOptions('durable', { reason: 'different force purpose' })),
    /conflicts/i,
  );
});

test('unknown force targets do not create durable action records', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  const result = await runtime.scheduler.forceStream('unknown', forceOptions('unknown-target'));
  assert.equal(result.status, 'error');
  assert.deepEqual(await runtime.store.list('dashboard_force_actions'), []);
});

test('force key is durably terminal when its stream is already busy', async () => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const runtime = setup();
  runtime.scheduler = createScheduler({
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    deliveryStore: runtime.store,
    cache: {},
    idFactory: (() => { let id = 0; return () => `busy-${++id}`; })(),
    executeStream: async (_stream, options) => {
      runtime.calls.push({ options });
      if (!options.force) { started(); await gate; }
      return { status: 'success', outputs: [] };
    },
    logger: { log() {}, error() {} },
  });
  await runtime.scheduler.init(runtime.streams);
  const manual = runtime.scheduler.runStream('drip', { triggerType: 'manual' });
  await startedPromise;
  const first = await runtime.scheduler.forceStream('drip', forceOptions('busy-key'));
  assert.equal(first.reason, 'already_running');
  release();
  await manual;
  const replay = await runtime.scheduler.forceStream('drip', forceOptions('busy-key'));
  assert.deepEqual(replay, first);
  assert.equal(runtime.calls.filter(call => call.options.force).length, 0);
});

test('run summaries persist but preview leaves delivery store bytes unchanged', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  await runtime.scheduler.runStream('drip', { triggerType: 'manual' });
  const persisted = await runtime.store.list('dashboard_runs');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, 'success');
  assert.equal(persisted[0].reason, 'sent');
  assert.deepEqual(persisted[0].output_summary, { total: 1, succeeded: 1, failed: 0 });
  assert.equal('content' in persisted[0], false);

  const before = structuredClone(await runtime.store.list('dashboard_runs'));
  const preview = await runtime.scheduler.previewStream('drip');
  assert.equal(preview.status, 'success');
  assert.deepEqual(await runtime.store.list('dashboard_runs'), before);
});

test('scheduler exposes paginated redacted exact recovery targets only', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  await runtime.store.transact(tx => {
    tx.put('channel_state', 'drip', {
      channelId: 'drip', paused: true, mutationState: 'free',
      providerDestination: 'https://secret.example/channel',
    }, { expectedVersion: 0 });
    tx.put('deliveries', 'delivery-1', {
      deliveryId: 'delivery-1', channelId: 'drip', state: 'generation_exhausted',
      generatedContent: 'private generated body', articleSnapshot: [{ url: 'https://secret.example/article' }],
    }, { expectedVersion: 0 });
    tx.put('delivery_outputs', 'delivery-1:output-key', {
      deliveryId: 'delivery-1', outputKey: 'output-key', state: 'needs_reconciliation',
      providerId: 'secret-provider', destination: 'https://secret.example/output',
    }, { expectedVersion: 0 });
    tx.put('maintenance_outbox', 'outbox-1', {
      outboxId: 'outbox-1', channelId: 'drip', state: 'dead_letter',
      targetKey: 'https://secret.example/cache', targetValue: 'private cache value',
    }, { expectedVersion: 0 });
  });

  const firstPage = await runtime.scheduler.listUnresolvedTargets('drip', { limit: 2, offset: 0 });
  const secondPage = await runtime.scheduler.listUnresolvedTargets('drip', { limit: 2, offset: 2 });
  assert.deepEqual(firstPage.channel, {
    channelId: 'drip', state: 'paused', expectedVersion: 1, allowedActions: ['resume'],
  });
  assert.equal(firstPage.page.total, 3);
  assert.equal(firstPage.targets.length, 2);
  assert.equal(secondPage.targets.length, 1);
  const projected = JSON.stringify([firstPage, secondPage]);
  for (const privateValue of ['private generated body', 'private cache value', 'secret.example', 'secret-provider']) {
    assert.equal(projected.includes(privateValue), false);
  }
  assert.match(projected, /delivery-1/);
  assert.match(projected, /output-key/);
  assert.match(projected, /outbox-1/);
  assert.match(projected, /expectedVersion/);
});

test('dashboard init marks stale running rows interrupted and exact force replay reaches the engine once', async () => {
  const runtime = setup();
  const key = 'stale-force-key';
  const options = forceOptions(key);
  const identifiers = await deriveLocalForceIdentifiers('drip', key);
  const keyHash = identifiers.idempotencyKey;
  const reasonHash = createHash('sha256').update(options.reason).digest('hex');
  const duplicateRiskAcknowledgementHash = createHash('sha256').update('duplicate-risk-accepted').digest('hex');
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({
      streamId: 'drip',
      requestId: identifiers.requestId,
      idempotencyId: identifiers.idempotencyKey,
      actorKeyId: options.operatorId,
      reasonHash,
      duplicateRiskAcknowledgementHash,
    }))
    .digest('hex');
  await runtime.store.transact(tx => {
    tx.put('dashboard_runs', 'stale-force-run', {
      id: 'stale-force-run', kind: 'dashboard_run', stream_id: 'drip', status: 'running', reason: null,
      trigger_type: 'force', stats: null, ai_usage: null, output_results: [],
      output_summary: { total: 0, succeeded: 0, failed: 0 }, error: null,
      started_at: '2026-07-20T01:00:00.000Z', finished_at: null,
    }, { expectedVersion: 0 });
    tx.put('dashboard_force_actions', `drip:${keyHash}`, {
      kind: 'dashboard_force_action', stream_id: 'drip', target_channel_id: 'drip',
      target_request_id: identifiers.requestId, engine_idempotency_id: identifiers.idempotencyKey,
      actor_key_id: options.operatorId, reason_hash: reasonHash,
      duplicate_risk_acknowledgement_hash: duplicateRiskAcknowledgementHash,
      key_hash: keyHash, payload_hash: payloadHash,
      run_id: 'stale-force-run', status: 'accepted', result: null,
      requested_at: '2026-07-20T01:00:00.000Z', completed_at: null,
    }, { expectedVersion: 0 });
  });

  await runtime.scheduler.init(runtime.streams);
  assert.equal(runtime.scheduler.getRun('stale-force-run').status, 'interrupted');
  assert.equal(runtime.scheduler.getRun('stale-force-run').reason, 'runtime_restarted');

  const first = await runtime.scheduler.forceStream('drip', options);
  const replay = await runtime.scheduler.forceStream('drip', options);
  assert.equal(first.id, 'stale-force-run');
  assert.deepEqual(replay, first);
  assert.equal(runtime.calls.filter(call => call.options.force).length, 1);
});

test('dashboard recovery rejects unknown streams before durable mutation', async () => {
  const runtime = setup();
  await runtime.scheduler.init(runtime.streams);
  const before = await runtime.store.list('operator_actions');
  const result = await runtime.scheduler.controlStream('unknown', 'pause', {});
  assert.equal(result.status, 'error');
  assert.deepEqual(await runtime.store.list('operator_actions'), before);
});

test('dashboard recovery forwards exact versioned operator controls', async () => {
  const runtime = setup();
  const controls = [];
  runtime.scheduler = createScheduler({
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    deliveryStore: runtime.store,
    cache: {},
    executeStreamControl: async (_stream, action) => {
      controls.push(action);
      return { status: 'confirmed', deliveryId: action.deliveryId, version: action.expectedVersion };
    },
    logger: { log() {}, error() {} },
  });
  await runtime.scheduler.init(runtime.streams);
  const result = await runtime.scheduler.controlStream('drip', 'confirm-delivered', {
    idempotencyKey: 'confirm-1', expectedVersion: 7, operatorId: 'operator-user',
    reason: 'verified in provider console', deliveryId: 'delivery-1', outputKey: 'output-1',
  });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(controls[0], {
    action: 'confirm-delivered', idempotencyKey: 'confirm-1', expectedVersion: 7,
    operatorId: 'operator-user', reason: 'verified in provider console',
    confirmPausedMutation: false, confirmDuplicateRisk: false,
    deliveryId: 'delivery-1', outputKey: 'output-1',
  });
});
