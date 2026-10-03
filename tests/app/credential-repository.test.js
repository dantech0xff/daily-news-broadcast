import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelRepository } from '../../src/app/channels/channel-repository.js';
import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import {
  CredentialInUseError,
  CredentialNotFoundError,
  CredentialRepository,
  CredentialValidationError,
  MAX_CREDENTIAL_VALUE_LENGTH,
} from '../../src/app/secrets/credential-repository.js';
import { SecretVault, VaultDecryptionError } from '../../src/app/secrets/vault.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const MASTER_KEY = Buffer.from('fake-master-key-for-tests-only!!').toString('base64');
const START = Date.parse('2026-10-03T00:00:00.000Z');
const ACTOR = 'ops@example.test';
const FAKE_VALUES = Object.freeze({
  telegram_bot_token: '123456:FAKE-test-bot-token',
  telegram_chat_id: '-1001234567890',
  ai_api_key: 'fake-ai-key-for-tests',
  ai_gateway_token: 'fake-gateway-token-for-tests',
});

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
    credentials: new CredentialRepository({ storage, vault, clock }),
    channels: new ChannelRepository({ storage, clock }),
  };
}

function channelUsing(id, { botTokenCredentialId = null, chatIdCredentialId = null, apiKeyCredentialId = null } = {}) {
  return {
    id,
    name: id,
    mode: 'drip',
    cron: '0 * * * *',
    sources: [{ type: 'preset', preset: 'bigTechBlogs' }],
    prompt: { audience: 'IT' },
    ai: { provider: 'claude', apiKeyCredentialId },
    telegram: { botTokenCredentialId, chatIdCredentialId },
  };
}

function validationIssues(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CredentialValidationError, `expected CredentialValidationError, got ${error?.name}`);
    return error.issues.map(({ field, code }) => `${field}:${code}`);
  }
  assert.fail('expected validation to fail');
}

test('creating a credential returns metadata only', async t => {
  const { credentials } = await setup(t);
  const created = credentials.create({ label: '  Main bot  ', kind: 'telegram_bot_token', value: ` ${FAKE_VALUES.telegram_bot_token} `, actor: ACTOR });

  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(created, {
    id: created.id,
    label: 'Main bot',
    kind: 'telegram_bot_token',
    isSet: true,
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    updatedBy: ACTOR,
    usedBy: [],
  });
  assert.equal(Number.isFinite(Date.parse(created.createdAt)), true);
  assert.deepEqual(credentials.get(created.id), created);
  assert.deepEqual(credentials.list(), [created]);
  assert.equal(credentials.resolvePlaintext(created.id), FAKE_VALUES.telegram_bot_token);
  assert.equal(credentials.get('missing'), null);
});

test('every credential kind stores and resolves its value', async t => {
  const { credentials } = await setup(t);
  for (const [kind, value] of Object.entries(FAKE_VALUES)) {
    const created = credentials.create({ label: kind, kind, value, actor: ACTOR });
    assert.equal(credentials.resolvePlaintext(created.id, { kind }), value);
  }
  assert.deepEqual(credentials.list().map(item => item.kind), Object.keys(FAKE_VALUES));
});

test('credential input is validated without echoing the value', async t => {
  const { credentials } = await setup(t);
  assert.deepEqual(validationIssues(() => credentials.create({ actor: ACTOR })), [
    'label:required',
    'kind:required',
    'value:required',
  ]);
  assert.deepEqual(validationIssues(() => credentials.create({ label: 'x'.repeat(101), kind: 'password', value: 'fake', actor: ACTOR, extra: 1 })), [
    'extra:unknown_field',
    'label:too_long',
    'kind:invalid_value',
  ]);
  assert.deepEqual(validationIssues(() => credentials.create(null)), [':required']);

  const cases = [
    ['ai_api_key', 'fake key with spaces', 'value:invalid_characters'],
    ['ai_api_key', 'fake-key-é', 'value:invalid_characters'],
    ['ai_api_key', 'x'.repeat(MAX_CREDENTIAL_VALUE_LENGTH + 1), 'value:too_long'],
    ['ai_api_key', 42, 'value:invalid_type'],
    ['telegram_bot_token', 'bot123456:FAKE', 'value:invalid_format'],
    ['telegram_bot_token', '123456:FAKE/../../x', 'value:invalid_format'],
    ['telegram_chat_id', '-100-fake', 'value:invalid_format'],
  ];
  for (const [kind, value, expected] of cases) {
    let error;
    try {
      credentials.create({ label: 'Invalid', kind, value, actor: ACTOR });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CredentialValidationError, String(value));
    assert.deepEqual(error.issues.map(({ field, code }) => `${field}:${code}`), [expected]);
    if (typeof value === 'string') assert.ok(!JSON.stringify([error.message, error.issues]).includes(value));
  }
  assert.equal(credentials.create({ label: 'Channel', kind: 'telegram_chat_id', value: '@fake_channel', actor: ACTOR }).kind, 'telegram_chat_id');
  assert.equal(credentials.list().length, 1);
  assert.throws(() => credentials.create({ label: 'No actor', kind: 'ai_api_key', value: 'fake-ai-key' }), TypeError);
});

test('replacing a value re-encrypts it and keeps label and kind', async t => {
  const { storage, credentials } = await setup(t);
  const created = credentials.create({ label: 'AI key', kind: 'ai_api_key', value: 'fake-ai-key-old', actor: ACTOR });
  const before = storage.sql.exec('SELECT ciphertext, iv FROM app_credentials').one();

  const replaced = credentials.replace(created.id, { value: 'fake-ai-key-new', actor: 'second@example.test' });

  const after = storage.sql.exec('SELECT ciphertext, iv FROM app_credentials').one();
  assert.notEqual(after.iv, before.iv);
  assert.notEqual(after.ciphertext, before.ciphertext);
  assert.deepEqual(replaced, {
    ...created,
    updatedAt: replaced.updatedAt,
    updatedBy: 'second@example.test',
  });
  assert.ok(replaced.updatedAt > created.updatedAt);
  assert.equal(credentials.resolvePlaintext(created.id), 'fake-ai-key-new');
});

test('replace rejects unknown ids and invalid values and keeps the old value', async t => {
  const { credentials } = await setup(t);
  const bot = credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: FAKE_VALUES.telegram_bot_token, actor: ACTOR });

  assert.throws(() => credentials.replace('missing', { value: 'fake-value', actor: ACTOR }), CredentialNotFoundError);
  assert.deepEqual(validationIssues(() => credentials.replace(bot.id, { value: 'not-a-bot-token', actor: ACTOR })), ['value:invalid_format']);
  assert.deepEqual(validationIssues(() => credentials.replace(bot.id, { value: 'x', label: 'Renamed', actor: ACTOR })), ['label:unknown_field']);
  assert.equal(credentials.resolvePlaintext(bot.id), FAKE_VALUES.telegram_bot_token);
  assert.deepEqual(credentials.get(bot.id), bot);
});

test('usedBy lists every channel that references a credential', async t => {
  const { credentials, channels } = await setup(t);
  const bot = credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: FAKE_VALUES.telegram_bot_token, actor: ACTOR });
  const chat = credentials.create({ label: 'Chat', kind: 'telegram_chat_id', value: FAKE_VALUES.telegram_chat_id, actor: ACTOR });
  const unused = credentials.create({ label: 'Unused', kind: 'ai_api_key', value: FAKE_VALUES.ai_api_key, actor: ACTOR });
  channels.create(channelUsing('beta-channel', { botTokenCredentialId: bot.id, chatIdCredentialId: chat.id }), { actor: ACTOR });
  channels.create(channelUsing('alpha-channel', { botTokenCredentialId: bot.id }), { actor: ACTOR });

  assert.deepEqual(credentials.get(bot.id).usedBy, ['alpha-channel', 'beta-channel']);
  assert.deepEqual(credentials.get(chat.id).usedBy, ['beta-channel']);
  assert.deepEqual(credentials.get(unused.id).usedBy, []);
  assert.deepEqual(credentials.list().map(item => [item.label, item.usedBy]), [
    ['Bot', ['alpha-channel', 'beta-channel']],
    ['Chat', ['beta-channel']],
    ['Unused', []],
  ]);
});

test('a referenced credential cannot be deleted until no channel uses it', async t => {
  const { credentials, channels } = await setup(t);
  const key = credentials.create({ label: 'AI key', kind: 'ai_api_key', value: FAKE_VALUES.ai_api_key, actor: ACTOR });
  const channel = channels.create(channelUsing('claude-channel', { apiKeyCredentialId: key.id }), { actor: ACTOR });

  assert.throws(() => credentials.delete(key.id), error => {
    assert.ok(error instanceof CredentialInUseError);
    assert.equal(error.code, 'credential_in_use');
    assert.deepEqual(error.usedBy, ['claude-channel']);
    return true;
  });
  assert.ok(credentials.get(key.id));

  channels.update(channel.id, { ai: { provider: 'claude', apiKeyCredentialId: null } }, { expectedVersion: 1, actor: ACTOR });
  credentials.delete(key.id);
  assert.equal(credentials.get(key.id), null);
  assert.throws(() => credentials.delete(key.id), CredentialNotFoundError);
  assert.throws(() => credentials.resolvePlaintext(key.id), CredentialNotFoundError);
});

test('resolving plaintext checks the expected kind', async t => {
  const { credentials } = await setup(t);
  const chat = credentials.create({ label: 'Chat', kind: 'telegram_chat_id', value: FAKE_VALUES.telegram_chat_id, actor: ACTOR });
  assert.throws(
    () => credentials.resolvePlaintext(chat.id, { kind: 'telegram_bot_token' }),
    error => /has kind telegram_chat_id, but telegram_bot_token is required/.test(error.message)
      && !error.message.includes(FAKE_VALUES.telegram_chat_id),
  );
  assert.equal(credentials.resolvePlaintext(chat.id, { kind: 'telegram_chat_id' }), FAKE_VALUES.telegram_chat_id);
});

test('sealed values are bound to their own credential row', async t => {
  const { storage, credentials } = await setup(t);
  const bot = credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: FAKE_VALUES.telegram_bot_token, actor: ACTOR });
  const other = credentials.create({ label: 'Other bot', kind: 'telegram_bot_token', value: '654321:FAKE-other-token', actor: ACTOR });
  const sealed = storage.sql.exec('SELECT ciphertext, iv, auth_tag FROM app_credentials WHERE id = ?', bot.id).one();
  storage.sql.exec(
    'UPDATE app_credentials SET ciphertext = ?, iv = ?, auth_tag = ? WHERE id = ?',
    sealed.ciphertext, sealed.iv, sealed.auth_tag, other.id,
  );

  assert.throws(() => credentials.resolvePlaintext(other.id), VaultDecryptionError);
  assert.equal(credentials.resolvePlaintext(bot.id), FAKE_VALUES.telegram_bot_token);
});
