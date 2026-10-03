import test from 'node:test';
import assert from 'node:assert/strict';

import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { closeDatabase, openDatabase } from '../../src/app/db/open-database.js';
import { RuntimeLease } from '../../src/app/db/runtime-lease.js';
import { SQLiteDeliveryStore } from '../../src/core/sqlite-delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import {
  OPERATOR_EMAIL,
  SECRET_VALUES,
  createChannelViaApi,
  createCredentialsViaApi,
  resumeViaApi,
  startTestApp,
  waitForRun,
} from './helpers/app-server.js';
import { channelInput, techArticle } from './helpers/runtime-fixture.js';

const ARTICLES = [
  techArticle('rust-2', 'Rust 2.0 compiler ships async closures'),
  techArticle('gpu', 'GPU kernels land in Linux 7.0'),
];
const MANUAL_FAILURE = { success: false, meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' } };

/** One delivery-store table as persisted (read through a second connection). */
async function readDeliveryTable(dataDir, table) {
  const db = openDatabase({ dataDir });
  try {
    const store = new SQLiteDeliveryStore(createNodeSqlStorage(db));
    await store.initialize();
    return await store.list(table);
  } finally {
    closeDatabase(db);
  }
}

/** Operator actions as audited in the delivery store. */
function readOperatorActions(dataDir) {
  return readDeliveryTable(dataDir, 'operator_actions');
}

async function activeChannel(app, overrides = {}) {
  const ids = await createCredentialsViaApi(app.api);
  const record = await createChannelViaApi(app.api, ids, overrides);
  const resumed = await resumeViaApi(app.api, record.id);
  assert.equal(resumed.status, 200, resumed.text);
  return { ids, record };
}

test('preview is read-only: it summarizes but sends nothing and records nothing', async t => {
  const app = await startTestApp(t, { articles: ARTICLES, aiText: 'Bản xem trước an toàn' });
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  const before = (await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body;

  const preview = await app.api('/api/channels/telegram-ops/preview', { as: 'operator', method: 'POST' });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.body.channelId, 'telegram-ops');
  assert.ok(preview.text.includes('Bản xem trước an toàn'));
  assert.ok(preview.body.aiUsage.attempted >= 1);
  assert.equal(app.plugins.output.calls.length, 0, 'nothing was sent');

  const after = (await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body;
  assert.equal(after.version, before.version);
  assert.equal(after.paused, true);
  assert.equal(after.queue.total, 0);
  assert.equal((await app.api('/api/channels/telegram-ops/runs', { as: 'viewer' })).body.page.total, 0);
  assert.equal((await app.api('/api/content', { as: 'viewer' })).body.page.total, 0);

  const withBody = await app.api('/api/channels/telegram-ops/preview', { as: 'operator', method: 'POST', body: { send: true } });
  assert.equal(withBody.status, 400);
  const missingCredentials = await app.api('/api/channels/telegram-main/preview', { as: 'operator', method: 'POST' });
  assert.equal(missingCredentials.status, 422);
  assert.equal(missingCredentials.body.error, 'missing_credential');
  assert.deepEqual(missingCredentials.body.details.fields, [
    'telegram.botTokenCredentialId', 'telegram.chatIdCredentialId', 'ai.gateway.tokenCredentialId',
  ]);
});

test('a manual run is queued, delivered, and visible in status, queue, runs, and run detail', async t => {
  const app = await startTestApp(t, { articles: ARTICLES });
  const { record } = await activeChannel(app, {
    limits: { batchSize: 2, delayMs: 0, dailyLimit: 5, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
  });

  const queued = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  assert.equal(queued.status, 202, queued.text);
  assert.equal(queued.body.status, 'queued');
  assert.equal(queued.body.channelId, record.id);
  const run = await waitForRun(app.api, queued.body.runId);
  assert.equal(run.status, 'success');
  assert.equal(run.triggerType, 'manual');
  assert.equal(run.stats.triggeredBy, OPERATOR_EMAIL);
  assert.deepEqual(run.sourceHealth.map(entry => [entry.sourceId, entry.status]), [['recording-source', 'healthy']]);
  assert.equal(app.plugins.output.calls.length, 2);

  const status = (await app.api(`/api/channels/${record.id}/status`, { as: 'viewer' })).body;
  assert.equal(status.lastRun.id, queued.body.runId);
  assert.deepEqual(status.queue, { date: '2026-10-03', total: 2, remaining: 0, blocked: 0, delivered: 2 });
  const queue = (await app.api(`/api/channels/${record.id}/queue?day=2026-10-03`, { as: 'viewer' })).body;
  assert.deepEqual(queue.items.map(item => [item.title, item.status]), [
    ['Rust 2.0 compiler ships async closures', 'delivered'],
    ['GPU kernels land in Linux 7.0', 'delivered'],
  ]);
  assert.deepEqual((await app.api(`/api/channels/${record.id}/queue?day=2026-10-02`, { as: 'viewer' })).body.items, []);
  const badDay = await app.api(`/api/channels/${record.id}/queue?day=2026-02-30`, { as: 'viewer' });
  assert.equal(badDay.status, 400);

  const runs = (await app.api(`/api/channels/${record.id}/runs?limit=1`, { as: 'viewer' })).body;
  assert.equal(runs.page.total, 1);
  assert.equal(runs.runs[0].id, queued.body.runId);
  assert.equal((await app.api(`/api/channels/${record.id}/runs?limit=0`, { as: 'viewer' })).status, 400);
  const missingRun = await app.api('/api/runs/not-a-run', { as: 'viewer' });
  assert.equal(missingRun.status, 404);
  assert.equal(missingRun.body.error, 'run_not_found');

  const forced = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST', body: { force: true } });
  assert.equal(forced.status, 400, 'manual runs never accept force');
});

test('a channel already running answers 409 channel_busy; disabled channels cannot be run', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  class GatedSource extends RecordingSource {
    async fetch() {
      started();
      await gate;
      return super.fetch();
    }
  }
  const source = new GatedSource(ARTICLES);
  const app = await startTestApp(t, {
    dependencies: {
      channelFactories: {
        createSources: () => [source],
        createAI: () => new RecordingAI('ok'),
        createOutput: () => new RecordingOutput(),
      },
    },
  });
  const { record } = await activeChannel(app);
  const first = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  assert.equal(first.status, 202);
  await fetching;
  const second = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'channel_busy');
  release();
  await waitForRun(app.api, first.body.runId);

  await app.api(`/api/channels/${record.id}`, { as: 'operator', method: 'PUT', body: { version: 1, enabled: false } });
  const disabled = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.error, 'channel_disabled');
});

test('controls validate input, use the token identity, replay idempotently, and reject stale versions', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  const path = '/api/channels/telegram-ops/control';
  const { version } = (await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body;

  const invalid = await app.api(`${path}/resume`, { as: 'operator', method: 'POST', body: { expectedVersion: version, reason: 'r'.repeat(501), operatorId: 'attacker' } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.issues.map(issue => [issue.field, issue.code]).sort(), [
    ['idempotencyKey', 'required'],
    ['operatorId', 'unknown_field'],
    ['reason', 'too_long'],
  ]);
  const unknownAction = await app.api(`${path}/delete-everything`, { as: 'operator', method: 'POST', body: { idempotencyKey: 'k', expectedVersion: 1, reason: 'r' } });
  assert.equal(unknownAction.status, 400);
  assert.deepEqual(unknownAction.body.issues.map(issue => issue.field), ['action']);
  const missingChannel = await app.api('/api/channels/nope/control/pause', { as: 'operator', method: 'POST', body: { idempotencyKey: 'k', expectedVersion: 1, reason: 'r' } });
  assert.equal(missingChannel.status, 404);

  const stale = await app.api(`${path}/resume`, { as: 'operator', method: 'POST', body: { idempotencyKey: 'stale', expectedVersion: version + 5, reason: 'Go' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version_conflict');

  const body = { idempotencyKey: 'resume-1', expectedVersion: version, reason: 'Cutover approved' };
  const resumed = await app.api(`${path}/resume`, { as: 'operator', method: 'POST', body });
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(resumed.body, { channelId: 'telegram-ops', action: 'resume', status: 'resumed', replayed: false, paused: false, version: version + 1 });
  const replay = await app.api(`${path}/resume`, { as: 'operator', method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body.paused, false);

  const paused = await app.api(`${path}/pause`, {
    as: 'serviceOperator', method: 'POST', body: { idempotencyKey: 'pause-1', expectedVersion: version + 1, reason: 'Agent check' },
  });
  assert.equal(paused.status, 200, paused.text);
  const audited = (await readOperatorActions(app.dataDir))
    .filter(action => action.channelId === 'telegram-ops')
    .map(action => [action.action, action.operatorId]);
  assert.ok(audited.some(([action, operatorId]) => action === 'resume' && operatorId === OPERATOR_EMAIL), JSON.stringify(audited));
  assert.ok(audited.some(([action, operatorId]) => action === 'pause' && operatorId === 'service:svc-operator.access'), JSON.stringify(audited));
  assert.equal(audited.some(([, operatorId]) => operatorId === 'attacker'), false);
});

test('resume is refused with 422 while the channel lacks credentials', async t => {
  const app = await startTestApp(t);
  // Past the cutover guard (notBefore set), the missing credentials are what blocks the resume.
  const record = (await app.api('/api/channels/telegram-main', { as: 'viewer' })).body;
  const cutover = await app.api('/api/channels/telegram-main', {
    as: 'operator', method: 'PUT', body: { version: record.version, notBefore: '2026-10-03T08:00:00Z' },
  });
  assert.equal(cutover.status, 200, cutover.text);
  const { version } = (await app.api('/api/channels/telegram-main/status', { as: 'viewer' })).body;
  const response = await app.api('/api/channels/telegram-main/control/resume', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'resume-seed', expectedVersion: version, reason: 'Too early' },
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'missing_credential');
  assert.equal((await app.api('/api/channels/telegram-main/status', { as: 'viewer' })).body.paused, true);
});

/** Give the seeded telegram-main every credential it needs (it uses Gemini through the AI Gateway). */
async function credentialSeedChannel(app) {
  const ids = await createCredentialsViaApi(app.api);
  const gateway = await app.api('/api/credentials', {
    as: 'operator', method: 'POST', body: { label: 'Gateway', kind: 'ai_gateway_token', value: 'gateway-token-secret' },
  });
  assert.equal(gateway.status, 201, gateway.text);
  const record = (await app.api('/api/channels/telegram-main', { as: 'viewer' })).body;
  const updated = await app.api('/api/channels/telegram-main', {
    as: 'operator',
    method: 'PUT',
    body: {
      version: record.version,
      telegram: { botTokenCredentialId: ids.botToken, chatIdCredentialId: ids.chatId },
      ai: { ...record.ai, gateway: { ...record.ai.gateway, tokenCredentialId: gateway.body.id } },
    },
  });
  assert.equal(updated.status, 200, updated.text);
  return updated.body;
}

test('the seeded telegram-main cannot start delivering before its cutover instant is set', async t => {
  const app = await startTestApp(t, { articles: ARTICLES });
  const record = await credentialSeedChannel(app);
  assert.equal(record.cutoverRequired, true);
  assert.equal(record.notBefore, null);
  const status = (await app.api('/api/channels/telegram-main/status', { as: 'viewer' })).body;
  assert.equal(status.cutoverRequired, true);
  assert.equal(status.paused, true);

  const resume = idempotencyKey => app.api('/api/channels/telegram-main/control/resume', {
    as: 'operator', method: 'POST', body: { idempotencyKey, expectedVersion: status.version, reason: 'Cutover' },
  });
  const refusals = [
    await resume('resume-before-cutover'),
    await app.api('/api/channels/telegram-main/run', { as: 'operator', method: 'POST' }),
    await app.api('/api/channels/telegram-main/control/retry-output', {
      as: 'operator',
      method: 'POST',
      body: { idempotencyKey: 'retry-before-cutover', expectedVersion: 1, deliveryId: 'delivery-1', outputKey: 'output-1', reason: 'Too early' },
    }),
  ];
  for (const refused of refusals) {
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'cutover_required');
    assert.match(refused.body.message, /Kênh cần đặt mốc cutover \(notBefore\)/);
  }

  // The flag is read-only: an update cannot clear it.
  const cleared = await app.api('/api/channels/telegram-main', {
    as: 'operator', method: 'PUT', body: { version: record.version, cutoverRequired: false },
  });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.body.cutoverRequired, true);
  // Preview stays available before the cutover and sends nothing.
  const preview = await app.api('/api/channels/telegram-main/preview', { as: 'operator', method: 'POST' });
  assert.equal(preview.status, 200, preview.text);
  const unchanged = (await app.api('/api/channels/telegram-main/status', { as: 'viewer' })).body;
  assert.equal(unchanged.paused, true);
  assert.equal(unchanged.version, status.version, 'the refusals changed no delivery state');
  assert.equal(app.plugins.output.calls.length, 0);

  // Once notBefore is set the guard passes.
  const cutover = await app.api('/api/channels/telegram-main', {
    as: 'operator', method: 'PUT', body: { version: cleared.body.version, notBefore: '2026-10-03T08:00:00Z' },
  });
  assert.equal(cutover.status, 200, cutover.text);
  assert.equal(cutover.body.cutoverRequired, true);
  const resumed = await resume('resume-after-cutover');
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.body.paused, false);
  const run = await app.api('/api/channels/telegram-main/run', { as: 'operator', method: 'POST' });
  assert.equal(run.status, 202, run.text);
  assert.equal((await waitForRun(app.api, run.body.runId)).status, 'success');
  assert.equal(app.plugins.output.calls.length, 1);
});

test('channels created through the API never need a cutover, even when the body asks for one', async t => {
  const app = await startTestApp(t, { articles: ARTICLES });
  const ids = await createCredentialsViaApi(app.api);
  const created = await app.api('/api/channels', {
    as: 'operator', method: 'POST', body: { ...channelInput(ids), cutoverRequired: true },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.cutoverRequired, false);
  assert.equal(created.body.notBefore, null);
  assert.equal((await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body.cutoverRequired, false);
  assert.equal((await resumeViaApi(app.api, 'telegram-ops')).status, 200);
  const run = await app.api('/api/channels/telegram-ops/run', { as: 'operator', method: 'POST' });
  assert.equal(run.status, 202, run.text);
  await waitForRun(app.api, run.body.runId);
  assert.equal(app.plugins.output.calls.length, 1);
});

test('unresolved deliveries are listed with their allowed actions and can be abandoned', async t => {
  const app = await startTestApp(t, { articles: [ARTICLES[0]], outputResults: [MANUAL_FAILURE] });
  const { record } = await activeChannel(app);
  const queued = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  await waitForRun(app.api, queued.body.runId);

  const unresolved = (await app.api(`/api/channels/${record.id}/unresolved?limit=10`, { as: 'viewer' })).body;
  assert.ok(unresolved.page.total >= 1);
  const target = unresolved.targets.find(entry => entry.kind === 'delivery');
  assert.ok(target.allowedActions.includes('abandon'));
  assert.equal(target.title, 'Rust 2.0 compiler ships async closures');
  assert.equal((await app.api(`/api/channels/${record.id}/unresolved?limit=abc`, { as: 'viewer' })).status, 400);
  assert.equal((await app.api(`/api/channels/${record.id}/status`, { as: 'viewer' })).body.unresolvedCount, unresolved.page.total);

  const abandoned = await app.api(`/api/channels/${record.id}/control/abandon`, {
    as: 'operator',
    method: 'POST',
    body: { idempotencyKey: 'abandon-1', expectedVersion: target.expectedVersion, deliveryId: target.deliveryId, reason: 'Not worth a retry' },
  });
  assert.equal(abandoned.status, 200, abandoned.text);
  assert.equal(abandoned.body.deliveryId, target.deliveryId);
  assert.equal(abandoned.body.deliveryState, 'abandoned');
  assert.equal((await app.api(`/api/channels/${record.id}/unresolved`, { as: 'viewer' })).body.page.total, 0);
  const unknownTarget = await app.api(`/api/channels/${record.id}/control/abandon`, {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'abandon-2', expectedVersion: 1, deliveryId: 'missing-delivery', reason: 'x' },
  });
  assert.equal(unknownTarget.status, 404);
  assert.equal(unknownTarget.body.error, 'target_not_found');
});

test('recovery targets and run history carry identifiers, states, versions, and titles only, page by page', async t => {
  const summary = 'Private generated summary that only the content library shows';
  const systemPrompt = 'Private operator system prompt of this channel';
  const failure = {
    success: false,
    error: 'provider body={"api_key":"raw-api-key"}',
    meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected at https://secret.example/hook Bearer raw-bearer' },
  };
  const app = await startTestApp(t, { articles: ARTICLES, aiText: summary, outputResults: [failure, failure] });
  const { record } = await activeChannel(app, {
    prompt: { language: 'vi', style: 'digest', audience: 'IT', customSystemPrompt: systemPrompt },
    limits: { batchSize: 2, delayMs: 0, dailyLimit: 5, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
  });
  const queued = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  const run = await waitForRun(app.api, queued.body.runId);
  assert.equal(run.status, 'failed');

  const path = `/api/channels/${record.id}/unresolved`;
  const all = (await app.api(`${path}?limit=100`, { as: 'viewer' })).body;
  assert.equal(all.page.total, 4, 'two failed deliveries and their two outputs');
  const pages = [
    (await app.api(`${path}?limit=3&offset=0`, { as: 'viewer' })).body,
    (await app.api(`${path}?limit=3&offset=3`, { as: 'viewer' })).body,
  ];
  assert.deepEqual(pages.map(page => [page.page.total, page.targets.length]), [[4, 3], [4, 1]]);
  assert.deepEqual(pages.flatMap(page => page.targets), all.targets, 'pages split one stable order');
  assert.deepEqual(Object.keys(all.channel).sort(), ['allowedActions', 'channelId', 'expectedVersion', 'state']);
  const targetFields = new Set(['kind', 'deliveryId', 'outputKey', 'outboxId', 'state', 'expectedVersion', 'allowedActions', 'title', 'articleCount', 'mode', 'publishingDay']);
  for (const target of all.targets) {
    assert.deepEqual(Object.keys(target).filter(key => !targetFields.has(key)), [], JSON.stringify(target));
    assert.ok(Number.isSafeInteger(target.expectedVersion));
  }
  assert.deepEqual([...new Set(all.targets.map(target => target.title))].sort(), ARTICLES.map(article => article.title).sort());

  const history = [
    (await app.api(`/api/channels/${record.id}/runs`, { as: 'viewer' })).body,
    (await app.api(`/api/runs/${run.id}`, { as: 'viewer' })).body,
  ];
  const outputErrors = history[1].stats.outputResults.map(entry => entry.error);
  assert.equal(outputErrors.length, 2);
  for (const error of outputErrors) assert.match(error, /^rejected at /, 'redaction keeps the generic context');

  const exposed = JSON.stringify({ all, pages, history });
  for (const hidden of [
    summary, systemPrompt, ...ARTICLES.map(article => article.content), 'recording:destination',
    'raw-api-key', 'secret.example', 'raw-bearer', ...Object.values(SECRET_VALUES),
  ]) {
    assert.equal(exposed.includes(hidden), false, hidden);
  }
});

test('controls stay inside their channel: unknown channels and another channel\'s targets change nothing', async t => {
  const app = await startTestApp(t, { articles: [ARTICLES[0]], outputResults: [MANUAL_FAILURE] });
  const { ids, record } = await activeChannel(app);
  const queued = await app.api(`/api/channels/${record.id}/run`, { as: 'operator', method: 'POST' });
  await waitForRun(app.api, queued.body.runId);
  const other = await createChannelViaApi(app.api, ids, { id: 'telegram-alt', name: 'Telegram Alt' });
  assert.equal((await resumeViaApi(app.api, other.id)).status, 200);

  const unresolved = (await app.api(`/api/channels/${record.id}/unresolved`, { as: 'viewer' })).body;
  const delivery = unresolved.targets.find(target => target.kind === 'delivery');
  const output = unresolved.targets.find(target => target.kind === 'output');
  assert.ok(delivery && output, JSON.stringify(unresolved));
  const before = {
    actions: await readOperatorActions(app.dataDir),
    channels: await readDeliveryTable(app.dataDir, 'channel_state'),
    attempts: await readDeliveryTable(app.dataDir, 'attempts'),
    sends: app.plugins.output.calls.length,
  };

  const outputTarget = { expectedVersion: output.expectedVersion, deliveryId: output.deliveryId, outputKey: output.outputKey };
  const attempts = [
    ['/api/channels/no-such-channel/control/pause', { expectedVersion: 1 }, 'channel_not_found'],
    ['/api/channels/no-such-channel/control/abandon', { expectedVersion: delivery.expectedVersion, deliveryId: delivery.deliveryId }, 'channel_not_found'],
    [`/api/channels/${other.id}/control/abandon`, { expectedVersion: delivery.expectedVersion, deliveryId: delivery.deliveryId }, 'target_not_found'],
    [`/api/channels/${other.id}/control/retry-output`, outputTarget, 'target_not_found'],
    [`/api/channels/${other.id}/control/confirm-delivered`, outputTarget, 'target_not_found'],
  ];
  for (const [index, [path, target, error]] of attempts.entries()) {
    const response = await app.api(path, {
      as: 'operator', method: 'POST', body: { idempotencyKey: `cross-${index}`, reason: 'Not this channel', ...target },
    });
    assert.equal(response.status, 404, `${path}: ${response.text}`);
    assert.equal(response.body.error, error, path);
  }

  assert.deepEqual(await readOperatorActions(app.dataDir), before.actions, 'no operator action was recorded');
  assert.deepEqual(await readDeliveryTable(app.dataDir, 'channel_state'), before.channels, 'no channel state was created or changed');
  assert.deepEqual(await readDeliveryTable(app.dataDir, 'attempts'), before.attempts, 'no attempt was claimed');
  assert.equal(app.plugins.output.calls.length, before.sends, 'nothing was sent');
  assert.deepEqual((await app.api(`/api/channels/${record.id}/unresolved`, { as: 'viewer' })).body, unresolved);
});

test('without the runtime lease runs and resumes answer 503 while pause and reads still work', async t => {
  const app = await startTestApp(t, {
    prepare: async (dataDir, clock) => {
      const db = openDatabase({ dataDir });
      try {
        runAppMigrations({ db, dataDir, now: clock() });
        new RuntimeLease({ storage: createNodeSqlStorage(db), clock }).acquire('another-instance', 60_000);
      } finally {
        closeDatabase(db);
      }
    },
  });
  const health = (await app.api('/api/health', { as: 'viewer' })).body;
  assert.equal(health.runtime.active, false);
  assert.equal(health.runtime.leaseHolder.self, false);

  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids, channelInput(ids));
  const run = await app.api('/api/channels/telegram-ops/run', { as: 'operator', method: 'POST' });
  assert.equal(run.status, 503);
  assert.equal(run.body.error, 'runtime_not_leased');
  const { version } = (await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body;
  const resume = await app.api('/api/channels/telegram-ops/control/resume', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'resume-unleased', expectedVersion: version, reason: 'Try' },
  });
  assert.equal(resume.status, 503);
  const pause = await app.api('/api/channels/telegram-main/control/pause', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'pause-unleased', expectedVersion: 2, reason: 'Pause is always allowed' },
  });
  assert.equal(pause.status, 200, pause.text);
  assert.equal(pause.body.status, 'paused');
  assert.equal(pause.body.paused, true);
});
