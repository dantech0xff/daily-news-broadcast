import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChannelConflictError,
  ChannelNotFoundError,
  ChannelRepository,
} from '../../src/app/channels/channel-repository.js';
import { ChannelValidationError, DEFAULT_LIMITS } from '../../src/app/channels/config-schema.js';
import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { CredentialRepository } from '../../src/app/secrets/credential-repository.js';
import { SecretVault } from '../../src/app/secrets/vault.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const MASTER_KEY = Buffer.from('fake-master-key-for-tests-only!!').toString('base64');
const START = Date.parse('2026-10-03T00:00:00.000Z');
const ACTOR = 'ops@example.test';

async function setup(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: new Date(START) });
  const storage = createNodeSqlStorage(db);
  let tick = 0;
  const clock = () => new Date(START + tick++ * 1_000);
  const vault = new SecretVault({ storage, masterKey: MASTER_KEY, clock });
  return {
    storage,
    channels: new ChannelRepository({ storage, clock }),
    credentials: new CredentialRepository({ storage, vault, clock }),
  };
}

function channelInput(overrides = {}) {
  return {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    mode: 'drip',
    cron: '0 * * * *',
    sources: [{ type: 'preset', preset: 'bigTechBlogs' }],
    prompt: { audience: 'platform engineers' },
    ai: { provider: 'claude' },
    ...overrides,
  };
}

function issuesOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ChannelValidationError, `expected ChannelValidationError, got ${error?.name}: ${error?.message}`);
    return error.issues.map(({ field, code }) => `${field}:${code}`);
  }
  assert.fail('expected validation to fail');
}

test('create stores a validated channel as version 1', async t => {
  const { storage, channels } = await setup(t);
  const created = channels.create(channelInput({ notBefore: '2026-10-03T07:00:00+07:00' }), { actor: ACTOR });

  assert.deepEqual(created, {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    platform: 'telegram',
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'UTC',
    notBefore: '2026-10-03T00:00:00.000Z',
    sources: [{ type: 'preset', preset: 'bigTechBlogs', enabled: true }],
    prompt: { language: 'vi', style: 'digest', audience: 'platform engineers', customSystemPrompt: null },
    ai: { provider: 'claude', model: null, name: null, baseUrl: null, apiKeyCredentialId: null, gateway: null },
    telegram: { botTokenCredentialId: null, chatIdCredentialId: null },
    limits: { ...DEFAULT_LIMITS },
    cutoverRequired: false,
    version: 1,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    updatedBy: ACTOR,
  });
  const row = storage.sql.exec('SELECT * FROM app_channels').one();
  assert.equal(row.enabled, 1);
  assert.equal(row.not_before, '2026-10-03T00:00:00.000Z');
  assert.equal(row.cutover_required, 0);
  assert.deepEqual(Object.keys(JSON.parse(row.config_json)), ['sources', 'prompt', 'ai', 'telegram', 'limits']);
  assert.deepEqual(channels.get('telegram-ops'), created);
  assert.equal(channels.get('missing'), null);
});

test('create honors an explicit creation time', async t => {
  const { channels } = await setup(t);
  const created = channels.create(channelInput(), { actor: 'system-seed', now: new Date('2026-09-01T00:00:00.000Z') });
  assert.equal(created.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(created.updatedBy, 'system-seed');
  assert.throws(() => channels.create(channelInput({ id: 'other' }), { actor: ACTOR, now: new Date('invalid') }), TypeError);
  assert.throws(() => channels.create(channelInput({ id: 'other' }), {}), TypeError);
});

test('create rejects duplicate ids and invalid input without writing', async t => {
  const { channels } = await setup(t);
  channels.create(channelInput(), { actor: ACTOR });

  assert.throws(() => channels.create(channelInput({ name: 'Again' }), { actor: ACTOR }), error => {
    assert.ok(error instanceof ChannelConflictError);
    assert.equal(error.code, 'channel_exists');
    return true;
  });
  assert.deepEqual(issuesOf(() => channels.create(channelInput({ id: 'broken', mode: 'stream' }), { actor: ACTOR })), ['mode:invalid_value']);
  assert.deepEqual(channels.list().map(channel => [channel.id, channel.name]), [['telegram-ops', 'Telegram Ops']]);
});

test('list returns channels oldest first', async t => {
  const { channels } = await setup(t);
  for (const id of ['zeta-channel', 'alpha-channel', 'mid-channel']) channels.create(channelInput({ id }), { actor: ACTOR });
  assert.deepEqual(channels.list().map(channel => channel.id), ['zeta-channel', 'alpha-channel', 'mid-channel']);
});

test('update merges top-level changes and bumps the version', async t => {
  const { channels } = await setup(t);
  const created = channels.create(channelInput({ notBefore: '2026-10-01T00:00:00Z', limits: { dailyLimit: 9 } }), { actor: ACTOR });

  const updated = channels.update('telegram-ops', {
    name: 'Renamed',
    prompt: { language: 'en', audience: 'SREs', customSystemPrompt: 'Custom editorial voice.' },
  }, { expectedVersion: 1, actor: 'second@example.test' });

  assert.deepEqual(updated, {
    ...created,
    name: 'Renamed',
    prompt: { language: 'en', style: 'digest', audience: 'SREs', customSystemPrompt: 'Custom editorial voice.' },
    version: 2,
    updatedAt: updated.updatedAt,
    updatedBy: 'second@example.test',
  });
  assert.ok(updated.updatedAt > created.updatedAt);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.notBefore, '2026-10-01T00:00:00.000Z');
  assert.equal(updated.limits.dailyLimit, 9);
});

test('notBefore survives omitted or undefined changes and clears only with null', async t => {
  const { channels } = await setup(t);
  channels.create(channelInput({ notBefore: '2026-10-01T00:00:00Z' }), { actor: ACTOR });

  assert.equal(channels.update('telegram-ops', { enabled: false, notBefore: undefined }, { expectedVersion: 1, actor: ACTOR }).notBefore, '2026-10-01T00:00:00.000Z');
  assert.equal(channels.update('telegram-ops', { notBefore: '2026-10-05T12:00:00Z' }, { expectedVersion: 2, actor: ACTOR }).notBefore, '2026-10-05T12:00:00.000Z');
  assert.equal(channels.update('telegram-ops', { notBefore: null }, { expectedVersion: 3, actor: ACTOR }).notBefore, null);
});

test('a full record echoed back by a client updates cleanly', async t => {
  const { channels } = await setup(t);
  const created = channels.create(channelInput(), { actor: ACTOR });
  const updated = channels.update(created.id, { ...created, cron: '15 9 * * *' }, { expectedVersion: created.version, actor: ACTOR });
  assert.equal(updated.cron, '15 9 * * *');
  assert.equal(updated.version, 2);
});

test('a stale version is a conflict and leaves the channel unchanged', async t => {
  const { channels } = await setup(t);
  channels.create(channelInput(), { actor: ACTOR });
  const first = channels.update('telegram-ops', { name: 'First writer' }, { expectedVersion: 1, actor: ACTOR });

  assert.throws(() => channels.update('telegram-ops', { name: 'Second writer' }, { expectedVersion: 1, actor: ACTOR }), error => {
    assert.ok(error instanceof ChannelConflictError);
    assert.equal(error.code, 'version_conflict');
    assert.equal(error.currentVersion, 2);
    return true;
  });
  assert.deepEqual(channels.get('telegram-ops'), first);
});

test('update requires a valid expected version, an existing channel, and a stable id', async t => {
  const { channels } = await setup(t);
  channels.create(channelInput(), { actor: ACTOR });

  for (const expectedVersion of [undefined, 0, 1.5, '1']) {
    assert.deepEqual(issuesOf(() => channels.update('telegram-ops', { name: 'x' }, { expectedVersion, actor: ACTOR })), ['version:required']);
  }
  assert.deepEqual(issuesOf(() => channels.update('telegram-ops', [], { expectedVersion: 1, actor: ACTOR })), [':invalid_type']);
  assert.deepEqual(issuesOf(() => channels.update('telegram-ops', { id: 'renamed' }, { expectedVersion: 1, actor: ACTOR })), ['id:immutable']);
  assert.deepEqual(issuesOf(() => channels.update('telegram-ops', { limits: { dailyLimit: 0 } }, { expectedVersion: 1, actor: ACTOR })), ['limits.dailyLimit:out_of_range']);
  assert.throws(() => channels.update('missing', { name: 'x' }, { expectedVersion: 1, actor: ACTOR }), ChannelNotFoundError);
  assert.equal(channels.get('telegram-ops').version, 1);
});

test('credential references must exist and match the slot kind', async t => {
  const { channels, credentials } = await setup(t);
  const bot = credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: '123456:FAKE-test-bot-token', actor: ACTOR });
  const chat = credentials.create({ label: 'Chat', kind: 'telegram_chat_id', value: '-1001234567890', actor: ACTOR });

  assert.deepEqual(issuesOf(() => channels.create(channelInput({
    telegram: { botTokenCredentialId: chat.id, chatIdCredentialId: 'missing-credential' },
    ai: { provider: 'claude', apiKeyCredentialId: bot.id },
  }), { actor: ACTOR })), [
    'telegram.botTokenCredentialId:credential_kind_mismatch',
    'telegram.chatIdCredentialId:credential_not_found',
    'ai.apiKeyCredentialId:credential_kind_mismatch',
  ]);
  assert.deepEqual(channels.list(), []);

  const created = channels.create(channelInput({ telegram: { botTokenCredentialId: bot.id, chatIdCredentialId: chat.id } }), { actor: ACTOR });
  assert.deepEqual(created.telegram, { botTokenCredentialId: bot.id, chatIdCredentialId: chat.id });
  assert.deepEqual(issuesOf(() => channels.update(created.id, {
    telegram: { botTokenCredentialId: bot.id, chatIdCredentialId: bot.id },
  }, { expectedVersion: 1, actor: ACTOR })), ['telegram.chatIdCredentialId:credential_kind_mismatch']);
  assert.equal(channels.get(created.id).version, 1);
});

test('delete removes a channel and honors an optional expected version', async t => {
  const { channels } = await setup(t);
  channels.create(channelInput(), { actor: ACTOR });

  assert.throws(() => channels.delete('telegram-ops', { expectedVersion: 2 }), error => (
    error instanceof ChannelConflictError && error.code === 'version_conflict' && error.currentVersion === 1
  ));
  assert.deepEqual(issuesOf(() => channels.delete('telegram-ops', { expectedVersion: 0 })), ['version:required']);
  channels.delete('telegram-ops', { expectedVersion: 1 });
  assert.equal(channels.get('telegram-ops'), null);
  assert.throws(() => channels.delete('telegram-ops'), ChannelNotFoundError);

  channels.create(channelInput({ id: 'second-channel' }), { actor: ACTOR });
  channels.delete('second-channel');
  assert.deepEqual(channels.list(), []);
});

test('an unreadable stored config fails loudly instead of returning partial data', async t => {
  const { storage, channels } = await setup(t);
  channels.create(channelInput(), { actor: ACTOR });
  storage.sql.exec("UPDATE app_channels SET config_json = '{broken' WHERE id = 'telegram-ops'");

  assert.throws(() => channels.get('telegram-ops'), /Stored config for channel "telegram-ops" is unreadable/);
  assert.throws(() => channels.list(), /unreadable/);
});
