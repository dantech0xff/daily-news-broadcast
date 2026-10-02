import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryCache } from '../../src/core/caches.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { buildEngine, executeStream, executeStreamControl } from '../../src/dashboard/stream-runner.js';

const stream = {
  id: 'news', name: 'News', mode: 'drip', timezone: 'Asia/Singapore',
  sources: [], ai: null, outputs: [], options: {},
};

const SHORT_ATTEMPT_TIMEOUT_MS = 40;

test('dashboard stream engines apply the tech relevance gate', () => {
  const engine = buildEngine(stream, {
    cache: new MemoryCache(),
    deliveryStore: new MemoryDeliveryStore({ durable: true }),
  });

  assert.deepEqual(engine.middlewares.map(middleware => middleware.label), ['tech-relevance']);
});

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

test('executeStream preserves drip mode and explicit trigger semantics', async () => {
  const calls = [];
  const engine = {
    setLogger() {},
    async runDrip(options) { calls.push(options); return { status: 'success', reason: 'sent', outputs: [] }; },
    async run() { throw new Error('digest path must not run'); },
  };
  const deps = { buildEngine: () => engine };

  await executeStream(stream, { triggerType: 'scheduled' }, deps);
  await executeStream(stream, { triggerType: 'manual' }, deps);
  await executeStream(stream, { triggerType: 'force', idempotencyKey: 'force-1' }, deps);

  assert.deepEqual(calls.map(call => call.force), [false, false, true]);
  assert.match(calls[2].idempotencyKey, /^[a-f0-9]{64}$/);
  assert.match(calls[2].requestId, /^[a-f0-9]{64}$/);
  assert.notEqual(calls[2].idempotencyKey, 'force-1');
  assert.equal(calls[2].operatorForce, undefined);
});

test('drip streams forward their configured daily limit to the engine', async () => {
  const calls = [];
  const engine = {
    setLogger() {},
    async runDrip(options) { calls.push(options); return { status: 'success', outputs: [] }; },
    async run() { throw new Error('digest path must not run'); },
  };

  await executeStream({ ...stream, options: { batchSize: 1, dailyLimit: 4 } }, { triggerType: 'manual' }, {
    buildEngine: () => engine,
  });
  await executeStream(stream, { triggerType: 'manual' }, { buildEngine: () => engine });

  assert.equal(calls[0].dailyLimit, 4);
  assert.equal('dailyLimit' in calls[1], false);
});

test('preview is mode-aware and read-only at the engine boundary', async () => {
  let options;
  const result = await executeStream(stream, { triggerType: 'preview', dryRun: true, force: true }, {
    buildEngine: () => ({
      setLogger() {},
      async run() { throw new Error('wrong mode'); },
      async runDrip(value) { options = value; return { status: 'dry_run', articles: [] }; },
    }),
  });
  assert.equal(result.status, 'dry_run');
  assert.deepEqual(options, { dryRun: true, force: false });
});

test('unresolved environment references fail before any plugin construction', () => {
  let constructed = 0;
  assert.throws(() => buildEngine({
    ...stream,
    sources: [{ type: 'unknown-source', config: { token: '$MISSING_SOURCE_TOKEN' } }],
    outputs: [{ type: 'unknown-output', config: { token: '$MISSING_OUTPUT_TOKEN' } }],
  }, {
    env: {},
    cache: new MemoryCache(),
    deliveryStore: new MemoryDeliveryStore({ durable: true }),
    engineFactory() { constructed += 1; throw new Error('constructed'); },
  }), /MISSING_(SOURCE|OUTPUT)_TOKEN/);
  assert.equal(constructed, 0);
});

test('buildEngine requires shared cache and delivery store dependencies', () => {
  assert.throws(() => buildEngine(stream, {}), /shared cache/i);
  assert.throws(() => buildEngine(stream, { cache: new MemoryCache() }), /shared delivery store/i);
});

test('buildEngine rejects unsafe numeric stream options before engine construction', () => {
  for (const options of [
    { concurrency: -1 }, { concurrency: 0 }, { concurrency: 1.5 },
    { maxArticlesPerSource: 0 }, { maxArticles: Number.MAX_SAFE_INTEGER },
    { batchSize: -1 }, { delayMs: -1 }, { dailyLimit: 0 }, { dailyLimit: 501 },
  ]) {
    let constructed = 0;
    assert.throws(() => buildEngine({ ...stream, options }, {
      cache: new MemoryCache(),
      deliveryStore: new MemoryDeliveryStore({ durable: true }),
      engineFactory: () => { constructed += 1; return {}; },
    }), /invalid|must|range/i);
    assert.equal(constructed, 0);
  }
});

test('dashboard output recovery executes one ambiguous retry and redacts durable content', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  let sends = 0;
  let sendCall;
  const output = {
    id: 'dashboard-output', name: 'Dashboard Output', deliveryKey: 'dashboard-destination',
    maxLength: 80,
    async send(content, options) {
      sends += 1;
      sendCall = { content, options };
      return { success: true, messageId: 'secret-provider-id' };
    },
  };
  const article = { id: 'secret-id', title: 'Secret title', content: 'raw body', source: 'Fixture' };
  const generatedContent = 'secret generated content '.repeat(8);
  const machine = new DeliveryStateMachine({ store, channelId: 'news', clock });
  const delivery = await machine.prepareDelivery({
    requestId: 'dashboard-seed', mode: 'drip', publishingDay: '2026-07-20',
    articles: [article],
    outputs: [output],
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'dashboard-seed' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: generatedContent });
  const claimed = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'dashboard-seed' });
  await machine.commitOutput(claimed.attempt.attemptId, {
    success: false,
    meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'timeout' },
  });
  const target = await machine.getOutput(delivery.deliveryId, claimed.output.outputKey);
  const action = {
    action: 'retry-output', idempotencyKey: 'dashboard-retry', expectedVersion: target.version,
    operatorId: 'operator-user', reason: 'verified timeout', deliveryId: delivery.deliveryId,
    outputKey: target.outputKey, confirmDuplicateRisk: true,
  };
  const dependencies = {
    deliveryStore: store,
    cache: {},
    clock,
    env: {},
    buildEngine: () => ({ outputs: [output], cache: { async set() {} } }),
  };

  const first = await executeStreamControl(stream, action, dependencies);
  const replay = await executeStreamControl(stream, action, {
    ...dependencies,
    buildEngine: () => { throw new Error('exact replay must resolve before topology preflight'); },
  });
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.replayed, true);
  assert.equal(sends, 1);
  const stored = await machine.getDelivery(delivery.deliveryId);
  assert.equal(sendCall.content, `${generatedContent.substring(0, 30)}\n\n[...]`);
  assert.deepEqual(sendCall.options.articles, stored.articleSnapshot);
  assert.deepEqual(sendCall.options.article, stored.articleSnapshot[0]);
  assert.equal(sendCall.options.deliveryId, delivery.deliveryId);
  assert.notEqual(sendCall.options.attemptId, claimed.attempt.attemptId);
  assert.equal(sendCall.options.singleMutation, false);
  assert.ok(sendCall.options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify([first, replay]).includes(generatedContent), false);
  assert.equal(JSON.stringify([first, replay]).includes('raw body'), false);
  assert.equal(JSON.stringify([first, replay]).includes('secret-provider-id'), false);
});

test('dashboard generation recovery aborts a never-resolving AI call before the attempt lease', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  const output = { id: 'dashboard-output', deliveryKey: 'dashboard-destination' };
  const seedMachine = new DeliveryStateMachine({ store, channelId: 'news', clock });
  const delivery = await seedMachine.prepareDelivery({
    requestId: 'dashboard-generation-timeout-seed', mode: 'drip', publishingDay: '2026-07-20',
    articles: [{ id: 'dashboard-private', title: 'Private', content: 'dashboard raw private body', source: 'Fixture' }],
    outputs: [output],
  });
  const generation = await seedMachine.claimGeneration(delivery.deliveryId, { requestId: 'dashboard-generation-timeout-seed' });
  const exhausted = await seedMachine.failGeneration(generation.attempt.attemptId, new Error('seed failure'), {
    retryDisposition: 'never',
  });
  let signal;
  let aborted = false;
  const ai = {
    id: 'dashboard-hanging-ai',
    async summarize(_articles, options) {
      signal = options.signal;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  };
  const result = await settlesWithin(executeStreamControl({
    ...stream,
    ai: { provider: 'fixture', style: 'digest', audience: 'operators', platform: 'telegram' },
  }, {
    action: 'retry-generation', idempotencyKey: 'dashboard-generation-timeout', expectedVersion: exhausted.version,
    operatorId: 'operator-user', reason: 'retry hanging generation', deliveryId: delivery.deliveryId,
  }, {
    deliveryStore: store,
    cache: {},
    clock,
    env: {},
    machineFactory: shortLeaseMachine,
    buildEngine: () => ({ ai, outputs: [output], options: { generationTimeoutMs: 25_000 } }),
  }));

  assert.equal(result.status, 'generation_exhausted');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(aborted, true);
  assert.equal(JSON.stringify(result).includes('dashboard raw private body'), false);
});

test('dashboard output recovery aborts a never-resolving send before the attempt lease', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const clock = () => new Date('2026-07-20T01:15:00.000Z');
  let signal;
  let aborted = false;
  const output = {
    id: 'dashboard-hanging-output', deliveryKey: 'dashboard-hanging-destination', maxLength: 70,
    async send(_content, options) {
      signal = options.signal;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  };
  const seedMachine = new DeliveryStateMachine({ store, channelId: 'news', clock });
  const delivery = await seedMachine.prepareDelivery({
    requestId: 'dashboard-output-timeout-seed', mode: 'drip', publishingDay: '2026-07-20',
    articles: [{ id: 'dashboard-output-private', title: 'Private', content: 'dashboard output private body', source: 'Fixture' }],
    outputs: [output],
  });
  const generation = await seedMachine.claimGeneration(delivery.deliveryId, { requestId: 'dashboard-output-timeout-seed' });
  await seedMachine.commitGeneration(generation.attempt.attemptId, { content: 'dashboard private generated content '.repeat(8) });
  const firstOutput = await seedMachine.claimNextOutput(delivery.deliveryId, { requestId: 'dashboard-output-timeout-seed' });
  await seedMachine.commitOutput(firstOutput.attempt.attemptId, {
    success: false,
    meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'seed timeout' },
  });
  const target = await seedMachine.getOutput(delivery.deliveryId, firstOutput.output.outputKey);
  const result = await settlesWithin(executeStreamControl({
    ...stream,
    outputs: [{ type: 'fixture', config: {} }],
  }, {
    action: 'retry-output', idempotencyKey: 'dashboard-output-timeout', expectedVersion: target.version,
    operatorId: 'operator-user', reason: 'retry hanging output', deliveryId: delivery.deliveryId,
    outputKey: target.outputKey, confirmDuplicateRisk: true,
  }, {
    deliveryStore: store,
    cache: {},
    clock,
    env: {},
    machineFactory: shortLeaseMachine,
    buildEngine: () => ({ outputs: [output], options: { outputTimeoutMs: 25_000 } }),
  }));

  assert.equal(result.status, 'needs_reconciliation');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(aborted, true);
  assert.equal(JSON.stringify(result).includes('dashboard private generated content'), false);
  assert.equal(JSON.stringify(result).includes('dashboard output private body'), false);
});

test('dashboard output recovery validates the full topology before reconcile or provider I/O', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  let sends = 0;
  const originalOutputs = [
    { id: 'primary', deliveryKey: 'primary-destination' },
    { id: 'secondary', deliveryKey: 'secondary-destination' },
  ];
  const machine = new DeliveryStateMachine({ store, channelId: 'news' });
  const delivery = await machine.prepareDelivery({
    requestId: 'topology-seed', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'article', title: 'Title', content: 'body', source: 'Fixture' }],
    outputs: originalOutputs,
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'topology-seed' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const claimed = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'topology-seed' });
  await machine.commitOutput(claimed.attempt.attemptId, {
    success: false,
    meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'timeout' },
  });
  const target = await machine.getOutput(delivery.deliveryId, claimed.output.outputKey);
  const attemptsBefore = await store.list('attempts');
  await assert.rejects(executeStreamControl(stream, {
    action: 'retry-output', idempotencyKey: 'topology-retry', expectedVersion: target.version,
    operatorId: 'operator-user', reason: 'retry after provider verification', deliveryId: delivery.deliveryId,
    outputKey: target.outputKey, confirmDuplicateRisk: true,
  }, {
    deliveryStore: store,
    cache: {},
    env: {},
    buildEngine: () => ({
      outputs: [
        { ...originalOutputs[0], async send() { sends += 1; return { success: true }; } },
        { ...originalOutputs[1], deliveryKey: 'changed-secondary-destination' },
      ],
    }),
  }), /output topology changed before operator retry/i);

  assert.equal(sends, 0);
  assert.deepEqual(await store.list('operator_actions'), []);
  assert.deepEqual(await store.list('attempts'), attemptsBefore);
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'needs_reconciliation');
});

test('dashboard recovery rejects a delivery owned by another stream without mutation', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const otherMachine = new DeliveryStateMachine({ store, channelId: 'other-stream' });
  const delivery = await otherMachine.prepareDelivery({
    requestId: 'other-request', mode: 'digest', publishingDay: '2026-07-20',
    articles: [{ id: 'other', title: 'Other', content: 'body', source: 'Fixture' }],
    outputs: [{ id: 'other-output', deliveryKey: 'other-destination' }],
  });
  const before = {
    actions: await store.list('operator_actions'),
    attempts: await store.list('attempts'),
    deliveries: await store.list('deliveries'),
    channels: await store.list('channel_state'),
  };
  await assert.rejects(executeStreamControl(stream, {
    action: 'retry-generation', idempotencyKey: 'cross-stream', expectedVersion: delivery.version,
    operatorId: 'operator', reason: 'must stay stream-local', deliveryId: delivery.deliveryId,
  }, {
    deliveryStore: store,
    cache: {},
    env: {},
    buildEngine: () => { throw new Error('must reject before engine construction'); },
  }), /not found/i);
  assert.deepEqual(await store.list('operator_actions'), before.actions);
  assert.deepEqual(await store.list('attempts'), before.attempts);
  assert.deepEqual(await store.list('deliveries'), before.deliveries);
  assert.deepEqual(await store.list('channel_state'), before.channels);
});
