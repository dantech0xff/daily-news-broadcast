import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeAI } from '../../src/ai/claude.js';
import { OpenAICompatibleAI } from '../../src/ai/openai-compat.js';
import {
  ChannelCredentialError,
  DEFAULT_CHANNEL_FACTORIES,
  buildChannelFromConfig,
} from '../../src/app/channels/build-channel.js';
import { ChannelRepository } from '../../src/app/channels/channel-repository.js';
import { ChannelValidationError } from '../../src/app/channels/config-schema.js';
import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { CredentialRepository } from '../../src/app/secrets/credential-repository.js';
import { SecretVault, VaultDecryptionError } from '../../src/app/secrets/vault.js';
import { defineChannels } from '../../src/channels/definitions.js';
import { buildEngine, runChannels } from '../../src/channels/runner.js';
import { MemoryCache } from '../../src/core/caches.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { TelegramOutput } from '../../src/outputs/telegram.js';
import { bigTechBlogs } from '../../src/presets/index.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const SECRETS = Object.freeze({
  'bot-token': '123456:FAKE-test-bot-token',
  'chat-id': '-1001234567890',
  'ai-key': 'fake-ai-key-for-tests',
  'gateway-token': 'fake-gateway-token-for-tests',
});
const CUSTOM_PROMPT = 'You edit an internal bulletin for SREs. Lead with operational risk.';
const ARTICLE = {
  id: 'k8s-140',
  title: 'Kubernetes 1.40 ships sidecar containers',
  url: 'https://example.test/k8s-140',
  content: 'The Kubernetes release graduates sidecar containers for cloud native workloads.',
  source: 'Kubernetes Blog',
};

function channelRecord(overrides = {}) {
  return {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'Asia/Singapore',
    notBefore: '2026-10-03T00:00:00.000Z',
    sources: [
      { type: 'preset', preset: 'bigTechBlogs', enabled: true },
      { type: 'hackernews', enabled: false, config: { query: 'rust' } },
    ],
    prompt: { language: 'en', style: 'digest', audience: 'SREs', customSystemPrompt: CUSTOM_PROMPT },
    ai: { provider: 'claude', model: 'claude-sonnet-4-20250514', apiKeyCredentialId: 'ai-key' },
    telegram: { botTokenCredentialId: 'bot-token', chatIdCredentialId: 'chat-id' },
    limits: { batchSize: 2, delayMs: 0, dailyLimit: 7, maxArticles: 9, maxArticlesPerSource: 2, concurrency: 4 },
    version: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    updatedBy: 'ops@example.test',
    ...overrides,
  };
}

function fakeResolver() {
  const calls = [];
  const resolve = (credentialId, slot) => {
    calls.push({ credentialId, ...slot });
    return SECRETS[credentialId];
  };
  return { calls, resolve };
}

function recordingFactories() {
  const calls = { sources: [], ai: [], output: [] };
  return {
    calls,
    factories: {
      createSources: entries => {
        calls.sources.push(structuredClone(entries));
        return [new RecordingSource([ARTICLE])];
      },
      createAI: config => {
        calls.ai.push({ ...config });
        return new RecordingAI('Kubernetes 1.40 ships sidecar containers');
      },
      createOutput: config => {
        calls.output.push({ ...config });
        return new RecordingOutput();
      },
    },
  };
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the build to fail');
}

test('a built channel has the defineChannels() shape plus notBefore', async () => {
  const built = await buildChannelFromConfig(channelRecord(), { resolveCredential: fakeResolver().resolve });
  const [envChannel] = defineChannels({ TELEGRAM_BOT_TOKEN: SECRETS['bot-token'], TELEGRAM_CHAT_ID: SECRETS['chat-id'], ANTHROPIC_API_KEY: SECRETS['ai-key'] });

  assert.deepEqual(Object.keys(built), [...Object.keys(envChannel), 'notBefore']);
  assert.deepEqual(Object.keys(built.prompt), [...Object.keys(envChannel.prompt), 'customSystemPrompt']);
  assert.deepEqual(
    { ...built, sources: undefined, ai: undefined, output: undefined },
    {
      id: 'telegram-ops',
      sources: undefined,
      ai: undefined,
      output: undefined,
      prompt: { language: 'en', style: 'digest', audience: 'SREs', platform: 'telegram', customSystemPrompt: CUSTOM_PROMPT },
      mode: 'drip',
      schedule: '0 * * * *',
      timezone: 'Asia/Singapore',
      batchSize: 2,
      delayMs: 0,
      dailyLimit: 7,
      maxArticles: 9,
      maxArticlesPerSource: 2,
      concurrency: 4,
      notBefore: '2026-10-03T00:00:00.000Z',
    },
  );
});

test('default factories build the real plugins from resolved credentials', async () => {
  const built = await buildChannelFromConfig(channelRecord(), { resolveCredential: fakeResolver().resolve });

  assert.deepEqual(built.sources.map(source => source.sourceKey), bigTechBlogs().map(source => source.sourceKey));
  assert.ok(built.ai instanceof ClaudeAI);
  assert.equal(built.ai._config.apiKey, SECRETS['ai-key']);
  assert.equal(built.ai._config.model, 'claude-sonnet-4-20250514');
  assert.ok(built.output instanceof TelegramOutput);
  assert.equal(built.output.deliveryKey, new TelegramOutput({ botToken: 'other', chatId: SECRETS['chat-id'] }).deliveryKey);
  assert.equal(built.output._config.botToken, SECRETS['bot-token']);
  assert.equal(DEFAULT_CHANNEL_FACTORIES.createOutput({ botToken: 'b', chatId: 'c' }) instanceof TelegramOutput, true);
});

test('the built prompt omits customSystemPrompt when none is configured', async () => {
  const built = await buildChannelFromConfig(
    channelRecord({ prompt: { language: 'vi', style: 'digest', audience: 'IT', customSystemPrompt: null } }),
    { resolveCredential: fakeResolver().resolve },
  );
  assert.deepEqual(built.prompt, { language: 'vi', style: 'digest', audience: 'IT', platform: 'telegram' });
});

test('injected factories receive resolved settings and only enabled sources', async () => {
  const resolver = fakeResolver();
  const { calls, factories } = recordingFactories();
  await buildChannelFromConfig(channelRecord(), { resolveCredential: resolver.resolve, factories });

  assert.deepEqual(resolver.calls, [
    { credentialId: 'bot-token', field: 'telegram.botTokenCredentialId', kind: 'telegram_bot_token' },
    { credentialId: 'chat-id', field: 'telegram.chatIdCredentialId', kind: 'telegram_chat_id' },
    { credentialId: 'ai-key', field: 'ai.apiKeyCredentialId', kind: 'ai_api_key' },
  ]);
  assert.deepEqual(calls.sources, [[{ type: 'preset', preset: 'bigTechBlogs', enabled: true }]]);
  assert.deepEqual(calls.ai, [{
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    apiKey: SECRETS['ai-key'],
    baseUrl: undefined,
    name: undefined,
    gateway: undefined,
  }]);
  assert.deepEqual(calls.output, [{ botToken: SECRETS['bot-token'], chatId: SECRETS['chat-id'] }]);
});

test('Gemini through AI Gateway receives the gateway token instead of an API key', async () => {
  const resolver = fakeResolver();
  const { calls, factories } = recordingFactories();
  await buildChannelFromConfig(channelRecord({
    ai: {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      gateway: { accountId: '0123456789abcdef0123456789abcdef', gatewayId: 'news-engine', byokAlias: 'prod', tokenCredentialId: 'gateway-token' },
    },
  }), { resolveCredential: resolver.resolve, factories });

  assert.deepEqual(calls.ai, [{
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    apiKey: undefined,
    baseUrl: undefined,
    name: undefined,
    gateway: {
      token: SECRETS['gateway-token'],
      accountId: '0123456789abcdef0123456789abcdef',
      gatewayId: 'news-engine',
      byokAlias: 'prod',
    },
  }]);
  const built = await buildChannelFromConfig(channelRecord({
    ai: { provider: 'gemini', gateway: { accountId: 'acct', gatewayId: 'news-engine', tokenCredentialId: 'gateway-token' } },
  }), { resolveCredential: resolver.resolve });
  assert.ok(built.ai instanceof OpenAICompatibleAI);
  assert.equal(built.ai._config.extraHeaders['cf-aig-authorization'], `Bearer ${SECRETS['gateway-token']}`);
});

test('the built channel runs through buildEngine with its prompt settings', async () => {
  const { factories } = recordingFactories();
  const built = await buildChannelFromConfig(channelRecord(), { resolveCredential: fakeResolver().resolve, factories });
  const deliveryStore = new MemoryDeliveryStore({ durable: true });
  const engine = buildEngine(built, { cache: new MemoryCache(), deliveryStore });

  assert.equal(engine.ai, built.ai);
  assert.equal(engine.outputs[0], built.output);
  assert.deepEqual(engine.sources, built.sources);
  assert.equal(engine.options.channelId, 'telegram-ops');
  assert.equal(engine.options.timezone, 'Asia/Singapore');
  assert.equal(engine.options.maxArticlesPerSource, 2);
  assert.equal(engine.options.concurrency, 4);

  const preview = await engine.runDrip({ dryRun: true, batchSize: 1 });
  assert.equal(preview.status, 'dry_run');
  const { signal, ...options } = built.ai.calls[0].options;
  assert.ok(signal !== undefined);
  assert.deepEqual(options, {
    language: 'en',
    style: 'digest',
    audience: 'SREs',
    platform: 'telegram',
    customSystemPrompt: CUSTOM_PROMPT,
    deliveryMode: 'drip',
  });
});

test('runChannels delivers a built channel end to end with injected fakes', async () => {
  const { factories } = recordingFactories();
  const built = await buildChannelFromConfig(channelRecord(), { resolveCredential: fakeResolver().resolve, factories });
  const results = await runChannels([built], {
    cache: new MemoryCache(),
    deliveryStore: new MemoryDeliveryStore({ durable: true }),
    triggerType: 'manual',
    logger: { log() {}, warn() {} },
  });

  assert.equal(results[0].channelId, 'telegram-ops');
  assert.equal(results[0].status, 'success');
  assert.equal(built.output.calls.length, 1);
  assert.equal(built.output.calls[0].content, 'Kubernetes 1.40 ships sidecar containers');
});

test('missing credentials are named by slot and nothing is resolved', async () => {
  const resolver = fakeResolver();
  const error = await captureError(buildChannelFromConfig(channelRecord({
    ai: { provider: 'gemini', gateway: { accountId: 'acct', gatewayId: 'news-engine' } },
    telegram: { botTokenCredentialId: null, chatIdCredentialId: 'chat-id' },
  }), { resolveCredential: resolver.resolve }));

  assert.ok(error instanceof ChannelCredentialError);
  assert.equal(error.code, 'missing_credential');
  assert.equal(error.channelId, 'telegram-ops');
  assert.deepEqual(error.fields, ['telegram.botTokenCredentialId', 'ai.gateway.tokenCredentialId']);
  assert.equal(
    error.message,
    'Channel "telegram-ops" is missing required credentials: telegram.botTokenCredentialId, ai.gateway.tokenCredentialId',
  );
  assert.deepEqual(resolver.calls, []);
});

test('each provider requires exactly the credentials it uses', async () => {
  const cases = [
    [{ provider: 'claude' }, ['ai.apiKeyCredentialId']],
    [{ provider: 'gemini' }, ['ai.apiKeyCredentialId']],
    [{ provider: 'ollama', model: 'llama3.2' }, []],
    [{ provider: 'custom', baseUrl: 'https://llm.example.test/v1' }, []],
  ];
  for (const [ai, missing] of cases) {
    const build = buildChannelFromConfig(channelRecord({ ai }), {
      resolveCredential: fakeResolver().resolve,
      factories: recordingFactories().factories,
    });
    if (missing.length === 0) {
      await build;
    } else {
      const error = await captureError(build);
      assert.deepEqual(error.fields, missing, ai.provider);
    }
  }
});

test('credential resolution failures name the slot without leaking values', async () => {
  const failing = await captureError(buildChannelFromConfig(channelRecord(), {
    resolveCredential: credentialId => {
      if (credentialId === 'ai-key') throw new VaultDecryptionError();
      return SECRETS[credentialId];
    },
  }));
  assert.ok(failing instanceof ChannelCredentialError);
  assert.equal(failing.code, 'credential_unavailable');
  assert.deepEqual(failing.fields, ['ai.apiKeyCredentialId']);
  assert.equal(failing.message, 'Channel "telegram-ops" could not load the credential for ai.apiKeyCredentialId (vault_decrypt_failed)');
  assert.ok(failing.cause instanceof VaultDecryptionError);

  for (const value of ['', '   ', undefined, 42]) {
    const error = await captureError(buildChannelFromConfig(channelRecord(), {
      resolveCredential: credentialId => (credentialId === 'chat-id' ? value : SECRETS[credentialId]),
    }));
    assert.equal(error.code, 'credential_unavailable');
    assert.deepEqual(error.fields, ['telegram.chatIdCredentialId']);
    for (const secret of Object.values(SECRETS)) assert.ok(!error.message.includes(secret));
  }
});

test('a channel without enabled sources or with invalid config is not built', async () => {
  const resolveCredential = fakeResolver().resolve;
  const noSources = await captureError(buildChannelFromConfig(channelRecord({
    enabled: false,
    sources: [{ type: 'preset', preset: 'bigTechBlogs', enabled: false }],
  }), { resolveCredential }));
  assert.ok(noSources instanceof ChannelValidationError);
  assert.deepEqual(noSources.issues.map(issue => `${issue.field}:${issue.code}`), ['sources:no_enabled_sources']);

  const invalid = await captureError(buildChannelFromConfig(channelRecord({
    sources: [{ type: 'preset', preset: 'retiredPreset', enabled: true }],
  }), { resolveCredential }));
  assert.ok(invalid instanceof ChannelValidationError);
  assert.deepEqual(invalid.issues.map(issue => `${issue.field}:${issue.code}`), ['sources.0.preset:invalid_value']);

  await assert.rejects(buildChannelFromConfig(channelRecord(), {}), TypeError);
});

test('channels stored in SQLite build with credentials resolved from the vault', async t => {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir });
  const storage = createNodeSqlStorage(db);
  const vault = new SecretVault({ storage, masterKey: Buffer.from('fake-master-key-for-tests-only!!').toString('base64') });
  const credentials = new CredentialRepository({ storage, vault });
  const channels = new ChannelRepository({ storage });
  const actor = 'ops@example.test';
  const bot = credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: SECRETS['bot-token'], actor });
  const chat = credentials.create({ label: 'Chat', kind: 'telegram_chat_id', value: SECRETS['chat-id'], actor });
  const key = credentials.create({ label: 'Claude', kind: 'ai_api_key', value: SECRETS['ai-key'], actor });
  const record = channels.create(channelRecord({
    ai: { provider: 'claude', apiKeyCredentialId: key.id },
    telegram: { botTokenCredentialId: bot.id, chatIdCredentialId: chat.id },
  }), { actor });

  const built = await buildChannelFromConfig(record, {
    resolveCredential: (credentialId, { kind }) => credentials.resolvePlaintext(credentialId, { kind }),
  });

  assert.equal(built.ai._config.apiKey, SECRETS['ai-key']);
  assert.equal(built.output._config.chatId, SECRETS['chat-id']);
  assert.equal(built.output._config.botToken, SECRETS['bot-token']);
});
