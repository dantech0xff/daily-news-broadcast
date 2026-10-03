import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRecoveryControl } from '../../src/adapters/node.js';
import { ChannelCredentialError } from '../../src/app/channels/build-channel.js';
import { ChannelConflictError } from '../../src/app/channels/channel-repository.js';
import { ChannelValidationError } from '../../src/app/channels/config-schema.js';
import { ValidationError } from '../../src/app/channels/validation.js';
import { NEW_CHANNEL_PAUSE_REASON, readControlParams } from '../../src/app/runtime/controls.js';
import { RuntimeError } from '../../src/app/runtime/errors.js';
import { opaqueId } from '../../src/core/delivery.js';
import { AIPlugin } from '../../src/core/contracts.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { RecordingOutput } from '../helpers/fakes.js';
import {
  OPERATOR,
  SECRETS,
  channelInput,
  createActiveChannel,
  createRuntimeFixture,
  techArticle,
} from './helpers/runtime-fixture.js';

const MANUAL_FAILURE = { success: false, meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' } };
const AMBIGUOUS = { success: false, meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'timeout' } };
const CUSTOM_PROMPT = 'Write for SREs. Lead with operational risk.';

class FlakyAI extends AIPlugin {
  constructor(failures) {
    super();
    this.failures = failures;
    this.calls = [];
  }

  get id() { return 'flaky-ai'; }
  get name() { return 'Flaky AI'; }

  async summarize(articles, { signal, ...options }) {
    this.calls.push({ titles: articles.map(article => article.title), options, hasSignal: signal !== undefined });
    if (this.calls.length <= this.failures) throw new Error('provider unavailable');
    return { text: 'Generated after retry', usage: { input: 3, output: 4 } };
  }
}

async function startedFixture(t, options) {
  const fixture = await createRuntimeFixture(t, options);
  await fixture.runtime.start();
  const events = [];
  fixture.runtime.onEvent(event => events.push(event));
  return { ...fixture, events };
}

async function operatorActions(store, channelId) {
  return (await store.list('operator_actions')).filter(action => action.channelId === channelId);
}

function library(runtime) {
  return Object.fromEntries(runtime.listContent({ limit: 100 }).items.map(item => [item.title, item]));
}

test('pauseChannel works before the channel row exists and is idempotent', async t => {
  const env = await createRuntimeFixture(t);

  const first = await env.runtime.pauseChannel('brand-new', { operatorId: 'system', reason: 'Starts paused' });
  const again = await env.runtime.pauseChannel('brand-new');

  assert.equal(env.runtime.getChannel('brand-new'), null);
  assert.deepEqual(first, { status: 'paused', channelId: 'brand-new', paused: true, version: 2 });
  assert.deepEqual(again, { status: 'already_paused', channelId: 'brand-new', paused: true, version: 2 });
  const state = await env.deliveryStore.get('channel_state', 'brand-new');
  assert.equal(state.paused, true);
  const actions = await operatorActions(env.deliveryStore, 'brand-new');
  assert.deepEqual(actions.map(action => [action.action, action.operatorId]), [['pause', 'system']]);
  assert.equal(actions[0].reasonHash, await opaqueId('operator-reason', 'brand-new', 'Starts paused'));
  await assert.rejects(env.runtime.pauseChannel('Not Kebab'), TypeError);
});

test('concurrent system pauses settle on one paused state', async t => {
  const env = await createRuntimeFixture(t);
  const results = await Promise.all([1, 2, 3].map(() => env.runtime.pauseChannel('racing-channel')));
  assert.equal(results.filter(result => result.status === 'paused').length, 1);
  assert.equal((await env.deliveryStore.get('channel_state', 'racing-channel')).paused, true);
  assert.equal((await operatorActions(env.deliveryStore, 'racing-channel')).length, 1);
});

test('createChannel pauses delivery state before writing the config row', async t => {
  const env = await createRuntimeFixture(t);

  // The insert fails on the credential check, after the pause already happened.
  await assert.rejects(
    env.runtime.createChannel(channelInput(env.credentialIds, { telegram: { botTokenCredentialId: 'missing-credential', chatIdCredentialId: null } }), OPERATOR),
    ChannelValidationError,
  );
  assert.equal(env.runtime.getChannel('telegram-ops'), null);
  assert.equal((await env.deliveryStore.get('channel_state', 'telegram-ops')).paused, true);

  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  const status = await env.runtime.getStatus(record.id);
  assert.equal(status.paused, true);
  assert.equal(record.updatedBy, OPERATOR);
  const [pause] = await operatorActions(env.deliveryStore, record.id);
  assert.equal(pause.operatorId, 'system');
  assert.equal(pause.reasonHash, await opaqueId('operator-reason', record.id, NEW_CHANNEL_PAUSE_REASON));
});

test('creating a channel id that exists is a conflict and leaves its delivery state alone', async t => {
  const env = await startedFixture(t);
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  const before = await env.deliveryStore.get('channel_state', record.id);

  await assert.rejects(env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR), ChannelConflictError);
  assert.deepEqual(await env.deliveryStore.get('channel_state', record.id), before);
  assert.equal(before.paused, false);
});

test('resume is refused until every required credential resolves, naming the missing slots', async t => {
  const env = await startedFixture(t);
  const record = await env.runtime.createChannel(channelInput(env.credentialIds, {
    telegram: { botTokenCredentialId: null, chatIdCredentialId: null },
  }), OPERATOR);
  const { version } = await env.runtime.getStatus(record.id);

  const error = await env.runtime.control(record.id, 'resume', {
    idempotencyKey: 'resume-1', expectedVersion: version, reason: 'Go live',
  }, OPERATOR).then(() => null, value => value);

  assert.ok(error instanceof ChannelCredentialError);
  assert.match(error.message, /telegram\.botTokenCredentialId, telegram\.chatIdCredentialId/);
  for (const secret of Object.values(SECRETS)) assert.equal(error.message.includes(secret), false);
  assert.equal((await env.runtime.getStatus(record.id)).paused, true);

  const updated = await env.runtime.updateChannel(record.id, {
    version: record.version,
    telegram: { botTokenCredentialId: env.credentialIds.botToken, chatIdCredentialId: env.credentialIds.chatId },
  }, OPERATOR);
  const resumed = await env.runtime.control(updated.id, 'resume', {
    idempotencyKey: 'resume-2', expectedVersion: version, reason: 'Go live',
  }, OPERATOR);
  assert.deepEqual([resumed.status, resumed.paused, resumed.replayed], ['resumed', false, false]);
  const actions = await operatorActions(env.deliveryStore, record.id);
  assert.deepEqual(actions.map(action => [action.action, action.operatorId]).sort(), [['pause', 'system'], ['resume', OPERATOR]]);
});

test('pause and resume use the exact state version and replay by idempotency key', async t => {
  const env = await startedFixture(t);
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  const { version } = await env.runtime.getStatus(record.id);
  const params = { idempotencyKey: 'pause-for-maintenance', expectedVersion: version, reason: 'Maintenance window' };
  env.events.length = 0;

  const paused = await env.runtime.control(record.id, 'pause', params, OPERATOR);
  const replay = await env.runtime.control(record.id, 'pause', params, OPERATOR);
  const stale = await env.runtime.control(record.id, 'resume', { ...params, idempotencyKey: 'resume-stale' }, OPERATOR)
    .then(() => null, error => error);

  assert.deepEqual([paused.status, paused.paused, paused.version], ['paused', true, version + 1]);
  assert.equal(replay.replayed, true);
  assert.ok(stale instanceof RuntimeError);
  assert.equal(stale.code, 'version_conflict');
  assert.equal((await env.runtime.getStatus(record.id)).paused, true);
  assert.deepEqual(
    env.events.filter(event => event.type === 'control.applied').map(event => [event.data.action, event.data.status, event.data.replayed]),
    [['pause', 'paused', false], ['pause', 'paused', true]],
  );
});

test('control input is validated before anything runs', () => {
  const valid = { idempotencyKey: 'key-1', expectedVersion: 3, reason: 'Reason' };
  assert.deepEqual(readControlParams('pause', valid), { ...valid, confirmPausedMutation: false, confirmDuplicateRisk: false });
  assert.equal(readControlParams('pause', { ...valid, expectedVersion: '3' }).expectedVersion, 3);
  const cases = [
    ['explode', valid, 'action'],
    ['pause', { ...valid, reason: '' }, 'reason'],
    ['pause', { ...valid, reason: 'x'.repeat(501) }, 'reason'],
    ['pause', { ...valid, idempotencyKey: 'has space' }, 'idempotencyKey'],
    ['pause', { ...valid, expectedVersion: 0 }, 'expectedVersion'],
    ['pause', { reason: 'r', idempotencyKey: 'k' }, 'expectedVersion'],
    ['abandon', valid, 'deliveryId'],
    ['confirm-delivered', { ...valid, deliveryId: 'd' }, 'outputKey'],
    ['retry-maintenance', valid, 'outboxId'],
    ['pause', { ...valid, operatorId: 'spoofed' }, 'operatorId'],
  ];
  for (const [action, params, field] of cases) {
    assert.throws(() => readControlParams(action, params), error => (
      error instanceof ValidationError && error.issues.some(issue => issue.field === field)
    ), `${action} ${field}`);
  }
});

test('controls other than pause need the runtime lease; pause never does', async t => {
  const env = await createRuntimeFixture(t);
  const record = await env.runtime.createChannel(channelInput(env.credentialIds), OPERATOR);
  const { version } = await env.runtime.getStatus(record.id);

  await assert.rejects(
    env.runtime.control(record.id, 'resume', { idempotencyKey: 'r', expectedVersion: version, reason: 'Go' }, OPERATOR),
    error => error instanceof RuntimeError && error.code === 'runtime_not_leased',
  );
  const paused = await env.runtime.control(record.id, 'pause', { idempotencyKey: 'p', expectedVersion: version, reason: 'Hold' }, OPERATOR);
  assert.equal(paused.status, 'paused');
});

test('abandon resolves a failed delivery and the library follows', async t => {
  const env = await startedFixture(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [MANUAL_FAILURE],
  });
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  assert.equal((await env.runtime.runNow(record.id, OPERATOR, { wait: true })).status, 'failed');
  assert.equal(library(env.runtime)['Rust 2.0 compiler ships async closures'].status, 'failed');

  const unresolved = await env.runtime.listUnresolved(record.id);
  const target = unresolved.targets.find(entry => entry.kind === 'delivery');
  assert.deepEqual(target.allowedActions, ['abandon']);
  assert.equal(target.title, 'Rust 2.0 compiler ships async closures');

  const result = await env.runtime.control(record.id, 'abandon', {
    idempotencyKey: 'abandon-rust', expectedVersion: target.expectedVersion, deliveryId: target.deliveryId, reason: 'Outdated',
  }, OPERATOR);

  assert.equal(result.status, 'abandoned');
  assert.equal(library(env.runtime)['Rust 2.0 compiler ships async closures'].status, 'abandoned');
  assert.equal((await env.runtime.listUnresolved(record.id)).page.total, 0);
});

test('retry-output re-sends one failed output and confirm-delivered settles an ambiguous one', async t => {
  const env = await startedFixture(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [MANUAL_FAILURE],
  });
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  await env.runtime.runNow(record.id, OPERATOR, { wait: true });
  const output = (await env.runtime.listUnresolved(record.id)).targets.find(entry => entry.kind === 'output');
  assert.deepEqual(output.allowedActions, ['retry-output']);

  const retried = await env.runtime.control(record.id, 'retry-output', {
    idempotencyKey: 'retry-1', expectedVersion: output.expectedVersion, deliveryId: output.deliveryId, outputKey: output.outputKey,
    reason: 'Telegram is back',
  }, OPERATOR);

  assert.equal(retried.deliveryState, 'succeeded');
  assert.equal(env.plugins.output.calls.length, 2);
  const row = library(env.runtime)['Rust 2.0 compiler ships async closures'];
  assert.equal(row.status, 'delivered');
  assert.equal(row.messageId, 'message-2');

  env.plugins.output.results.push(AMBIGUOUS);
  env.plugins.source.articles.push(techArticle('gpu', 'GPU kernels land in Linux 7.0'));
  env.clock.advance(15 * 60_000);
  assert.equal((await env.runtime.runNow(record.id, OPERATOR, { wait: true })).status, 'ambiguous');
  const ambiguous = (await env.runtime.listUnresolved(record.id)).targets.find(entry => entry.kind === 'output');
  assert.deepEqual(ambiguous.allowedActions, ['confirm-delivered', 'retry-output']);

  const confirmed = await env.runtime.control(record.id, 'confirm-delivered', {
    idempotencyKey: 'confirm-1', expectedVersion: ambiguous.expectedVersion, deliveryId: ambiguous.deliveryId,
    outputKey: ambiguous.outputKey, messageId: '777', reason: 'Seen in the channel',
  }, OPERATOR);

  assert.equal(confirmed.deliveryState, 'succeeded');
  assert.equal(env.plugins.output.calls.length, 3, 'confirming never re-sends');
  const gpu = library(env.runtime)['GPU kernels land in Linux 7.0'];
  assert.deepEqual([gpu.status, gpu.messageId], ['delivered', '777']);
  assert.equal((await env.runtime.getStatus(record.id)).mutationState, 'free');
});

test('retry-generation uses the channel prompt language and custom system prompt', async t => {
  const ai = new FlakyAI(1);
  const env = await startedFixture(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')], ai });
  const record = await createActiveChannel(env.runtime, env.credentialIds, {
    prompt: { language: 'en', style: 'digest', audience: 'SREs', customSystemPrompt: CUSTOM_PROMPT },
  });
  const first = await env.runtime.runNow(record.id, OPERATOR, { wait: true });
  assert.equal(first.status, 'failed');
  assert.equal(library(env.runtime)['Rust 2.0 compiler ships async closures'].status, 'generation_failed');
  const target = (await env.runtime.listUnresolved(record.id)).targets.find(entry => entry.kind === 'delivery');
  assert.deepEqual(target.allowedActions, ['retry-generation', 'abandon']);

  const retried = await env.runtime.control(record.id, 'retry-generation', {
    idempotencyKey: 'regen-1', expectedVersion: target.expectedVersion, deliveryId: target.deliveryId, reason: 'Provider recovered',
  }, OPERATOR);

  assert.equal(retried.deliveryState, 'ready');
  assert.equal(ai.calls.length, 2);
  assert.deepEqual(ai.calls[1].options, {
    language: 'en', style: 'digest', audience: 'SREs', platform: 'telegram', customSystemPrompt: CUSTOM_PROMPT, deliveryMode: 'drip',
  });
  assert.deepEqual(ai.calls[0].options, ai.calls[1].options, 'retry uses the same options as the engine');
  assert.equal(ai.calls[1].hasSignal, true);
  const row = library(env.runtime)['Rust 2.0 compiler ships async closures'];
  assert.equal(row.status, 'queued');
  assert.equal(env.runtime.getContent(row.id).summaryText, 'Generated after retry');
});

test('the CLI recovery path keeps Vietnamese without a custom prompt for channels that set none', async () => {
  for (const [prompt, expected] of [
    [undefined, { language: 'vi' }],
    [{ style: 'digest', audience: 'IT', platform: 'telegram' }, { language: 'vi' }],
    [{ language: 'en', style: 'bullet', audience: 'IT', platform: 'telegram', customSystemPrompt: CUSTOM_PROMPT }, { language: 'en', customSystemPrompt: CUSTOM_PROMPT }],
  ]) {
    const store = new MemoryDeliveryStore({ durable: true });
    const output = new RecordingOutput();
    const machine = new DeliveryStateMachine({ store, channelId: 'digest' });
    const prepared = await machine.prepareDelivery({
      requestId: 'seed', mode: 'digest', publishingDay: '2026-10-03',
      articles: [{ id: 'a', title: 'Rust ships', source: 'Fixture' }], outputs: [output],
    });
    const claim = await machine.claimGeneration(prepared.deliveryId, { requestId: 'seed' });
    const exhausted = await machine.failGeneration(claim.attempt.attemptId, new Error('down'), { retryDisposition: 'never' });
    const ai = new FlakyAI(0);

    await executeRecoveryControl({ id: 'digest', ai, output, prompt }, {
      action: 'retry-generation', idempotencyKey: 'regen', expectedVersion: exhausted.version,
      deliveryId: prepared.deliveryId, operatorId: 'ops', reason: 'retry',
    }, { deliveryStore: store });

    const { language, customSystemPrompt } = ai.calls[0].options;
    assert.deepEqual({ language, ...(customSystemPrompt !== undefined && { customSystemPrompt }) }, expected);
    assert.equal(Object.hasOwn(ai.calls[0].options, 'customSystemPrompt'), expected.customSystemPrompt !== undefined);
  }
});
