import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRepository } from '../../src/app/db/content-repository.js';
import { RunRepository } from '../../src/app/db/run-repository.js';
import { ContentSync } from '../../src/app/runtime/content-sync.js';
import { RETENTION_LAST_RUN_SETTING, RetentionJob } from '../../src/app/runtime/retention.js';
import { channelArticleHash } from '../../src/core/delivery.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { RecordingOutput } from '../helpers/fakes.js';
import { createRuntimeDatabase, mutableClock } from './helpers/runtime-fixture.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = '2026-10-03T08:00:00.000Z';
const CHANNEL = 'telegram-ops';

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * DAY_MS);
}

async function setup(t, options = {}) {
  const clock = mutableClock(NOW);
  const database = await createRuntimeDatabase(t, { clock });
  const content = new ContentRepository({ storage: database.storage, clock });
  const runs = new RunRepository({ storage: database.storage });
  const contentSync = new ContentSync({ deliveryStore: database.deliveryStore, contentRepository: content, logger: { warn() {} } });
  const retention = new RetentionJob({
    storage: database.storage,
    deliveryStore: database.deliveryStore,
    contentRepository: content,
    runRepository: runs,
    contentSync,
    listChannelIds: () => [CHANNEL],
    clock,
    logger: { log() {}, warn() {} },
    ...options,
  });
  return { ...database, clock, content, runs, retention };
}

async function libraryRow(env, title, status, { seenDaysAgo, deliveredDaysAgo = null, rejectReason = null }) {
  const article = { id: title, title, url: `https://example.test/${encodeURIComponent(title)}`, source: 'Feed A' };
  const articleKey = await channelArticleHash(CHANNEL, article);
  const seenAt = daysAgo(seenDaysAgo).toISOString();
  env.clock.set(seenAt);
  if (status === 'selected' || status === 'rejected') {
    env.content.recordScanObservations([{
      channelId: CHANNEL, articleKey, title, url: article.url, sourceId: null, sourceName: 'Feed A',
      category: null, publishedAt: null, status, rejectReason, runId: null, seenAt,
    }]);
  } else {
    env.content.applyDeliveryProjections([{
      channelId: CHANNEL, articleKey, title, url: article.url, sourceName: 'Feed A', category: null, publishedAt: null,
      status, deliveryId: `delivery-${title}`, summaryText: 'Summary', messageId: null,
      deliveredAt: deliveredDaysAgo === null ? null : daysAgo(deliveredDaysAgo).toISOString(),
      firstSeenAt: seenAt, runId: null,
    }]);
  }
  env.clock.set(NOW);
}

function titles(env) {
  return env.content.list({ limit: 100 }).items.map(item => item.title).sort();
}

test('undelivered scans are pruned after 30 days; delivered and unresolved items are kept', async t => {
  const env = await setup(t);
  await libraryRow(env, 'old rejected', 'rejected', { seenDaysAgo: 31, rejectReason: 'not_tech' });
  await libraryRow(env, 'old selected', 'selected', { seenDaysAgo: 45 });
  await libraryRow(env, 'old abandoned', 'abandoned', { seenDaysAgo: 40 });
  await libraryRow(env, 'recent rejected', 'rejected', { seenDaysAgo: 29, rejectReason: 'low_score' });
  await libraryRow(env, 'ancient delivered', 'delivered', { seenDaysAgo: 900, deliveredDaysAgo: 899 });
  await libraryRow(env, 'old queued', 'queued', { seenDaysAgo: 60 });
  await libraryRow(env, 'old ambiguous', 'ambiguous', { seenDaysAgo: 60 });
  await libraryRow(env, 'old failed', 'failed', { seenDaysAgo: 60 });

  const result = await env.retention.run();

  assert.equal(result.status, 'completed');
  assert.equal(result.contentPruned, 3);
  assert.deepEqual(titles(env), ['ancient delivered', 'old ambiguous', 'old failed', 'old queued', 'recent rejected']);
});

test('a row seen long ago but changed recently is kept', async t => {
  const env = await setup(t);
  await libraryRow(env, 'stale scan', 'selected', { seenDaysAgo: 40 });
  const [row] = env.content.list({}).items;
  // Abandoned yesterday: its last scan is old, but the change is recent.
  env.clock.set(daysAgo(1).toISOString());
  env.content.applyDeliveryProjections([{
    channelId: CHANNEL, articleKey: row.articleKey, title: row.title, url: row.url, sourceName: 'Feed A', category: null,
    publishedAt: null, status: 'abandoned', deliveryId: 'delivery-x', summaryText: null, messageId: null, deliveredAt: null,
    firstSeenAt: row.firstSeenAt, runId: null,
  }]);
  env.clock.set(NOW);

  await env.retention.run();
  assert.deepEqual(titles(env), ['stale scan']);
});

test('runs and source health older than 180 days are pruned; running runs are kept', async t => {
  const env = await setup(t);
  const record = (id, days, status = 'success') => {
    env.runs.start({ id, channelId: CHANNEL, triggerType: 'scheduled', startedAt: daysAgo(days) });
    if (status !== 'running') {
      env.runs.finish(id, {
        status,
        finishedAt: new Date(daysAgo(days).getTime() + 1_000),
        sourceHealth: [{ sourceId: 'rss-a', sourceName: 'Feed A', status: 'healthy', articleCount: 2, errorClass: null }],
      });
    }
  };
  record('ancient', 181);
  record('stuck', 200, 'running');
  record('recent', 179);

  const result = await env.retention.run();

  assert.deepEqual([result.runsPruned, result.sourceHealthPruned], [1, 1]);
  assert.equal(env.runs.get('ancient'), null);
  assert.equal(env.runs.get('recent').sourceHealth.length, 1);
  assert.equal(env.runs.get('stuck').status, 'running');
});

test('retention runs at most once a day unless forced', async t => {
  const env = await setup(t);
  assert.equal(env.retention.isDue(), true);
  assert.equal((await env.retention.run()).status, 'completed');
  assert.equal(env.retention.lastRunAt(), NOW);
  assert.equal(env.retention.isDue(), false);

  env.clock.advance(DAY_MS - 1);
  assert.deepEqual(await env.retention.run(), { status: 'skipped', reason: 'not_due', lastRunAt: NOW });
  assert.equal((await env.retention.run({ force: true })).status, 'completed');

  env.clock.advance(DAY_MS);
  assert.equal(env.retention.isDue(), true);
  const stored = env.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(RETENTION_LAST_RUN_SETTING);
  assert.equal(stored.value, new Date(Date.parse(NOW) + DAY_MS - 1).toISOString());
});

test('deliveries are copied into the library before the delivery store compacts them', async t => {
  const env = await setup(t, { listChannelIds: () => [] });
  env.clock.set(daysAgo(40).toISOString());
  const machine = new DeliveryStateMachine({ store: env.deliveryStore, channelId: CHANNEL, clock: env.clock });
  const output = new RecordingOutput();
  const delivery = await machine.prepareDelivery({
    requestId: 'old', mode: 'drip', publishingDay: '2026-08-24', outputs: [output],
    articles: [{ id: 'old', title: 'Old delivered story', url: 'https://example.test/old', source: 'Feed A' }],
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'old' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'Old summary' });
  const claim = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'old' });
  await machine.commitOutput(claim.attempt.attemptId, { success: true, messageId: '99', meta: { deliveryState: 'success', retryDisposition: 'never' } });
  env.clock.set(NOW);
  assert.equal(env.content.list({}).page.total, 0, 'never synced before retention');

  const result = await env.retention.run();

  assert.deepEqual(result.compactedChannels, [CHANNEL], 'channels are found through their delivery state');
  assert.equal(await env.deliveryStore.get('deliveries', delivery.deliveryId), null, 'compacted after 30 days');
  const [row] = env.content.list({}).items;
  assert.deepEqual([row.title, row.status, row.messageId], ['Old delivered story', 'delivered', '99']);
  assert.equal(env.content.get(row.id).summaryText, 'Old summary');
});

test('retention windows are validated', async t => {
  const env = await setup(t);
  for (const contentScanDays of [0, 1.5, 4_000]) {
    assert.throws(() => new RetentionJob({
      storage: env.storage, deliveryStore: env.deliveryStore, contentRepository: env.content, runRepository: env.runs,
      contentSync: null, listChannelIds: () => [], contentScanDays,
    }), TypeError);
  }
});
