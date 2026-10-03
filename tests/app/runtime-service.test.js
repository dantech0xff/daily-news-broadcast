import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ChannelRepository } from '../../src/app/channels/channel-repository.js';
import { SEED_CHANNEL_ID } from '../../src/app/channels/seed.js';
import { ValidationError } from '../../src/app/channels/validation.js';
import { RunRepository } from '../../src/app/db/run-repository.js';
import { CACHE_FILE_NAME, createRuntime } from '../../src/app/runtime/create-runtime.js';
import { RuntimeError } from '../../src/app/runtime/errors.js';
import { MemoryCache } from '../../src/core/caches.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { RecordingOutput } from '../helpers/fakes.js';
import {
  OPERATOR,
  SECRETS,
  SILENT_LOGGER,
  channelInput,
  createActiveChannel,
  createRuntimeDatabase,
  createRuntimeFixture,
  FakeCron,
  techArticle,
} from './helpers/runtime-fixture.js';

const MANUAL_FAILURE = { success: false, meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' } };

function rejectsWith(code) {
  return error => error instanceof RuntimeError && error.code === code;
}

async function started(t, options) {
  const fixture = await createRuntimeFixture(t, options);
  await fixture.runtime.start();
  const events = [];
  fixture.runtime.onEvent(event => events.push(event));
  return { ...fixture, events };
}

test('the runtime refuses a non-persistent cache and an invalid owner id', async t => {
  const database = await createRuntimeDatabase(t);
  const base = { db: database.db, dataDir: database.workspace.dataDir, vault: database.vault, cron: new FakeCron(), logger: SILENT_LOGGER };
  await assert.rejects(createRuntime({ ...base, cache: new MemoryCache() }), /persistent/);
  await assert.rejects(createRuntime({ ...base, ownerId: '' }), TypeError);
  await assert.rejects(createRuntime({ ...base, db: null }), TypeError);
});

test('output paths use the file cache in the data directory under the news:<channel> prefix', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  await createActiveChannel(env.runtime, env.credentialIds);
  assert.equal((await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true })).status, 'success');

  const cache = JSON.parse(await readFile(join(env.workspace.dataDir, CACHE_FILE_NAME), 'utf8'));
  const keys = Object.keys(cache);
  assert.ok(keys.length > 0);
  assert.ok(keys.every(key => key.startsWith('news:telegram-ops:')), keys.join(', '));
});

test('config and credential changes emit events without secrets', async t => {
  const env = await started(t);
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  const updated = await env.runtime.updateChannel(record.id, { version: record.version, name: 'Renamed' }, OPERATOR);
  const credential = env.runtime.createCredential({ label: 'Second bot', kind: 'telegram_bot_token', value: '987654:NEW-secret-token' }, OPERATOR);
  env.runtime.replaceCredential(credential.id, { value: '987654:REPLACED-secret-token' }, OPERATOR);
  env.runtime.deleteCredential(credential.id, OPERATOR);
  const { version } = await env.runtime.getStatus(record.id);
  await env.runtime.deleteChannel(record.id, OPERATOR, { expectedVersion: updated.version });

  assert.deepEqual(env.events.map(event => [event.type, event.data.action]), [
    ['control.applied', 'pause'],
    ['channel.changed', 'created'],
    ['channel.changed', 'updated'],
    ['credential.changed', 'created'],
    ['credential.changed', 'replaced'],
    ['credential.changed', 'deleted'],
    ['channel.changed', 'deleted'],
  ]);
  assert.equal(version, 2);
  assert.equal(env.events[2].data.version, 2);
  assert.equal(env.events[3].data.kind, 'telegram_bot_token');
  const serialized = JSON.stringify(env.events);
  for (const secret of [...Object.values(SECRETS), '987654:NEW-secret-token', '987654:REPLACED-secret-token']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(JSON.stringify(env.runtime.listCredentials()).includes('NEW-secret'), false);
  assert.equal(Object.isFrozen(env.events[0]) && Object.isFrozen(env.events[0].data), true);
});

test('a throwing event listener does not break the runtime', async t => {
  const env = await started(t);
  env.runtime.onEvent(() => { throw new Error('listener bug'); });
  env.runtime.onEvent(async () => { throw new Error('async listener bug'); });
  const unsubscribe = env.runtime.onEvent(() => {});
  unsubscribe();
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  assert.equal(record.id, 'telegram-ops');
  assert.equal(env.events.length, 2);
});

test('channel status reports delivery state, queue counts, the last run, and unresolved items', async t => {
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures'), techArticle('gpu', 'GPU kernels land in Linux 7.0')],
    outputResults: [{ success: true, messageId: 'm-1', meta: { deliveryState: 'success', retryDisposition: 'never' } }, MANUAL_FAILURE],
  });
  const record = await createActiveChannel(env.runtime, env.credentialIds, {
    limits: { batchSize: 2, delayMs: 0, dailyLimit: 5, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
  });
  const outcome = await env.runtime.runNow(record.id, OPERATOR, { wait: true });
  assert.equal(outcome.status, 'partial');

  const status = await env.runtime.getStatus(record.id);
  const state = await env.deliveryStore.get('channel_state', record.id);
  assert.deepEqual({ ...status, lastRun: undefined }, {
    channelId: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'Asia/Singapore',
    notBefore: null,
    dailyLimit: 5,
    configVersion: 1,
    paused: false,
    version: state.version,
    mutationState: 'free',
    allowedActions: ['pause'],
    scheduled: true,
    running: false,
    queued: false,
    queue: { date: '2026-10-03', total: 2, remaining: 1, blocked: 1, delivered: 1 },
    lastRun: undefined,
    unresolvedCount: 2,
  });
  assert.equal(status.lastRun.id, outcome.runId);
  assert.equal(status.lastRun.status, 'partial');
  assert.equal(status.lastRun.outputsFailed, 1);

  const queue = await env.runtime.listQueue(record.id);
  assert.deepEqual(queue.items.map(item => [item.title, item.status, item.deliveryState]), [
    ['Rust 2.0 compiler ships async closures', 'delivered', 'succeeded'],
    ['GPU kernels land in Linux 7.0', 'failed', 'output_manual_retry_required'],
  ]);
  assert.deepEqual((await env.runtime.listQueue(record.id, '2026-10-02')).items, []);
  await assert.rejects(env.runtime.listQueue(record.id, '2026-02-30'), ValidationError);
  await assert.rejects(env.runtime.getStatus('missing-channel'), { code: 'channel_not_found' });

  const unresolved = await env.runtime.listUnresolved(record.id, { limit: 1 });
  assert.equal(unresolved.page.total, 2);
  assert.equal(unresolved.targets.length, 1);
  assert.equal(unresolved.targets[0].title, 'GPU kernels land in Linux 7.0');
  assert.equal(JSON.stringify(unresolved).includes(SECRETS.chatId), false);
});

test('a channel can be deleted only when paused and fully resolved', async t => {
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [MANUAL_FAILURE],
  });
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  await assert.rejects(env.runtime.deleteChannel(record.id, OPERATOR), rejectsWith('channel_not_paused'));

  await env.runtime.runNow(record.id, OPERATOR, { wait: true });
  const { version } = await env.runtime.getStatus(record.id);
  await env.runtime.control(record.id, 'pause', { idempotencyKey: 'pause', expectedVersion: version, reason: 'Retire' }, OPERATOR);
  const error = await env.runtime.deleteChannel(record.id, OPERATOR).then(() => null, value => value);
  assert.equal(error.code, 'channel_has_unresolved');
  assert.equal(error.details.unresolved, 2);

  const target = (await env.runtime.listUnresolved(record.id)).targets.find(entry => entry.kind === 'delivery');
  await env.runtime.control(record.id, 'abandon', {
    idempotencyKey: 'abandon', expectedVersion: target.expectedVersion, deliveryId: target.deliveryId, reason: 'Retire channel',
  }, OPERATOR);
  assert.deepEqual(await env.runtime.deleteChannel(record.id, OPERATOR), { channelId: record.id, deleted: true });
  assert.equal(env.runtime.getChannel(record.id), null);
  assert.equal(env.cron.active().has(record.id), false);
  assert.equal(env.runtime.listRuns(record.id).page.total, 1, 'run history is kept');
  assert.equal(env.runtime.listContent({ channelId: record.id }).page.total, 1, 'library rows are kept');
});

test('manual runs need an enabled channel and the lease, and do not double-queue', async t => {
  const env = await createRuntimeFixture(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  const disabled = await env.runtime.createChannel(channelInput(env.credentialIds, { id: 'disabled-channel', enabled: false }), OPERATOR);
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  await assert.rejects(env.runtime.runNow(record.id, OPERATOR), rejectsWith('runtime_not_leased'));

  await env.runtime.start();
  await assert.rejects(env.runtime.runNow(disabled.id, OPERATOR), rejectsWith('channel_disabled'));
  await assert.rejects(env.runtime.runNow('missing-channel', OPERATOR), { code: 'channel_not_found' });
  await assert.rejects(env.runtime.runNow(record.id, ''), TypeError);

  const first = await env.runtime.runNow(record.id, OPERATOR);
  const second = await env.runtime.runNow(record.id, OPERATOR);
  assert.equal(first.status, 'queued');
  assert.match(first.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(second, { status: 'skipped', reason: 'channel_busy', channelId: record.id });

  await env.runtime.stop();
  await assert.rejects(env.runtime.runNow(record.id, OPERATOR), rejectsWith('runtime_stopped'));
  await assert.rejects(env.runtime.preview(record.id), rejectsWith('runtime_stopped'));
  await assert.rejects(env.runtime.preview('missing-channel'), { code: 'channel_not_found' });
});

test('seeding creates a paused telegram-main and schedules it once leased', async t => {
  const env = await started(t);
  const result = await env.runtime.seedDefaultChannels();

  assert.deepEqual(result, { seeded: true, channelIds: [SEED_CHANNEL_ID] });
  const status = await env.runtime.getStatus(SEED_CHANNEL_ID);
  assert.equal(status.paused, true);
  assert.deepEqual([env.cron.active().get(SEED_CHANNEL_ID).expression, env.cron.active().get(SEED_CHANNEL_ID).options.timezone], ['0 0-17 * * *', 'UTC']);
  assert.deepEqual((await env.runtime.seedDefaultChannels()), { seeded: false, channelIds: [] });
  assert.deepEqual(env.events.map(event => [event.type, event.data.channelId]), [
    ['control.applied', SEED_CHANNEL_ID],
    ['channel.changed', SEED_CHANNEL_ID],
  ]);
});

test('updating a channel reloads its schedule immediately', async t => {
  const env = await started(t);
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  await env.runtime.updateChannel(record.id, { version: record.version, cron: '30 7 * * 1-5', timezone: 'Asia/Ho_Chi_Minh' }, OPERATOR);
  const task = env.cron.active().get(record.id);
  assert.deepEqual([task.expression, task.options.timezone], ['30 7 * * 1-5', 'Asia/Ho_Chi_Minh']);

  const disabled = await env.runtime.updateChannel(record.id, { version: 2, enabled: false }, OPERATOR);
  assert.equal(env.cron.active().has(record.id), false);
  await assert.rejects(env.runtime.updateChannel(record.id, { name: 'No version' }, OPERATOR), ValidationError);
  await assert.rejects(env.runtime.updateChannel(record.id, { version: 1, enabled: true }, OPERATOR), { code: 'version_conflict' });
  assert.equal(disabled.version, 3);
});

test('a scheduled tick for a channel without delivery state pauses it instead of running', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  // Bypasses the runtime, so the row exists without a paused delivery state.
  new ChannelRepository({ storage: env.storage, clock: env.clock }).create(channelInput(env.credentialIds), { actor: OPERATOR });
  env.runtime.updateChannel('telegram-ops', { version: 1, name: 'Reload' }, OPERATOR);
  env.clock.set('2026-10-03T09:00:00.000Z');

  env.cron.fire('telegram-ops');
  await new Promise(resolve => setImmediate(resolve));
  await env.runtime.stop();

  assert.equal((await env.deliveryStore.get('channel_state', 'telegram-ops')).paused, true);
  assert.equal(env.runtime.listRuns('telegram-ops').page.total, 0);
  assert.equal(env.plugins.source.calls, 0);
});

test('runs left running by a previous process are marked interrupted when the lease is acquired', async t => {
  const env = await createRuntimeFixture(t);
  new RunRepository({ storage: env.storage }).start({
    id: 'orphan', channelId: 'telegram-ops', triggerType: 'scheduled', startedAt: new Date('2026-10-03T07:00:00.000Z'),
  });
  await env.runtime.start();
  const run = env.runtime.getRun('orphan');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.finishedAt, '2026-10-03T08:00:00.000Z');
});

async function waitFor(condition, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not met');
}

for (const retentionDue of [true, false]) {
  test(`start-up maintenance projects deliveries a crashed process never synced (retention ${retentionDue ? 'due' : 'not due'})`, async t => {
    const env = await createRuntimeFixture(t);
    if (!retentionDue) {
      env.db.prepare('INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)')
        .run('runtime.retention.last_run_at', env.clock().toISOString(), env.clock().toISOString());
    }
    const machine = new DeliveryStateMachine({ store: env.deliveryStore, channelId: 'telegram-ops', clock: env.clock });
    await machine.prepareDelivery({
      requestId: 'orphan', mode: 'drip', publishingDay: '2026-10-03', outputs: [new RecordingOutput()],
      articles: [techArticle('orphan', 'Delivery created before a crash')],
    });

    await env.runtime.start();
    await waitFor(() => env.runtime.listContent({}).page.total === 1 && env.runtime.getHealth().running === null);

    const [row] = env.runtime.listContent({}).items;
    assert.deepEqual([row.title, row.status], ['Delivery created before a crash', 'queued']);
    const lastRetention = env.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('runtime.retention.last_run_at');
    assert.equal(lastRetention.value, env.clock().toISOString());
  });
}

test('health reports lease ownership and the work queue', async t => {
  const env = await createRuntimeFixture(t, { ownerId: 'instance-a' });
  assert.deepEqual(env.runtime.getHealth(), {
    ownerId: 'instance-a', active: false, leased: false, leaseHolder: null, running: null, queued: 0, scheduledChannels: 0,
  });
  await env.runtime.start();
  const health = env.runtime.getHealth();
  assert.equal(health.active, true);
  assert.equal(health.leaseHolder.ownerId, 'instance-a');
  assert.equal(health.leaseHolder.expiresAt, '2026-10-03T08:01:00.000Z');
});

test('concurrent previews of one channel share a single dry run', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  const [first, second] = await Promise.all([env.runtime.preview(record.id), env.runtime.preview(record.id)]);
  assert.equal(first, second);
  assert.equal(env.plugins.ai.calls.length, 1);
  await env.runtime.preview(record.id);
  assert.equal(env.plugins.ai.calls.length, 2);
});
