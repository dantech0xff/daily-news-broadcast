import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChannelViaApi,
  createCredentialsViaApi,
  resumeViaApi,
  startTestApp,
  waitForRun,
} from './helpers/app-server.js';
import { techArticle } from './helpers/runtime-fixture.js';

const AI_TEXT = 'Rust 2.0 chính thức hỗ trợ async closures.';

/** One run that delivers a fresh article and rejects one published before the cutover mark. */
async function libraryFixture(t) {
  const app = await startTestApp(t, {
    aiText: AI_TEXT,
    articles: [
      techArticle('fresh', 'Rust 2.0 compiler ships async closures', { publishedAt: '2026-10-03T06:00:00.000Z' }),
      techArticle('old', 'GPU kernels land in Linux 7.0', { publishedAt: '2026-10-01T00:00:00.000Z' }),
    ],
  });
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids, { notBefore: '2026-10-02T00:00:00Z' });
  assert.equal((await resumeViaApi(app.api, 'telegram-ops')).status, 200);
  const queued = await app.api('/api/channels/telegram-ops/run', { as: 'operator', method: 'POST' });
  const run = await waitForRun(app.api, queued.body.runId);
  assert.equal(run.status, 'success');
  return app;
}

test('the library lists delivered and rejected articles with filters and pagination', async t => {
  const app = await libraryFixture(t);
  const all = await app.api('/api/content', { as: 'viewer' });
  assert.equal(all.status, 200);
  assert.equal(all.body.page.total, 2);
  assert.equal(all.headers['cache-control'], 'no-store');

  const delivered = (await app.api('/api/content?status=delivered', { as: 'viewer' })).body;
  assert.equal(delivered.items.length, 1);
  const [item] = delivered.items;
  assert.equal(item.title, 'Rust 2.0 compiler ships async closures');
  assert.equal(item.channelId, 'telegram-ops');
  assert.equal(item.messageId, 'message-1');
  assert.equal(item.deliveredAt, '2026-10-03T08:00:00.000Z');
  assert.equal(item.summaryPreview, AI_TEXT);
  assert.equal('summaryText' in item, false, 'lists carry a preview only');

  const rejected = (await app.api('/api/content?status=rejected', { as: 'viewer' })).body.items;
  assert.deepEqual(rejected.map(entry => [entry.title, entry.rejectReason]), [['GPU kernels land in Linux 7.0', 'before_cutoff']]);

  const detail = await app.api(`/api/content/${item.id}`, { as: 'viewer' });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.summaryText, AI_TEXT);
  const missing = await app.api('/api/content/no-such-item', { as: 'viewer' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'content_not_found');

  const keyword = (await app.api('/api/content?keyword=GPU', { as: 'viewer' })).body;
  assert.deepEqual(keyword.items.map(entry => entry.title), ['GPU kernels land in Linux 7.0']);
  const page = (await app.api('/api/content?status=delivered,rejected&limit=1&offset=1', { as: 'viewer' })).body;
  assert.deepEqual([page.items.length, page.page.limit, page.page.offset, page.page.total], [1, 1, 1, 2]);
  const repeated = (await app.api('/api/content?status=delivered&status=rejected', { as: 'viewer' })).body;
  assert.equal(repeated.page.total, 2);
  const byChannel = (await app.api('/api/content?channelId=telegram-main', { as: 'viewer' })).body;
  assert.equal(byChannel.page.total, 0);
  const deliveredToday = (await app.api(
    `/api/content?dateField=delivered&from=${encodeURIComponent('2026-10-03T07:00:00+07:00')}&to=2026-10-04T00:00:00Z`,
    { as: 'viewer' },
  )).body;
  assert.equal(deliveredToday.page.total, 1);
  assert.equal((await app.api('/api/content?cacheBuster=1', { as: 'viewer' })).status, 200, 'unknown parameters are ignored');

  for (const query of ['status=bogus', 'channelId=Bad%20Id', 'limit=500', 'from=yesterday', 'dateField=updated']) {
    const response = await app.api(`/api/content?${query}`, { as: 'viewer' });
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error, 'validation_failed');
  }
});

test('stats report posts, source health, failure rates, and token usage per day', async t => {
  const app = await libraryFixture(t);
  const range = 'from=2026-10-01T00:00:00Z&to=2026-10-05T00:00:00Z';
  const stats = await app.api(`/api/stats?${range}&utcOffsetMinutes=420`, { as: 'viewer' });
  assert.equal(stats.status, 200, stats.text);
  assert.deepEqual(stats.body.range, {
    from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z', channelId: null, utcOffsetMinutes: 420,
  });
  assert.deepEqual(stats.body.postsPerDay, [{ day: '2026-10-03', channelId: 'telegram-ops', posts: 1 }]);
  assert.deepEqual(stats.body.sourceHealthPerDay.map(entry => [entry.day, entry.sourceId, entry.healthy, entry.failed]), [
    ['2026-10-03', 'recording-source', 1, 0],
  ]);
  const [failures] = stats.body.failureRatesPerDay;
  assert.deepEqual([failures.day, failures.runs, failures.failedRuns, failures.outputFailureRate], ['2026-10-03', 1, 0, 0]);
  assert.deepEqual(stats.body.tokenUsagePerDay, [{ day: '2026-10-03', inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);

  const otherChannel = (await app.api(`/api/stats?${range}&channelId=telegram-main`, { as: 'viewer' })).body;
  assert.deepEqual([otherChannel.postsPerDay, otherChannel.tokenUsagePerDay], [[], []]);
  const missing = await app.api('/api/stats?to=2026-10-05T00:00:00Z', { as: 'viewer' });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.issues.map(issue => [issue.field, issue.code]), [['from', 'required']]);
  const tooLong = await app.api('/api/stats?from=2025-01-01T00:00:00Z&to=2026-10-05T00:00:00Z', { as: 'viewer' });
  assert.equal(tooLong.status, 400);
  assert.equal((await app.api(`/api/stats?${range}&utcOffsetMinutes=900`, { as: 'viewer' })).status, 400);
});
