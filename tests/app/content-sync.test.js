import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTENT_STATUSES, ContentRepository } from '../../src/app/db/content-repository.js';
import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import {
  CONTENT_STATUS_BY_DELIVERY_STATE,
  ContentSync,
  contentStatusForDelivery,
} from '../../src/app/runtime/content-sync.js';
import { channelArticleHash } from '../../src/core/delivery.js';
import { DeliveryStateMachine, deliveryTransitions } from '../../src/core/delivery-state-machine.js';
import { SQLiteDeliveryStore } from '../../src/core/sqlite-delivery-store.js';
import { RecordingOutput } from '../helpers/fakes.js';
import { mutableClock } from './helpers/runtime-fixture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const CHANNEL = 'telegram-ops';
const DAY = '2026-10-03';
const SUCCESS = { success: true, messageId: '4242', meta: { deliveryState: 'success', retryDisposition: 'never' } };
const AMBIGUOUS = { success: false, meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'timeout' } };
const REJECTED = { success: false, meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' } };

function story(id, title = `Kubernetes release ${id}`) {
  return {
    id,
    title,
    url: `https://example.test/${id}`,
    content: `${title} details`,
    source: 'Kubernetes Blog',
    category: 'Cloud',
    publishedAt: '2026-10-03T06:00:00.000Z',
  };
}

async function setup(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  const storage = createNodeSqlStorage(db);
  const store = new SQLiteDeliveryStore(storage);
  await store.initialize();
  runAppMigrations({ db, dataDir: workspace.dataDir });
  const clock = mutableClock('2026-10-03T08:00:00.000Z');
  const content = new ContentRepository({ storage, clock });
  const sync = new ContentSync({ deliveryStore: store, contentRepository: content, logger: { warn() {} } });
  const machine = new DeliveryStateMachine({ store, channelId: CHANNEL, clock });
  const output = new RecordingOutput();
  const prepare = (requestId, articles, mode = 'drip') => machine.prepareDelivery({
    requestId, mode, publishingDay: DAY, articles, outputs: [output],
  });
  const generate = async (delivery, text = `Tóm tắt ${delivery.requestId}`) => {
    const claim = await machine.claimGeneration(delivery.deliveryId, { requestId: delivery.requestId });
    return machine.commitGeneration(claim.attempt.attemptId, { content: text });
  };
  const send = async (delivery, result) => {
    const claim = await machine.claimNextOutput(delivery.deliveryId, { requestId: delivery.requestId });
    return machine.commitOutput(claim.attempt.attemptId, result);
  };
  return { db, storage, store, clock, content, sync, machine, prepare, generate, send };
}

function rowsByTitle(content) {
  return Object.fromEntries(content.list({ channelId: CHANNEL, limit: 100 }).items.map(item => [item.title, item]));
}

test('every delivery state maps to a library status', () => {
  for (const state of Object.keys(deliveryTransitions.delivery)) {
    assert.ok(Object.hasOwn(CONTENT_STATUS_BY_DELIVERY_STATE, state), state);
    assert.ok(CONTENT_STATUSES.includes(contentStatusForDelivery(state)), state);
  }
  assert.equal(contentStatusForDelivery('a_future_state'), 'blocked');
});

test('deliveries project their status, summary, message id, and delivery time', async t => {
  const env = await setup(t);
  const delivered = await env.prepare('delivered', [story('delivered')]);
  await env.generate(delivered, 'Bản tin Kubernetes');
  env.clock.advance(60_000);
  await env.send(delivered, SUCCESS);
  const queued = await env.prepare('queued', [story('queued')]);
  const generationFailed = await env.prepare('generation-failed', [story('generation-failed')]);
  const claim = await env.machine.claimGeneration(generationFailed.deliveryId, { requestId: 'generation-failed' });
  await env.machine.failGeneration(claim.attempt.attemptId, new Error('provider down'), { retryDisposition: 'automatic' });
  const failed = await env.prepare('failed', [story('failed')]);
  await env.generate(failed);
  await env.send(failed, REJECTED);
  const abandoned = await env.prepare('abandoned', [story('abandoned')]);
  const current = await env.machine.getDelivery(abandoned.deliveryId);
  await env.machine.reconcile({
    action: 'abandon',
    deliveryId: abandoned.deliveryId,
    expectedVersion: current.version,
    idempotencyKey: 'abandon-1',
    operatorId: 'ops@example.test',
    reason: 'Not relevant',
  });
  const ambiguous = await env.prepare('ambiguous', [story('ambiguous')]);
  await env.generate(ambiguous);
  await env.send(ambiguous, AMBIGUOUS);

  const result = await env.sync.sync(CHANNEL, { runId: 'run-1' });
  assert.equal(result.deliveries, 6);
  assert.equal(result.changed, 6);

  const rows = rowsByTitle(env.content);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rows).map(([title, row]) => [title, row.status])),
    {
      'Kubernetes release delivered': 'delivered',
      'Kubernetes release queued': 'queued',
      'Kubernetes release generation-failed': 'generation_failed',
      'Kubernetes release failed': 'failed',
      'Kubernetes release abandoned': 'abandoned',
      'Kubernetes release ambiguous': 'ambiguous',
    },
  );
  const sent = rows['Kubernetes release delivered'];
  assert.equal(sent.deliveryId, delivered.deliveryId);
  assert.equal(sent.messageId, '4242');
  assert.equal(sent.deliveredAt, '2026-10-03T08:01:00.000Z');
  assert.equal(sent.articleKey, await channelArticleHash(CHANNEL, story('delivered')));
  assert.equal(sent.publishedAt, '2026-10-03T06:00:00.000Z');
  assert.equal(sent.sourceName, 'Kubernetes Blog');
  assert.equal(sent.runId, 'run-1');
  assert.equal(env.content.get(sent.id).summaryText, 'Bản tin Kubernetes');
  assert.equal(rows['Kubernetes release queued'].deliveredAt, null);
  assert.equal(rows['Kubernetes release queued'].messageId, null);
});

test('syncing is idempotent and never duplicates rows', async t => {
  const env = await setup(t);
  const delivery = await env.prepare('one', [story('one')]);
  await env.generate(delivery);
  await env.send(delivery, SUCCESS);

  await env.sync.sync(CHANNEL);
  const before = env.content.list({ channelId: CHANNEL }).items;
  env.clock.advance(5 * 60_000);
  const again = await env.sync.sync(CHANNEL);
  const full = await env.sync.sync(CHANNEL, { full: true });

  assert.equal(again.changed, 0);
  assert.equal(full.changed, 0);
  assert.deepEqual(env.content.list({ channelId: CHANNEL }).items, before);
  assert.equal(Number(env.db.prepare('SELECT COUNT(*) AS count FROM app_content_items').get().count), 1);
});

test('a scanned article keeps its library row when it is queued, and scans never downgrade it', async t => {
  const env = await setup(t);
  const article = story('scan-first');
  const articleKey = await channelArticleHash(CHANNEL, article);
  const observation = {
    channelId: CHANNEL,
    articleKey,
    title: article.title,
    url: article.url,
    sourceId: 'k8s-blog',
    sourceName: article.source,
    category: article.category,
    publishedAt: article.publishedAt,
    runId: 'run-scan',
    seenAt: env.clock().toISOString(),
  };
  env.content.recordScanObservations([{ ...observation, status: 'selected', rejectReason: null }]);
  const [scanned] = env.content.list({ channelId: CHANNEL }).items;

  await env.prepare('scan-first', [article]);
  await env.sync.sync(CHANNEL, { runId: 'run-later' });
  env.content.recordScanObservations([{ ...observation, status: 'rejected', rejectReason: 'low_score' }]);

  const [row] = env.content.list({ channelId: CHANNEL }).items;
  assert.equal(row.id, scanned.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.rejectReason, null);
  assert.equal(row.sourceId, 'k8s-blog');
  assert.equal(row.runId, 'run-scan');
  assert.equal(row.firstSeenAt, scanned.firstSeenAt);
});

test('digest deliveries project one row per article sharing the generated summary', async t => {
  const env = await setup(t);
  const digest = await env.prepare('digest', [story('first'), story('second')], 'digest');
  await env.generate(digest, 'Bản tin tổng hợp');
  await env.sync.sync(CHANNEL);
  const rows = Object.values(rowsByTitle(env.content));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.deliveryId, digest.deliveryId);
    assert.equal(env.content.get(row.id).summaryText, 'Bản tin tổng hợp');
  }
});

test('incremental syncs re-read only recently changed deliveries; a full sync re-reads all', async t => {
  const env = await setup(t);
  await env.prepare('stable', [story('stable')]);
  env.clock.advance(60 * 60_000);
  const changing = await env.prepare('changing', [story('changing')]);
  assert.equal((await env.sync.sync(CHANNEL)).deliveries, 2);

  // The next sync re-reads from the newest projected change minus a 10-minute overlap.
  env.clock.advance(60 * 60_000);
  await env.generate(changing);
  const incremental = await env.sync.sync(CHANNEL);
  assert.deepEqual(incremental, { deliveries: 1, changed: 1 });
  assert.equal((await env.sync.sync(CHANNEL, { full: true })).deliveries, 2);
  assert.equal(env.content.get(rowsByTitle(env.content)['Kubernetes release changing'].id).summaryText, 'Tóm tắt changing');
});

test('compacted deliveries and other channels are skipped; concurrent syncs of a channel run one at a time', async t => {
  const env = await setup(t);
  const delivery = await env.prepare('kept', [story('kept')]);
  const other = new DeliveryStateMachine({ store: env.store, channelId: 'telegram-other', clock: env.clock });
  await other.prepareDelivery({ requestId: 'x', mode: 'drip', publishingDay: DAY, articles: [story('other')], outputs: [new RecordingOutput()] });

  const results = await Promise.all([env.sync.sync(CHANNEL), env.sync.sync(CHANNEL), env.sync.sync(CHANNEL)]);
  assert.equal(results[0].changed, 1);
  assert.equal(results[1].changed + results[2].changed, 0);
  assert.deepEqual(env.content.list({}).items.map(item => item.deliveryId), [delivery.deliveryId]);
  assert.throws(() => env.sync.sync(''), TypeError);
});

test('quiet syncs log a sanitized warning instead of failing the caller', async t => {
  const env = await setup(t);
  const warnings = [];
  const failing = new ContentSync({
    deliveryStore: { query: async () => { throw new Error('store offline token=secret-value'); } },
    contentRepository: env.content,
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(await failing.syncQuietly(CHANNEL), null);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes('secret-value'), false);
  await assert.rejects(failing.sync(CHANNEL), /store offline/);
});
