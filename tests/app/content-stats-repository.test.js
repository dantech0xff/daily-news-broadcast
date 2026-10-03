import test from 'node:test';
import assert from 'node:assert/strict';

import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { ContentRepository } from '../../src/app/db/content-repository.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { RunRepository } from '../../src/app/db/run-repository.js';
import { StatsRepository } from '../../src/app/db/stats-repository.js';
import { ValidationError } from '../../src/app/channels/validation.js';
import { channelArticleHash } from '../../src/core/delivery.js';
import { mutableClock } from './helpers/runtime-fixture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

async function setup(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir });
  const storage = createNodeSqlStorage(db);
  const clock = mutableClock('2026-10-03T08:00:00.000Z');
  return {
    db,
    storage,
    clock,
    content: new ContentRepository({ storage, clock }),
    runs: new RunRepository({ storage }),
    stats: new StatsRepository({ storage }),
  };
}

async function deliveredRow(env, { channelId = 'telegram-main', id, title = id, deliveredAt, summary = `Summary of ${id}`, url, source = 'Feed A', publishedAt = null }) {
  const article = { id, title, url: url ?? `https://example.test/${id}`, source };
  env.content.applyDeliveryProjections([{
    channelId,
    articleKey: await channelArticleHash(channelId, article),
    title,
    url: article.url,
    sourceName: source,
    category: null,
    publishedAt,
    status: 'delivered',
    deliveryId: `delivery-${id}`,
    summaryText: summary,
    messageId: `m-${id}`,
    deliveredAt,
    firstSeenAt: deliveredAt,
    runId: null,
  }]);
}

async function scanRow(env, { channelId = 'telegram-main', id, title = id, status = 'rejected', rejectReason = 'not_tech', seenAt, sourceId = null, source = 'Feed B' }) {
  const article = { id, title, url: `https://example.test/${id}`, source };
  env.content.recordScanObservations([{
    channelId,
    articleKey: await channelArticleHash(channelId, article),
    title,
    url: article.url,
    sourceId,
    sourceName: source,
    category: null,
    publishedAt: null,
    status,
    rejectReason: status === 'rejected' ? rejectReason : null,
    runId: 'run-1',
    seenAt,
  }]);
}

function finishedRun(env, { id, channelId = 'telegram-main', startedAt, status = 'success', generation, outputs, tokens, sources = [] }) {
  env.runs.start({ id, channelId, triggerType: 'scheduled', startedAt: new Date(startedAt) });
  env.runs.finish(id, {
    status,
    finishedAt: new Date(Date.parse(startedAt) + 5_000),
    stats: { generation },
    aiInputTokens: tokens?.[0] ?? null,
    aiOutputTokens: tokens?.[1] ?? null,
    outputsTotal: outputs?.[0] ?? null,
    outputsSucceeded: outputs ? outputs[0] - outputs[1] : null,
    outputsFailed: outputs?.[1] ?? null,
    sourceHealth: sources,
  });
}

test('the library filters by channel, status, source, date field, and keyword, newest first', async t => {
  const env = await setup(t);
  await deliveredRow(env, { id: 'k8s', title: 'Kubernetes 1.40 ships', deliveredAt: '2026-10-02T10:00:00.000Z', publishedAt: '2026-10-02T09:00:00.000Z' });
  await deliveredRow(env, { id: 'rust', title: 'Rust 2.0 lands', deliveredAt: '2026-10-03T07:00:00.000Z', summary: 'Tóm tắt về trình biên dịch Rust' });
  await deliveredRow(env, { channelId: 'telegram-ops', id: 'ops', title: 'Postmortem: DNS outage', deliveredAt: '2026-10-03T06:00:00.000Z' });
  await scanRow(env, { id: 'gossip', title: 'Celebrity wedding', seenAt: '2026-10-03T05:00:00.000Z', sourceId: 'rss-b' });
  await scanRow(env, { id: 'gpu', title: 'GPU news', status: 'selected', seenAt: '2026-10-03T04:00:00.000Z' });

  const ids = query => env.content.list(query).items.map(item => item.title);
  // The default order is the last scan (or, for delivered rows, first sighting), newest first.
  assert.deepEqual(ids({ channelId: 'telegram-main' }), ['Rust 2.0 lands', 'Celebrity wedding', 'GPU news', 'Kubernetes 1.40 ships']);
  assert.deepEqual(ids({ status: 'delivered', dateField: 'delivered' }), ['Rust 2.0 lands', 'Postmortem: DNS outage', 'Kubernetes 1.40 ships']);
  assert.deepEqual(ids({ status: ['selected', 'rejected'] }), ['Celebrity wedding', 'GPU news']);
  assert.deepEqual(ids({ status: 'selected,rejected' }), ['Celebrity wedding', 'GPU news']);
  assert.deepEqual(ids({ source: 'Feed B' }), ['Celebrity wedding', 'GPU news']);
  assert.deepEqual(ids({ source: 'rss-b' }), ['Celebrity wedding']);
  assert.deepEqual(ids({ dateField: 'delivered', from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' }), ['Rust 2.0 lands', 'Postmortem: DNS outage']);
  assert.deepEqual(ids({ dateField: 'published', from: '2026-10-01T00:00:00.000Z' }), ['Kubernetes 1.40 ships']);
  assert.deepEqual(ids({ keyword: 'trình biên dịch' }), ['Rust 2.0 lands'], 'keyword searches the summary');
  assert.deepEqual(ids({ keyword: 'example.test/ops' }), ['Postmortem: DNS outage'], 'keyword searches the URL');
  assert.deepEqual(ids({ keyword: 'kubernetes' }), ['Kubernetes 1.40 ships'], 'keyword search ignores ASCII case');
});

test('keyword wildcards are matched literally', async t => {
  const env = await setup(t);
  await deliveredRow(env, { id: 'percent', title: 'GPU prices drop 50% overnight', deliveredAt: '2026-10-03T07:00:00.000Z' });
  await deliveredRow(env, { id: 'underscore', title: 'Rename snake_case APIs', deliveredAt: '2026-10-03T06:00:00.000Z' });
  await deliveredRow(env, { id: 'plain', title: 'GPU prices drop 50 dollars', deliveredAt: '2026-10-03T05:00:00.000Z' });

  const titles = keyword => env.content.list({ keyword }).items.map(item => item.title);
  assert.deepEqual(titles('50%'), ['GPU prices drop 50% overnight']);
  assert.deepEqual(titles('e_c'), ['Rename snake_case APIs']);
  assert.deepEqual(titles('%'), ['GPU prices drop 50% overnight']);
  assert.deepEqual(titles('\\'), []);
});

test('the library paginates with a total and keeps the full summary for detail views', async t => {
  const env = await setup(t);
  const longSummary = 'x'.repeat(1_000);
  for (let index = 0; index < 5; index++) {
    await deliveredRow(env, { id: `story-${index}`, deliveredAt: `2026-10-03T0${index}:00:00.000Z`, summary: longSummary });
  }
  const page = env.content.list({ limit: 2, offset: 2, dateField: 'delivered' });
  assert.deepEqual(page.page, { limit: 2, offset: 2, total: 5 });
  assert.deepEqual(page.items.map(item => item.title), ['story-2', 'story-1']);
  assert.equal(page.items[0].summaryPreview.length, 300);
  assert.equal(Object.hasOwn(page.items[0], 'summaryText'), false);
  assert.equal(env.content.get(page.items[0].id).summaryText, longSummary);
  assert.equal(env.content.get('missing'), null);
  assert.deepEqual(env.content.list({ limit: '1', offset: '0' }).page, { limit: 1, offset: 0, total: 5 });
});

test('invalid library queries are rejected with field issues', async t => {
  const env = await setup(t);
  const cases = [
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ offset: -1 }, 'offset'],
    [{ status: 'posted' }, 'status'],
    [{ dateField: 'created' }, 'dateField'],
    [{ from: 'yesterday' }, 'from'],
    [{ from: '2026-10-03T00:00:00Z', to: '2026-10-02T00:00:00Z' }, 'to'],
    [{ channelId: 'Bad Id' }, 'channelId'],
    [{ keyword: 'x'.repeat(201) }, 'keyword'],
    [{ sort: 'title' }, 'sort'],
  ];
  for (const [query, field] of cases) {
    assert.throws(() => env.content.list(query), error => (
      error instanceof ValidationError && error.issues.some(issue => issue.field === field)
    ), field);
  }
});

test('statistics aggregate posts, source health, failure rates, and token usage per day', async t => {
  const env = await setup(t);
  await deliveredRow(env, { id: 'a', deliveredAt: '2026-10-02T09:00:00.000Z' });
  await deliveredRow(env, { id: 'b', deliveredAt: '2026-10-02T20:00:00.000Z' });
  await deliveredRow(env, { id: 'c', deliveredAt: '2026-10-03T03:00:00.000Z' });
  await deliveredRow(env, { channelId: 'telegram-ops', id: 'd', deliveredAt: '2026-10-03T04:00:00.000Z' });
  await scanRow(env, { id: 'rejected', seenAt: '2026-10-03T04:00:00.000Z' });
  finishedRun(env, {
    id: 'run-1', startedAt: '2026-10-02T09:00:00.000Z', generation: { attempted: 4, succeeded: 3, failed: 1 }, outputs: [3, 1], tokens: [100, 50],
    sources: [
      { sourceId: 'rss-a', sourceName: 'Feed A', status: 'healthy', articleCount: 3, errorClass: null },
      { sourceId: 'rss-b', sourceName: 'Feed B', status: 'failed', articleCount: 0, errorClass: 'http' },
    ],
  });
  finishedRun(env, {
    id: 'run-2', startedAt: '2026-10-03T03:00:00.000Z', status: 'failed', generation: { attempted: 0, succeeded: 0, failed: 0 }, outputs: [0, 0], tokens: [10, 5],
    sources: [{ sourceId: 'rss-a', sourceName: 'Feed A', status: 'empty', articleCount: 0, errorClass: null }],
  });
  finishedRun(env, { id: 'ops-run', channelId: 'telegram-ops', startedAt: '2026-10-03T04:00:00.000Z', generation: { attempted: 1, succeeded: 1, failed: 0 }, outputs: [1, 0], tokens: [7, 3] });
  env.runs.start({ id: 'in-flight', channelId: 'telegram-main', triggerType: 'manual', startedAt: new Date('2026-10-03T05:00:00.000Z') });

  const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' };
  const all = env.stats.getStats(range);

  assert.deepEqual(all.range, { ...range, channelId: null, utcOffsetMinutes: 0 });
  assert.deepEqual(all.postsPerDay, [
    { day: '2026-10-02', channelId: 'telegram-main', posts: 2 },
    { day: '2026-10-03', channelId: 'telegram-main', posts: 1 },
    { day: '2026-10-03', channelId: 'telegram-ops', posts: 1 },
  ]);
  assert.deepEqual(all.sourceHealthPerDay, [
    { day: '2026-10-02', sourceId: 'rss-a', sourceName: 'Feed A', healthy: 1, empty: 0, failed: 0, articles: 3 },
    { day: '2026-10-02', sourceId: 'rss-b', sourceName: 'Feed B', healthy: 0, empty: 0, failed: 1, articles: 0 },
    { day: '2026-10-03', sourceId: 'rss-a', sourceName: 'Feed A', healthy: 0, empty: 1, failed: 0, articles: 0 },
  ]);
  assert.deepEqual(all.failureRatesPerDay, [
    {
      day: '2026-10-02', runs: 1, failedRuns: 0, generationAttempts: 4, generationFailures: 1, generationFailureRate: 0.25,
      outputAttempts: 3, outputFailures: 1, outputFailureRate: 1 / 3,
    },
    {
      day: '2026-10-03', runs: 2, failedRuns: 1, generationAttempts: 1, generationFailures: 0, generationFailureRate: 0,
      outputAttempts: 1, outputFailures: 0, outputFailureRate: 0,
    },
  ]);
  assert.deepEqual(all.tokenUsagePerDay, [
    { day: '2026-10-02', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    { day: '2026-10-03', inputTokens: 17, outputTokens: 8, totalTokens: 25 },
  ]);

  const main = env.stats.getStats({ ...range, channelId: 'telegram-main' });
  assert.deepEqual(main.postsPerDay.map(entry => entry.channelId), ['telegram-main', 'telegram-main']);
  assert.deepEqual(main.failureRatesPerDay.map(entry => [entry.day, entry.generationFailureRate]), [['2026-10-02', 0.25], ['2026-10-03', null]]);
  assert.deepEqual(main.tokenUsagePerDay.map(entry => entry.totalTokens), [150, 15]);

  // Vietnam days start at 17:00 UTC, so the 20:00 UTC post belongs to October 3.
  const vietnam = env.stats.postsPerDay({ ...range, channelId: 'telegram-main', utcOffsetMinutes: 420 });
  assert.deepEqual(vietnam, [
    { day: '2026-10-02', channelId: 'telegram-main', posts: 1 },
    { day: '2026-10-03', channelId: 'telegram-main', posts: 2 },
  ]);
  assert.deepEqual(env.stats.tokenUsagePerDay({ from: '2026-10-03T00:00:00Z', to: '2026-10-03T03:00:00Z' }), []);
  // At UTC-5 the 03:00 UTC run of October 3 still falls on October 2.
  assert.deepEqual(env.stats.sourceHealthPerDay({ ...range, utcOffsetMinutes: '-300' }).map(entry => (
    [entry.day, entry.sourceId, entry.healthy, entry.empty, entry.failed]
  )), [['2026-10-02', 'rss-a', 1, 1, 0], ['2026-10-02', 'rss-b', 0, 0, 1]]);
});

test('channel-filtered statistics use the channel/date indexes', async t => {
  const env = await setup(t);
  const statements = [];
  const exec = env.storage.sql.exec;
  const spyStorage = { sql: { exec: (query, ...params) => { statements.push([query, params]); return exec(query, ...params); } } };
  const stats = new StatsRepository({ storage: spyStorage });
  stats.getStats({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', channelId: 'telegram-main' });

  const plans = statements.map(([query, params]) => exec(`EXPLAIN QUERY PLAN ${query}`, ...params).toArray().map(row => row.detail).join(' | '));
  assert.match(plans[0], /app_content_items_channel_delivered/);
  assert.match(plans[1], /app_source_health_channel_observed/);
  assert.match(plans[2], /app_runs_channel_started/);
  assert.match(plans[3], /app_runs_channel_started/);
});

test('invalid statistics ranges are rejected', async t => {
  const env = await setup(t);
  const cases = [
    [{ to: '2026-10-04T00:00:00Z' }, 'from'],
    [{ from: '2026-10-01T00:00:00Z' }, 'to'],
    [{ from: '2026-10-04T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'to'],
    [{ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'to'],
    [{ from: '2026-10-01T00:00:00Z', to: '2026-10-04T00:00:00Z', utcOffsetMinutes: 900 }, 'utcOffsetMinutes'],
    [{ from: '2026-10-01T00:00:00Z', to: '2026-10-04T00:00:00Z', channel: 'x' }, 'channel'],
  ];
  for (const [query, field] of cases) {
    assert.throws(() => env.stats.getStats(query), error => (
      error instanceof ValidationError && error.issues.some(issue => issue.field === field)
    ), field);
  }
});

test('run history pages newest first and reports per-source health on detail', async t => {
  const env = await setup(t);
  for (let index = 0; index < 3; index++) {
    finishedRun(env, {
      id: `run-${index}`,
      startedAt: `2026-10-03T0${index}:00:00.000Z`,
      generation: { attempted: 1, succeeded: 1, failed: 0 },
      outputs: [1, 0],
      tokens: [1, 1],
      sources: [{ sourceId: 'rss-a', sourceName: 'Feed A', status: 'healthy', articleCount: 2, errorClass: null }],
    });
  }
  const page = env.runs.list('telegram-main', { limit: 2 });
  assert.deepEqual(page.page, { limit: 2, offset: 0, total: 3 });
  assert.deepEqual(page.runs.map(run => run.id), ['run-2', 'run-1']);
  assert.equal(page.runs[0].durationMs, 5_000);
  assert.equal(Object.hasOwn(page.runs[0], 'sourceHealth'), false);
  assert.deepEqual(env.runs.get('run-2').sourceHealth, [
    { sourceId: 'rss-a', sourceName: 'Feed A', status: 'healthy', articleCount: 2, errorClass: null, observedAt: '2026-10-03T02:00:05.000Z' },
  ]);
  assert.equal(env.runs.latest('telegram-main').id, 'run-2');
  assert.throws(() => env.runs.list('telegram-main', { limit: 500 }), ValidationError);

  // A finished run is final: a second finish changes nothing.
  env.runs.finish('run-2', { status: 'error', finishedAt: new Date('2026-10-03T09:00:00.000Z'), error: 'late' });
  assert.equal(env.runs.get('run-2').status, 'success');
  env.runs.start({ id: 'left-running', channelId: 'telegram-main', triggerType: 'manual', startedAt: new Date('2026-10-03T07:00:00.000Z') });
  assert.equal(env.runs.interruptStale({ finishedAt: new Date('2026-10-03T08:00:00.000Z') }), 1);
  assert.equal(env.runs.get('left-running').status, 'interrupted');
});
