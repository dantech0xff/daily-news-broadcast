import test from 'node:test';
import assert from 'node:assert/strict';

import { NewsEngine } from '../../src/core/engine.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

const article = {
  id: 'drip-1',
  title: 'Drip survives failure',
  url: 'https://example.com/drip',
  content: 'Details',
  source: 'Example',
};

test('drip keeps a failed item durably blocked instead of shifting it away', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput({
    results: [{
      success: false,
      meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' },
    }],
  });
  const engine = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  const result = await engine.runDrip({ batchSize: 1, requestId: 'drip-run-1' });
  assert.equal(result.status, 'failed');
  const queue = await engine.getQueue({ publishingDay: result.publishingDay });
  assert.equal(queue.remaining, 1);
  assert.equal(queue.blocked, 1);
  assert.equal(queue.articles[0].state, 'blocked');
});

test('a blocked drip item does not starve a later runnable item', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const secondArticle = { ...article, id: 'drip-later', url: 'https://example.com/drip-later', title: 'Later item' };
  const output = new RecordingOutput({
    results: [{
      success: false,
      meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' },
    }],
  });
  const engine = new NewsEngine()
    .addSource(new RecordingSource([article, secondArticle]))
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'blocked-first' })).status, 'failed');
  const later = await engine.runDrip({ batchSize: 1, requestId: 'later-runnable' });
  assert.equal(later.status, 'success');
  assert.equal(later.articles[0].article, 'Later item');
  assert.equal(output.calls.length, 2);
  const queue = await engine.getQueue({ publishingDay: later.publishingDay });
  assert.equal(queue.remaining, 1);
  assert.equal(queue.blocked, 1);
});

test('drip preview is mode-aware and does not create a day batch', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  const result = await engine.runDrip({ dryRun: true, batchSize: 1, requestId: 'drip-preview' });
  assert.equal(result.status, 'dry_run');
  assert.equal(output.calls.length, 0);
  assert.equal((await store.list('day_batches')).length, 0);
  assert.equal((await store.list('deliveries')).length, 0);
});

test('drip performs one bounded healthy refill and records proven exhaustion', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'drip-initial' })).status, 'success');
  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  const exhausted = await engine.runDrip({ batchSize: 1, requestId: 'drip-refill' });
  assert.equal(exhausted.status, 'skipped');
  assert.equal(exhausted.reason, 'batch_exhausted');
  const batch = (await store.list('day_batches'))[0];
  assert.equal(batch.refillCount, 1);
  assert.equal(batch.exhausted, true);
});

test('degraded refill enters bounded backoff and never claims exhaustion', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  await engine.runDrip({ batchSize: 1, requestId: 'drip-initial' });

  source.articles = [];
  source.diagnostic = { status: 'failed', articleCount: 0, failureType: 'transport' };
  const degraded = await engine.runDrip({ batchSize: 1, requestId: 'drip-refill-failed' });
  assert.equal(degraded.status, 'skipped');
  assert.equal(degraded.reason, 'refill_backoff');
  const batch = (await store.list('day_batches'))[0];
  assert.equal(batch.refillCount, 0);
  assert.equal(batch.refillFailureCount, 1);
  assert.equal(batch.exhausted, false);
});

test('only one concurrent run may fetch and commit a day-batch refill', async () => {
  class BlockingSource extends RecordingSource {
    get sourceKey() { return 'blocking-source:feed-a'; }
    async fetch() {
      this.calls += 1;
      if (this.blocked) {
        this.onFetch?.();
        await this.blocked;
      }
      return structuredClone(this.articles);
    }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const source = new BlockingSource([article], { status: 'success', articleCount: 1 });
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  await engine.runDrip({ batchSize: 1, requestId: 'initial-refill-lease' });

  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  source.blocked = new Promise(resolve => { releaseFetch = resolve; });
  source.onFetch = markFetchStarted;

  const first = engine.runDrip({ batchSize: 1, requestId: 'refill-lease-one' });
  await fetchStarted;
  const second = await engine.runDrip({ batchSize: 1, requestId: 'refill-lease-two' });
  assert.equal(second.reason, 'refill_in_flight');
  assert.equal(source.calls, 2);
  releaseFetch();
  const completed = await first;
  assert.equal(completed.reason, 'batch_exhausted');
  assert.equal(source.calls, 2);
});

test('source configuration drift invalidates an exhausted day batch', async () => {
  class MutableTopologySource extends RecordingSource {
    constructor(...args) { super(...args); this.topology = 'feed-a'; }
    get sourceKey() { return `mutable-source:${this.topology}`; }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const source = new MutableTopologySource([article], { status: 'success', articleCount: 1 });
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  await engine.runDrip({ batchSize: 1, requestId: 'topology-initial' });
  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'topology-exhaust' })).reason, 'batch_exhausted');

  source.topology = 'feed-b';
  source.articles = [{ ...article, id: 'drip-2', url: 'https://example.com/drip-2' }];
  source.diagnostic = { status: 'success', articleCount: 1 };
  const refreshed = await engine.runDrip({ batchSize: 1, requestId: 'topology-refreshed' });
  assert.equal(refreshed.status, 'success');
  assert.equal(source.calls, 3);
  assert.equal(output.calls.length, 2);
});

test('source selection policy drift invalidates an exhausted day batch', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, maxArticlesPerSource: 1 });
  await engine.runDrip({ batchSize: 1, requestId: 'selection-initial' });
  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'selection-exhaust' })).reason, 'batch_exhausted');

  source.articles = [{ ...article, id: 'selection-new', url: 'https://example.com/selection-new' }];
  source.diagnostic = { status: 'success', articleCount: 1 };
  engine.configure({ channelId: 'telegram-main', maxRetries: 0, maxArticlesPerSource: 2 });
  const refreshed = await engine.runDrip({ batchSize: 1, requestId: 'selection-refreshed' });
  assert.equal(refreshed.status, 'success');
  assert.equal(source.calls, 3);
  assert.equal(output.calls.length, 2);
});

test('restart adopts initial same-day deliveries persisted before batch linkage', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const initialOutput = new RecordingOutput();
  const clock = () => new Date('2026-07-20T08:00:00.000Z');
  const interrupted = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(initialOutput)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock });
  const machine = await interrupted._ensureMachine();
  const prepared = await interrupted._prepareArticles({ force: false, dryRun: false });
  await interrupted._prepareDripDeliveries(machine, prepared.articles, '2026-07-20');
  assert.equal((await store.list('deliveries')).length, 1);
  assert.equal((await store.list('batch_items')).length, 0);

  const recoveredOutput = new RecordingOutput();
  const recovered = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(recoveredOutput)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock });
  const result = await recovered.runDrip({ batchSize: 1, requestId: 'recover-initial-orphan' });
  assert.equal(result.status, 'success');
  assert.equal(source.calls, 1);
  assert.equal(recoveredOutput.calls.length, 1);
  assert.equal((await store.list('batch_items')).length, 1);
});

test('restart adopts refill deliveries persisted before refill linkage and closes the claim', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const clock = () => new Date('2026-07-20T08:00:00.000Z');
  const initial = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock });
  await initial.runDrip({ batchSize: 1, requestId: 'refill-orphan-initial' });
  const machine = await initial._ensureMachine();
  const batch = (await store.list('day_batches'))[0];
  const claim = await machine.claimBatchRefill({
    batchId: batch.batchId,
    sourceTopologyFingerprint: batch.sourceTopologyFingerprint,
  });
  source.articles = [{ ...article, id: 'refill-orphan', url: 'https://example.com/refill-orphan' }];
  const refill = await initial._prepareArticles({ force: false, dryRun: false });
  await initial._prepareDripDeliveries(machine, refill.articles, '2026-07-20');
  assert.equal(claim.status, 'claimed');
  assert.equal((await store.list('deliveries')).length, 2);
  assert.equal((await store.list('batch_items')).length, 1);

  const recoveredOutput = new RecordingOutput();
  const recovered = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(recoveredOutput)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock });
  const result = await recovered.runDrip({ batchSize: 1, requestId: 'recover-refill-orphan' });
  assert.equal(result.status, 'success');
  assert.equal(source.calls, 2);
  assert.equal(recoveredOutput.calls.length, 1);
  const recoveredBatch = (await store.list('day_batches'))[0];
  assert.equal(recoveredBatch.refillCount, 1);
  assert.equal(recoveredBatch.activeRefillClaimToken, null);
  assert.equal((await store.list('batch_items')).length, 2);
});

test('forced drip replay blocks same-provider destination drift before mutation', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const failedOutput = new RecordingOutput({
    key: 'recording:destination-a',
    results: [{
      success: false,
      meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' },
    }],
  });
  const initial = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('hook'))
    .addOutput(failedOutput)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  const first = await initial.runDrip({
    force: true,
    requestId: 'forced-topology-replay',
    idempotencyKey: 'forced-topology-key',
  });
  assert.equal(first.status, 'failed');

  const changedOutput = new RecordingOutput({ key: 'recording:destination-b' });
  const resumed = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('must-not-regenerate'))
    .addOutput(changedOutput)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  const replay = await resumed.runDrip({
    force: true,
    requestId: 'forced-topology-replay',
    idempotencyKey: 'forced-topology-key',
  });
  assert.equal(replay.status, 'failed');
  assert.equal(replay.reason, 'output_topology_changed');
  assert.equal(changedOutput.calls.length, 0);
});

test('forced drip uses a transient delivery and leaves the normal day batch unchanged', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'normal-drip' })).status, 'success');
  const batchBefore = (await store.list('day_batches'))[0];
  const itemsBefore = await store.list('batch_items');

  const forced = await engine.runDrip({
    force: true,
    requestId: 'forced-drip',
    idempotencyKey: 'forced-drip-key',
  });

  assert.equal(forced.status, 'success');
  assert.equal(output.calls.length, 2);
  assert.equal((await store.list('deliveries')).length, 2);
  assert.deepEqual(await store.list('day_batches'), [batchBefore]);
  assert.deepEqual(await store.list('batch_items'), itemsBefore);
});

test('paused operator canary forwards the single-mutation guard without creating backlog', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const machine = new DeliveryStateMachine({ store, channelId: 'telegram-main', allowEphemeral: true });
  await machine.setPaused(true, {
    expectedVersion: 1,
    idempotencyKey: 'pause-before-canary',
    operatorId: 'test-operator',
    reason: 'offline canary test',
  });
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  const result = await engine.runDrip({
    force: true,
    operatorForce: true,
    confirmPausedMutation: true,
    singleMutation: true,
    requestId: 'canary-request',
    idempotencyKey: 'canary-key',
  });

  assert.equal(result.status, 'success');
  assert.equal(output.calls.length, 1);
  assert.equal(output.calls[0].options.singleMutation, true);
  assert.equal((await store.list('day_batches')).length, 0);
  assert.equal((await store.list('batch_items')).length, 0);
});

test('next-day drip resumes prior-day retryable delivery before fetching a new batch', async () => {
  let now = new Date('2026-07-20T08:00:00.000Z');
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const ai = new RecordingAI('stored hook');
  const output = new RecordingOutput({
    results: [
      {
        success: false,
        meta: {
          deliveryState: 'definitive_failure',
          retryDisposition: 'automatic',
          retryAfterMs: 0,
          sanitizedError: 'temporary rejection',
        },
      },
      {
        success: true,
        messageId: 'recovered-message',
        meta: { deliveryState: 'success', retryDisposition: 'never' },
      },
    ],
  });
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(ai)
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock: () => new Date(now) });

  assert.equal((await engine.runDrip({ batchSize: 1 })).status, 'failed');
  now = new Date('2026-07-21T08:00:00.000Z');
  const recovered = await engine.runDrip({ batchSize: 1 });

  assert.equal(recovered.status, 'success');
  assert.equal(recovered.articles[0].carriedFromPublishingDay, '2026-07-20');
  assert.equal(source.calls, 1);
  assert.equal(ai.calls.length, 1);
  assert.equal(output.calls.length, 2);
});

test('exact forced-drip replay stays bound to its persisted article selection', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('forced hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  const options = {
    force: true,
    requestId: 'stable-force-request',
    idempotencyKey: 'stable-force-key',
  };

  const first = await engine.runDrip(options);
  source.articles = [{
    ...article,
    id: 'drip-2',
    title: 'Different article after replay',
    url: 'https://example.com/drip-2',
  }];
  const replay = await engine.runDrip(options);

  assert.equal(first.deliveryId, replay.deliveryId);
  assert.equal(output.calls.length, 1);
  assert.equal(source.calls, 1);
  assert.equal((await store.list('deliveries')).length, 1);
});

test('old forced-drip replay uses a compact tombstone without refetching or resending', async () => {
  let now = new Date('2026-07-20T08:00:00.000Z');
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const output = new RecordingOutput();
  const engine = new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('private forced hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock: () => new Date(now) });
  const options = {
    force: true,
    requestId: 'retained-force-request',
    idempotencyKey: 'retained-force-key',
  };

  assert.equal((await engine.runDrip(options)).status, 'success');
  now = new Date('2026-08-22T08:00:00.000Z');
  const replay = await engine.runDrip(options);

  assert.equal(replay.status, 'success');
  assert.equal(replay.reason, 'already_complete');
  assert.equal(source.calls, 1);
  assert.equal(output.calls.length, 1);
  const [tombstone] = await store.list('deliveries');
  assert.equal(tombstone.compacted, true);
  assert.equal(tombstone.generatedContent, undefined);
  assert.equal(tombstone.articleSnapshot, undefined);
  assert.deepEqual(await store.list('delivery_outputs'), []);
  assert.deepEqual(await store.list('attempts'), []);
});

test('concurrent first drip runs attach every prepared delivery to the winning day batch', async () => {
  let arrivals = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  class BarrierSource extends RecordingSource {
    async fetch() {
      this.calls += 1;
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return structuredClone(this.articles);
    }
  }
  const store = new MemoryDeliveryStore({ durable: true });
  const outputA = new RecordingOutput({ key: 'telegram:shared-drip' });
  const outputB = new RecordingOutput({ key: 'telegram:shared-drip' });
  const makeEngine = (source, output) => new NewsEngine()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });
  const sourceA = new BarrierSource([article]);
  const sourceB = new BarrierSource([{
    ...article,
    id: 'drip-concurrent-b',
    title: 'Concurrent article B',
    url: 'https://example.com/drip-concurrent-b',
  }]);
  const engineA = makeEngine(sourceA, outputA);
  const engineB = makeEngine(sourceB, outputB);

  await Promise.all([
    engineA.runDrip({ batchSize: 1 }),
    engineB.runDrip({ batchSize: 1 }),
  ]);

  assert.equal((await store.list('deliveries')).length, 2);
  assert.equal((await store.list('batch_items')).length, 2);
  await engineA.runDrip({ batchSize: 1 });
  assert.equal((await store.list('deliveries', value => value.state === 'succeeded')).length, 2);
  assert.equal(outputA.calls.length + outputB.calls.length, 2);
});
