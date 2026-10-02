import test from 'node:test';
import assert from 'node:assert/strict';

import { DeliveryStateMachine, MemoryDeliveryStore } from '../../src/core/index.js';
import { main } from '../../src/adapters/node.js';

const SHORT_ATTEMPT_TIMEOUT_MS = 40;

function shortLeaseMachine(options) {
  return new DeliveryStateMachine({ ...options, attemptTimeoutMs: SHORT_ATTEMPT_TIMEOUT_MS });
}

async function settlesWithin(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeRuntime(overrides = {}) {
  const cache = { capabilities: { persistent: true }, async disconnect() { this.disconnected = true; } };
  const store = new MemoryDeliveryStore({ durable: true });
  store.initialized = 0;
  store.initializeOptions = [];
  store.closed = 0;
  store.initialize = async function initialize(options) {
    this.initialized += 1;
    this.initializeOptions.push(options);
  };
  store.close = async function close() { this.closed += 1; };
  const calls = [];
  const scheduled = [];
  const handlers = {};
  const channels = [
    { id: 'digest', mode: 'digest', schedule: '15 9 * * *', timezone: 'Asia/Singapore', sources: [{}], ai: {}, output: {} },
    { id: 'drip', mode: 'drip', schedule: '30 10 * * *', timezone: 'UTC', sources: [{}], ai: {}, output: {} },
  ];
  const deps = {
    loadEnvironment: async () => {},
    defineChannels: () => channels,
    validateChannels: value => value,
    createCache: () => cache,
    createDeliveryStore: () => store,
    runChannels: async (selected, options) => {
      calls.push({ selected, options });
      return selected.map(ch => ({ channelId: ch.id, status: 'success' }));
    },
    buildEngine: ch => ({
      async run(options) { calls.push({ preview: ch.id, method: 'run', options }); return { status: 'dry_run' }; },
      async runDrip(options) { calls.push({ preview: ch.id, method: 'runDrip', options }); return { status: 'dry_run' }; },
    }),
    cron: { schedule(expression, callback, options) { scheduled.push({ expression, callback, options }); return { stop() {} }; } },
    process: { once(signal, handler) { handlers[signal] = handler; }, exitCode: 0 },
    clock: () => new Date('2026-07-20T01:15:00.000Z'),
    logger: { log() {}, error() {}, warn() {} },
    ...overrides,
  };
  return { deps, cache, store, calls, scheduled, handlers, channels };
}

test('manual run executes outside schedule and owns one persistent store', async () => {
  const runtime = fakeRuntime();
  const code = await main(['run', '--channel', 'digest'], {}, runtime.deps);
  assert.equal(code, 0);
  assert.equal(runtime.calls[0].options.triggerType, 'manual');
  assert.equal(runtime.calls[0].options.deliveryStore, runtime.store);
  assert.equal(runtime.store.initialized, 1);
  assert.deepEqual(runtime.store.initializeOptions, [{ readOnly: false }]);
  assert.equal(runtime.store.closed, 1);
  assert.equal(runtime.cache.disconnected, true);
});

test('force audit records keep only bounded article selection counts', async () => {
  const runtime = fakeRuntime({
    runChannels: async selected => selected.map(ch => ({
      channelId: ch.id,
      status: 'success',
      stats: {
        articles: 1,
        selection: { fetched: 4, fresh: 3, relevant: 2, ranked: 2, enqueued: 1, title: 'private headline' },
      },
    })),
  });
  const code = await main([
    'run', '--force', '--channel', 'drip', '--idempotency-key', 'force-selection',
    '--operator-id', 'operator-key', '--reason', 'approved duplicate-risk delivery',
    '--confirm-duplicate-risk',
  ], {}, runtime.deps);

  assert.equal(code, 0);
  const [audit] = await runtime.store.list('local_force_actions');
  assert.deepEqual(audit.result[0].stats.selection, { fetched: 4, fresh: 3, relevant: 2, ranked: 2, enqueued: 1 });
});

test('force requires actor/reason/acknowledgement and persists only opaque exact-replay identifiers', async () => {
  for (const argv of [
    ['run', '--force'],
    ['run', '--force', '--channel', 'digest'],
    ['run', '--force', '--channel', 'digest', '--idempotency-key', 'k'],
    ['run', '--force', '--channel', 'digest', '--idempotency-key', 'k', '--operator-id', 'operator-key'],
    ['run', '--force', '--channel', 'digest', '--idempotency-key', 'k', '--operator-id', 'operator-key', '--reason', 'approved'],
  ]) {
    const runtime = fakeRuntime();
    assert.equal(await main(argv, {}, runtime.deps), 1);
    assert.equal(runtime.calls.length, 0);
  }

  const runtime = fakeRuntime();
  const argv = [
    'run', '--force', '--channel', 'drip', '--idempotency-key', 'force-1',
    '--operator-id', 'operator-key', '--reason', 'approved duplicate-risk delivery',
    '--confirm-duplicate-risk',
  ];
  const code = await main(argv, {}, runtime.deps);
  assert.equal(code, 0);
  assert.equal(runtime.calls[0].options.triggerType, 'force');
  assert.match(runtime.calls[0].options.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.match(runtime.calls[0].options.requestId, /^[a-f0-9]{64}$/);
  assert.notEqual(runtime.calls[0].options.idempotencyKey, 'force-1');
  assert.equal(await main(argv, {}, runtime.deps), 0);
  assert.equal(runtime.calls.length, 1);

  const audits = await runtime.store.list('local_force_actions');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_key_id, 'operator-key');
  assert.equal(audits[0].target_channel_id, 'drip');
  assert.equal(audits[0].target_request_id, runtime.calls[0].options.requestId);
  assert.match(audits[0].reason_hash, /^[a-f0-9]{64}$/);
  assert.match(audits[0].duplicate_risk_acknowledgement_hash, /^[a-f0-9]{64}$/);
  const durableAudit = JSON.stringify(audits);
  assert.equal(durableAudit.includes('force-1'), false);
  assert.equal(durableAudit.includes('approved duplicate-risk delivery'), false);

  const conflict = [...argv];
  conflict[conflict.indexOf('approved duplicate-risk delivery')] = 'different force reason';
  assert.equal(await main(conflict, {}, runtime.deps), 1);
  assert.equal(runtime.calls.length, 1);
});

test('daemon registers each exact channel cron and timezone', async () => {
  const runtime = fakeRuntime();
  const code = await main(['daemon'], {}, runtime.deps);
  assert.equal(code, 0);
  assert.deepEqual(runtime.scheduled.map(job => [job.expression, job.options.timezone]), [
    ['15 9 * * *', 'Asia/Singapore'],
    ['30 10 * * *', 'UTC'],
  ]);
  await runtime.scheduled[0].callback();
  assert.equal(runtime.calls[0].options.triggerType, 'scheduled');
  assert.deepEqual(runtime.calls[0].selected.map(ch => ch.id), ['digest']);
  assert.equal(runtime.store.closed, 0);
  await runtime.handlers.SIGTERM();
  assert.equal(runtime.store.closed, 1);
});

test('daemon shutdown drains an in-flight run before releasing ownership', async () => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = fakeRuntime({
    runChannels: async selected => {
      started();
      await gate;
      return selected.map(ch => ({ channelId: ch.id, status: 'success' }));
    },
  });
  assert.equal(await main(['daemon'], {}, runtime.deps), 0);
  const execution = runtime.scheduled[0].callback();
  await startedPromise;
  const shutdown = runtime.handlers.SIGTERM();
  await Promise.resolve();
  assert.equal(runtime.store.closed, 0);
  release();
  await Promise.all([execution, shutdown]);
  assert.equal(runtime.store.closed, 1);
});

test('preview dispatches by stream mode and never forces', async () => {
  const runtime = fakeRuntime();
  const code = await main(['preview', '--channel', 'drip'], { CACHE_TYPE: 'memory' }, runtime.deps);
  assert.equal(code, 0);
  assert.equal(runtime.calls[0].method, 'runDrip');
  assert.deepEqual(runtime.calls[0].options, { dryRun: true, force: false });
  assert.deepEqual(runtime.store.initializeOptions, [{ readOnly: true }]);
});

test('status prints paginated exact recovery targets without durable content or destinations', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  await store.transact(tx => {
    tx.put('channel_state', 'digest', {
      channelId: 'digest', paused: false, mutationState: 'free',
      destination: 'https://secret.example/channel',
    }, { expectedVersion: 0 });
    tx.put('deliveries', 'delivery-status', {
      deliveryId: 'delivery-status', channelId: 'digest', state: 'generation_exhausted',
      generatedContent: 'private generated content', articleSnapshot: [{ url: 'https://secret.example/article' }],
    }, { expectedVersion: 0 });
    tx.put('delivery_outputs', 'delivery-status:output-status', {
      deliveryId: 'delivery-status', outputKey: 'output-status', state: 'needs_reconciliation',
      providerId: 'secret-provider', destination: 'https://secret.example/output',
    }, { expectedVersion: 0 });
    tx.put('maintenance_outbox', 'outbox-status', {
      outboxId: 'outbox-status', channelId: 'digest', state: 'dead_letter',
      targetKey: 'https://secret.example/cache', targetValue: 'private cache value',
    }, { expectedVersion: 0 });
  });
  const logs = [];
  const runtime = fakeRuntime({
    createDeliveryStore: () => store,
    logger: { log(value) { logs.push(String(value)); }, error(value) { logs.push(String(value)); }, warn() {} },
  });
  assert.equal(await main(['status', '--channel', 'digest', '--limit', '3', '--offset', '0'], {}, runtime.deps), 0);
  const projected = logs.join('\n');
  assert.match(projected, /delivery-status/);
  assert.match(projected, /output-status/);
  assert.match(projected, /expectedVersion/);
  assert.match(projected, /retry-generation|retry-output/);
  for (const privateValue of [
    'private generated content', 'private cache value', 'secret.example', 'secret-provider',
  ]) {
    assert.equal(projected.includes(privateValue), false);
  }
});

test('output-capable commands reject memory cache and Redis delivery store', async () => {
  const memoryRuntime = fakeRuntime();
  assert.equal(await main(['run'], { CACHE_TYPE: 'memory' }, memoryRuntime.deps), 1);
  assert.equal(memoryRuntime.store.initialized, 0);

  const redisStoreRuntime = fakeRuntime();
  assert.equal(await main(['run'], { CACHE_TYPE: 'redis', DELIVERY_STORE_TYPE: 'redis' }, redisStoreRuntime.deps), 1);
  assert.equal(redisStoreRuntime.store.initialized, 0);
});

test('partial, ambiguous, failed, and error outcomes return non-zero', async () => {
  for (const status of ['partial', 'ambiguous', 'failed', 'error']) {
    const runtime = fakeRuntime({
      runChannels: async selected => selected.map(ch => ({ channelId: ch.id, status })),
    });
    assert.equal(await main(['run'], {}, runtime.deps), 1, status);
  }
});

test('CLI error logs redact URLs, credentials, and provider response bodies', async () => {
  const logs = [];
  const runtime = fakeRuntime({
    runChannels: async () => {
      throw new Error('ordinary outage provider body={"token":"raw-token"} https://secret.example/hook Bearer raw-bearer');
    },
    logger: { log(value) { logs.push(String(value)); }, error(value) { logs.push(String(value)); }, warn() {} },
  });
  assert.equal(await main(['run', '--channel', 'digest'], {}, runtime.deps), 1);
  const projected = logs.join('\n');
  assert.match(projected, /ordinary outage/i);
  for (const secret of ['raw-token', 'secret.example', 'raw-bearer']) {
    assert.equal(projected.includes(secret), false);
  }
});

test('every recovery command requires an exact target, key, version, and reason', async () => {
  for (const command of [
    'pause', 'resume', 'retry-generation', 'retry-output',
    'confirm-delivered', 'abandon', 'retry-maintenance',
  ]) {
    const runtime = fakeRuntime();
    assert.equal(await main([command, '--channel', 'digest'], {}, runtime.deps), 1, command);
    assert.equal(runtime.store.initialized, 0, command);
  }
});

test('ambiguous output retry is exact, redacted, and never repeats its provider call', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  let sends = 0;
  let sendCall;
  const output = {
    id: 'recording-output',
    name: 'Recording Output',
    deliveryKey: 'recording-destination',
    maxLength: 80,
    async send(content, options) {
      sends += 1;
      sendCall = { content, options };
      return { success: true, messageId: 'provider-secret-id' };
    },
  };
  const article = { id: 'secret-article-id', title: 'Secret article title', content: 'raw secret body', source: 'Fixture' };
  const generatedContent = 'secret generated digest '.repeat(8);
  const machine = new DeliveryStateMachine({ store, channelId: 'digest', clock });
  const prepared = await machine.prepareDelivery({
    requestId: 'seed-request', mode: 'digest', publishingDay: '2026-07-20',
    articles: [article],
    outputs: [output],
  });
  const generation = await machine.claimGeneration(prepared.deliveryId, { requestId: 'seed-request' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: generatedContent });
  const firstOutput = await machine.claimNextOutput(prepared.deliveryId, { requestId: 'seed-request' });
  await machine.commitOutput(firstOutput.attempt.attemptId, {
    success: false,
    meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'provider timeout' },
  });
  const target = await machine.getOutput(prepared.deliveryId, firstOutput.output.outputKey);
  const channelState = await machine.getChannelState();
  await machine.setPaused(true, {
    expectedVersion: channelState.version,
    idempotencyKey: 'seed-pause',
    operatorId: 'fixture',
    reason: 'exercise paused retry confirmation',
  });
  const logs = [];
  const runtime = fakeRuntime({
    defineChannels: () => [{
      id: 'digest', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC',
      sources: [{}], ai: {}, output,
    }],
    createDeliveryStore: () => store,
    logger: { log(value) { logs.push(String(value)); }, error() {}, warn() {} },
    clock,
  });
  const argv = [
    'retry-output', '--channel', 'digest', '--delivery-id', prepared.deliveryId,
    '--output-key', target.outputKey, '--expected-version', String(target.version),
    '--idempotency-key', 'retry-once', '--reason', 'operator verified timeout',
    '--confirm-duplicate-risk',
  ];
  assert.equal(await main(argv, {}, runtime.deps), 1);
  assert.equal(sends, 0);
  const confirmedArgv = [...argv, '--confirm-paused-mutation'];
  assert.equal(await main(confirmedArgv, {}, runtime.deps), 0);
  output.deliveryKey = 'changed-after-completed-replay';
  assert.equal(await main(confirmedArgv, {}, runtime.deps), 0);
  assert.equal(sends, 1);
  assert.equal(sendCall.content, `${generatedContent.substring(0, 30)}\n\n[...]`);
  assert.deepEqual(sendCall.options.articles, (await machine.getDelivery(prepared.deliveryId)).articleSnapshot);
  assert.equal(sendCall.options.article, undefined);
  assert.equal(sendCall.options.deliveryId, prepared.deliveryId);
  assert.notEqual(sendCall.options.attemptId, firstOutput.attempt.attemptId);
  assert.equal(sendCall.options.singleMutation, false);
  assert.ok(sendCall.options.signal instanceof AbortSignal);
  assert.equal(logs.join('\n').includes('raw secret body'), false);
  assert.equal(logs.join('\n').includes(generatedContent), false);
  assert.equal(logs.join('\n').includes('provider-secret-id'), false);
});

test('generation recovery aborts a never-resolving AI call before the attempt lease', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  const output = { id: 'recording-output', deliveryKey: 'recording-destination' };
  const seedMachine = new DeliveryStateMachine({ store, channelId: 'digest', clock });
  const prepared = await seedMachine.prepareDelivery({
    requestId: 'generation-timeout-seed', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'private-article', title: 'Private title', content: 'raw private body', source: 'Fixture' }],
    outputs: [output],
  });
  const generation = await seedMachine.claimGeneration(prepared.deliveryId, { requestId: 'generation-timeout-seed' });
  const exhausted = await seedMachine.failGeneration(generation.attempt.attemptId, new Error('seed failure'), {
    retryDisposition: 'never',
  });
  let signal;
  let aborted = false;
  const ai = {
    id: 'hanging-ai',
    name: 'Hanging AI',
    async summarize(_articles, options) {
      signal = options.signal;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  };
  const logs = [];
  const runtime = fakeRuntime({
    defineChannels: () => [{
      id: 'digest', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC',
      sources: [{}], ai, output,
    }],
    createDeliveryStore: () => store,
    machineFactory: shortLeaseMachine,
    logger: { log(value) { logs.push(String(value)); }, error(value) { logs.push(String(value)); }, warn() {} },
    clock,
  });

  const code = await settlesWithin(main([
    'retry-generation', '--channel', 'digest', '--delivery-id', prepared.deliveryId,
    '--expected-version', String(exhausted.version), '--idempotency-key', 'generation-timeout',
    '--reason', 'retry hanging generation',
  ], {}, runtime.deps));

  assert.equal(code, 1);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(aborted, true);
  assert.equal(logs.join('\n').includes('raw private body'), false);
});

test('generation recovery validates full configured topology before reconcile or AI I/O', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const originalOutputs = [
    { id: 'primary', deliveryKey: 'primary-destination' },
    { id: 'secondary', deliveryKey: 'secondary-destination' },
  ];
  const machine = new DeliveryStateMachine({ store, channelId: 'digest' });
  const prepared = await machine.prepareDelivery({
    requestId: 'generation-topology-seed', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'private', title: 'Private', content: 'private body', source: 'Fixture' }],
    outputs: originalOutputs,
  });
  const generation = await machine.claimGeneration(prepared.deliveryId, { requestId: 'generation-topology-seed' });
  const exhausted = await machine.failGeneration(generation.attempt.attemptId, new Error('seed failure'), {
    retryDisposition: 'never',
  });
  const attemptsBefore = await store.list('attempts');
  let generations = 0;
  const changedOutputs = [
    originalOutputs[0],
    { ...originalOutputs[1], deliveryKey: 'changed-secondary-destination' },
  ];
  const runtime = fakeRuntime({
    defineChannels: () => [{
      id: 'digest', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC', sources: [],
      ai: { async summarize() { generations += 1; return { text: 'must not generate' }; } },
      output: changedOutputs[0], outputs: changedOutputs,
    }],
    createDeliveryStore: () => store,
  });

  const code = await main([
    'retry-generation', '--channel', 'digest', '--delivery-id', prepared.deliveryId,
    '--expected-version', String(exhausted.version), '--idempotency-key', 'generation-topology-retry',
    '--operator-id', 'operator-key', '--reason', 'retry only with unchanged outputs',
  ], {}, runtime.deps);

  assert.equal(code, 1);
  assert.equal(generations, 0);
  assert.deepEqual(await store.list('operator_actions'), []);
  assert.deepEqual(await store.list('attempts'), attemptsBefore);
  assert.equal((await machine.getDelivery(prepared.deliveryId)).state, 'generation_exhausted');
});

test('output recovery aborts a never-resolving send before the attempt lease', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  let signal;
  let aborted = false;
  const output = {
    id: 'hanging-output', name: 'Hanging Output', deliveryKey: 'hanging-destination', maxLength: 70,
    async send(_content, options) {
      signal = options.signal;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  };
  const seedMachine = new DeliveryStateMachine({ store, channelId: 'digest', clock });
  const prepared = await seedMachine.prepareDelivery({
    requestId: 'output-timeout-seed', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'private-output-article', title: 'Private', content: 'private output body', source: 'Fixture' }],
    outputs: [output],
  });
  const generation = await seedMachine.claimGeneration(prepared.deliveryId, { requestId: 'output-timeout-seed' });
  await seedMachine.commitGeneration(generation.attempt.attemptId, { content: 'private generated content '.repeat(8) });
  const firstOutput = await seedMachine.claimNextOutput(prepared.deliveryId, { requestId: 'output-timeout-seed' });
  await seedMachine.commitOutput(firstOutput.attempt.attemptId, {
    success: false,
    meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'seed timeout' },
  });
  const target = await seedMachine.getOutput(prepared.deliveryId, firstOutput.output.outputKey);
  const logs = [];
  const runtime = fakeRuntime({
    defineChannels: () => [{
      id: 'digest', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC',
      sources: [{}], ai: {}, output,
    }],
    createDeliveryStore: () => store,
    machineFactory: shortLeaseMachine,
    logger: { log(value) { logs.push(String(value)); }, error(value) { logs.push(String(value)); }, warn() {} },
    clock,
  });

  const code = await settlesWithin(main([
    'retry-output', '--channel', 'digest', '--delivery-id', prepared.deliveryId,
    '--output-key', target.outputKey, '--expected-version', String(target.version),
    '--idempotency-key', 'output-timeout', '--reason', 'retry hanging output',
    '--confirm-duplicate-risk',
  ], {}, runtime.deps));

  assert.equal(code, 1);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(aborted, true);
  assert.equal(logs.join('\n').includes('private generated content'), false);
  assert.equal(logs.join('\n').includes('private output body'), false);
});

test('unknown recovery target fails without durable mutation', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const runtime = fakeRuntime({ createDeliveryStore: () => store });
  const before = {
    actions: await store.list('operator_actions'),
    attempts: await store.list('attempts'),
    deliveries: await store.list('deliveries'),
  };
  const code = await main([
    'retry-generation', '--channel', 'digest', '--delivery-id', 'missing-delivery',
    '--expected-version', '1', '--idempotency-key', 'unknown-retry', '--reason', 'investigation',
  ], {}, runtime.deps);
  assert.equal(code, 1);
  assert.deepEqual(await store.list('operator_actions'), before.actions);
  assert.deepEqual(await store.list('attempts'), before.attempts);
  assert.deepEqual(await store.list('deliveries'), before.deliveries);
});

test('cross-channel recovery target is rejected byte-for-byte', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const otherMachine = new DeliveryStateMachine({ store, channelId: 'other' });
  const delivery = await otherMachine.prepareDelivery({
    requestId: 'other-request', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'other-article', title: 'Other', content: 'body', source: 'Fixture' }],
    outputs: [{ id: 'other-output', deliveryKey: 'other-destination' }],
  });
  const before = {
    actions: await store.list('operator_actions'),
    attempts: await store.list('attempts'),
    deliveries: await store.list('deliveries'),
    channels: await store.list('channel_state'),
  };
  const runtime = fakeRuntime({ createDeliveryStore: () => store });
  const code = await main([
    'retry-generation', '--channel', 'digest', '--delivery-id', delivery.deliveryId,
    '--expected-version', String(delivery.version), '--idempotency-key', 'cross-channel',
    '--reason', 'must not cross channel boundary',
  ], {}, runtime.deps);
  assert.equal(code, 1);
  assert.deepEqual(await store.list('operator_actions'), before.actions);
  assert.deepEqual(await store.list('attempts'), before.attempts);
  assert.deepEqual(await store.list('deliveries'), before.deliveries);
  assert.deepEqual(await store.list('channel_state'), before.channels);
});
