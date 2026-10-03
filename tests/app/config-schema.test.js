import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_PROVIDERS,
  ChannelValidationError,
  DEFAULT_LIMITS,
  MAX_BATCH_DELAY_MS,
  aiCredentialRequirements,
  listCredentialReferences,
  validateChannelConfig,
} from '../../src/app/channels/config-schema.js';

function minimalInput(overrides = {}) {
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

function issuesOf(input, options) {
  try {
    validateChannelConfig(input, options);
  } catch (error) {
    assert.ok(error instanceof ChannelValidationError, `expected ChannelValidationError, got ${error?.name}`);
    return error.issues.map(({ field, code }) => `${field}:${code}`);
  }
  assert.fail('expected validation to fail');
}

test('minimal input is normalized with every default filled in', () => {
  assert.deepEqual(validateChannelConfig(minimalInput()), {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    platform: 'telegram',
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'UTC',
    notBefore: null,
    sources: [{ type: 'preset', preset: 'bigTechBlogs', enabled: true }],
    prompt: { language: 'vi', style: 'digest', audience: 'platform engineers', customSystemPrompt: null },
    ai: { provider: 'claude', model: null, name: null, baseUrl: null, apiKeyCredentialId: null, gateway: null },
    telegram: { botTokenCredentialId: null, chatIdCredentialId: null },
    limits: { ...DEFAULT_LIMITS },
  });
});

test('a fully specified channel round-trips unchanged and validation is idempotent', () => {
  const input = {
    id: 'ai-weekly-en',
    name: 'AI Weekly (EN)',
    enabled: false,
    platform: 'telegram',
    mode: 'digest',
    cron: '30 8 * * 1',
    timezone: 'Asia/Ho_Chi_Minh',
    notBefore: '2026-10-03T00:00:00.000Z',
    sources: [
      { type: 'preset', preset: 'aiNewsSources', enabled: true },
      { type: 'rss', enabled: false, config: { id: 'example-feed', name: 'Example Feed', feedUrl: 'https://example.test/feed.xml', icon: '🧪', category: 'Testing', baseUrl: 'https://example.test' } },
      { type: 'hackernews', enabled: true, config: { query: 'kubernetes', minPoints: 120 } },
    ],
    prompt: { language: 'en', style: 'weekly', audience: 'platform engineers', customSystemPrompt: 'Line one.\n\tLine two.' },
    ai: {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      name: null,
      baseUrl: null,
      apiKeyCredentialId: null,
      gateway: { accountId: '0123456789abcdef0123456789abcdef', gatewayId: 'news-engine', byokAlias: 'prod-key', tokenCredentialId: 'gateway-token' },
    },
    telegram: { botTokenCredentialId: 'bot-token', chatIdCredentialId: 'chat-id' },
    limits: { batchSize: 2, delayMs: 1_000, dailyLimit: 20, maxArticles: 30, maxArticlesPerSource: 4, concurrency: 3 },
  };

  const normalized = validateChannelConfig(input);
  assert.deepEqual(normalized, input);
  assert.deepEqual(validateChannelConfig(normalized), normalized);
});

test('text fields are trimmed and the cron expression is normalized', () => {
  const config = validateChannelConfig(minimalInput({
    name: '  Telegram Ops  ',
    cron: '  0   0-17 * *  * ',
    timezone: ' Asia/Singapore ',
    prompt: { audience: '  IT  ', customSystemPrompt: '   ' },
  }));
  assert.equal(config.name, 'Telegram Ops');
  assert.equal(config.cron, '0 0-17 * * *');
  assert.equal(config.timezone, 'Asia/Singapore');
  assert.equal(config.prompt.audience, 'IT');
  assert.equal(config.prompt.customSystemPrompt, null);
});

test('required fields are reported together', () => {
  assert.deepEqual(issuesOf({}), [
    'id:required',
    'name:required',
    'mode:required',
    'cron:required',
    'sources:required',
    'prompt:required',
    'ai:required',
  ]);
  assert.deepEqual(issuesOf(null), [':required']);
  assert.deepEqual(issuesOf([]), [':invalid_type']);
});

test('channel ids must be kebab-case and cannot change on update', () => {
  for (const id of ['Telegram', 'telegram_main', '-telegram', 'telegram--main', 'a'.repeat(65), 7]) {
    assert.ok(issuesOf(minimalInput({ id })).some(issue => issue.startsWith('id:')), String(id));
  }
  assert.equal(validateChannelConfig(minimalInput({ id: undefined }), { existingId: 'telegram-ops' }).id, 'telegram-ops');
  assert.equal(validateChannelConfig(minimalInput(), { existingId: 'telegram-ops' }).id, 'telegram-ops');
  assert.deepEqual(issuesOf(minimalInput({ id: 'renamed' }), { existingId: 'telegram-ops' }), ['id:immutable']);
});

test('platform, mode, cron, and timezone are validated', () => {
  assert.deepEqual(issuesOf(minimalInput({ platform: 'x' })), ['platform:invalid_value']);
  assert.deepEqual(issuesOf(minimalInput({ mode: 'stream' })), ['mode:invalid_value']);
  for (const cron of ['* * * *', '61 * * * *', '0 24 * * *', '*/0 * * * *', '0 0 * * * *']) {
    assert.deepEqual(issuesOf(minimalInput({ cron })), ['cron:invalid_cron'], cron);
  }
  for (const timezone of ['Not/A-Timezone', '+07:00', 'UTC+7', '../etc']) {
    assert.deepEqual(issuesOf(minimalInput({ timezone })), ['timezone:invalid_timezone'], timezone);
  }
  for (const timezone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires', 'Etc/GMT+7']) {
    assert.equal(validateChannelConfig(minimalInput({ timezone })).timezone, timezone);
  }
});

test('notBefore accepts zoned ISO instants and stores them in UTC', () => {
  assert.equal(validateChannelConfig(minimalInput({ notBefore: '2026-10-03T07:30:00+07:00' })).notBefore, '2026-10-03T00:30:00.000Z');
  assert.equal(validateChannelConfig(minimalInput({ notBefore: '2026-10-03T00:00Z' })).notBefore, '2026-10-03T00:00:00.000Z');
  assert.equal(validateChannelConfig(minimalInput({ notBefore: null })).notBefore, null);
  for (const notBefore of ['2026-10-03', '2026-10-03T00:00:00', '2026-02-30T00:00:00Z', '2026-10-03T24:00:00Z', 'yesterday', 1_791_028_800_000]) {
    assert.ok(issuesOf(minimalInput({ notBefore })).some(issue => issue.startsWith('notBefore:')), String(notBefore));
  }
});

test('limits use defaults and enforce integer ranges', () => {
  assert.deepEqual(validateChannelConfig(minimalInput({ limits: { dailyLimit: 500 } })).limits, { ...DEFAULT_LIMITS, dailyLimit: 500 });
  assert.deepEqual(issuesOf(minimalInput({
    limits: { batchSize: 0, delayMs: 3_600_001, dailyLimit: 501, maxArticles: 1.5, maxArticlesPerSource: '3', concurrency: 51 },
  })), [
    'limits.batchSize:out_of_range',
    'limits.delayMs:out_of_range',
    'limits.dailyLimit:out_of_range',
    'limits.maxArticles:invalid_type',
    'limits.maxArticlesPerSource:invalid_type',
    'limits.concurrency:out_of_range',
  ]);
});

test('batchSize × delayMs is capped at 10 minutes so one run cannot hold the shared queue', () => {
  assert.equal(MAX_BATCH_DELAY_MS, 600_000);
  const limits = (batchSize, delayMs) => minimalInput({ limits: { batchSize, delayMs } });
  for (const [batchSize, delayMs] of [[1, 600_000], [10, 60_000], [100, 6_000], [100, 0], [5, 120_000]]) {
    assert.deepEqual(validateChannelConfig(limits(batchSize, delayMs)).limits, { ...DEFAULT_LIMITS, batchSize, delayMs }, `${batchSize} × ${delayMs}`);
  }
  for (const [batchSize, delayMs] of [[1, 600_001], [10, 600_000], [2, 300_001], [100, 6_001]]) {
    assert.deepEqual(issuesOf(limits(batchSize, delayMs)), ['limits.delayMs:batch_delay_too_long'], `${batchSize} × ${delayMs}`);
  }
  assert.throws(
    () => validateChannelConfig(limits(10, 600_000)),
    error => /batchSize × delayMs tối đa 600000 ms \(10 phút\)/.test(error.issues[0].message),
  );
  // A value already out of range is reported once, not again as a product.
  assert.deepEqual(issuesOf(limits(101, 600_000)), ['limits.batchSize:out_of_range']);
  assert.deepEqual(issuesOf(limits(2, 3_600_001)), ['limits.delayMs:out_of_range']);
});

test('prompt language, style, audience, and custom system prompt are validated', () => {
  const prompt = validateChannelConfig(minimalInput({
    prompt: { language: 'en', style: 'hot_take', audience: 'x'.repeat(300), customSystemPrompt: `${'y'.repeat(7_999)}\n` },
  })).prompt;
  assert.equal(prompt.language, 'en');
  assert.equal(prompt.style, 'hot_take');
  assert.equal(prompt.customSystemPrompt.length, 7_999);

  assert.deepEqual(issuesOf(minimalInput({
    prompt: { language: 'fr', style: 'poem', audience: 'x'.repeat(301), customSystemPrompt: 'z'.repeat(8_001) },
  })), [
    'prompt.language:invalid_value',
    'prompt.style:invalid_value',
    'prompt.audience:too_long',
    'prompt.customSystemPrompt:too_long',
  ]);
  assert.deepEqual(issuesOf(minimalInput({ prompt: { audience: '' } })), ['prompt.audience:required']);
  assert.deepEqual(issuesOf(minimalInput({ prompt: { audience: 'IT\nops' } })), ['prompt.audience:invalid_characters']);
  assert.deepEqual(issuesOf(minimalInput({ prompt: { audience: 'IT', customSystemPrompt: 'a\u0000b' } })), ['prompt.customSystemPrompt:invalid_characters']);
});

test('every supported AI provider validates with its credential policy', () => {
  for (const provider of AI_PROVIDERS) {
    const ai = { provider, ...(provider === 'custom' && { baseUrl: 'https://llm.example.test/v1' }) };
    assert.equal(validateChannelConfig(minimalInput({ ai })).ai.provider, provider);
  }
  assert.deepEqual(aiCredentialRequirements({ provider: 'claude', gateway: null }), { apiKey: 'required', gatewayToken: false });
  assert.deepEqual(aiCredentialRequirements({ provider: 'gemini', gateway: null }), { apiKey: 'required', gatewayToken: false });
  assert.deepEqual(aiCredentialRequirements({ provider: 'gemini', gateway: {} }), { apiKey: 'none', gatewayToken: true });
  assert.deepEqual(aiCredentialRequirements({ provider: 'ollama', gateway: null }), { apiKey: 'none', gatewayToken: false });
  assert.deepEqual(aiCredentialRequirements({ provider: 'custom', gateway: null }), { apiKey: 'optional', gatewayToken: false });
});

test('provider-specific AI fields are rejected where they do not apply', () => {
  assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'anthropic' } })), ['ai.provider:invalid_value']);
  assert.deepEqual(issuesOf(minimalInput({
    ai: { provider: 'openai', name: 'Mine', baseUrl: 'https://llm.example.test', gateway: { accountId: 'a', gatewayId: 'b' } },
  })), ['ai.gateway:not_applicable', 'ai.name:not_applicable', 'ai.baseUrl:not_applicable']);
  assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'ollama', apiKeyCredentialId: 'ai-key' } })), ['ai.apiKeyCredentialId:not_applicable']);
  assert.deepEqual(issuesOf(minimalInput({
    ai: { provider: 'gemini', apiKeyCredentialId: 'ai-key', gateway: { accountId: 'a', gatewayId: 'b' } },
  })), ['ai.apiKeyCredentialId:not_applicable']);
  assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'custom' } })), ['ai.baseUrl:required']);
  assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'gemini', gateway: {} } })), [
    'ai.gateway.accountId:required',
    'ai.gateway.gatewayId:required',
  ]);
  assert.deepEqual(issuesOf(minimalInput({
    ai: { provider: 'gemini', gateway: { accountId: 'a b', gatewayId: 'news/engine', byokAlias: 'x\ny', extra: true } },
  })), [
    'ai.gateway.extra:unknown_field',
    'ai.gateway.accountId:invalid_format',
    'ai.gateway.gatewayId:invalid_format',
    'ai.gateway.byokAlias:invalid_characters',
  ]);
  assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'claude', model: 'claude sonnet' } })), ['ai.model:invalid_format']);
});

test('AI base URLs must be credential-free http(s) URLs and lose trailing slashes', () => {
  assert.equal(validateChannelConfig(minimalInput({ ai: { provider: 'ollama', baseUrl: 'http://ollama:11434/v1/' } })).ai.baseUrl, 'http://ollama:11434/v1');
  for (const baseUrl of ['ftp://llm.example.test', 'https://user:pass@llm.example.test/v1', 'not a url', 'javascript:alert(1)']) {
    assert.deepEqual(issuesOf(minimalInput({ ai: { provider: 'custom', baseUrl } })), ['ai.baseUrl:invalid_url'], baseUrl);
  }
});

test('credential references must look like credential ids', () => {
  assert.deepEqual(issuesOf(minimalInput({
    ai: { provider: 'claude', apiKeyCredentialId: 'has space' },
    telegram: { botTokenCredentialId: 'ok-id', chatIdCredentialId: '-starts-with-dash' },
  })), ['ai.apiKeyCredentialId:invalid_format', 'telegram.chatIdCredentialId:invalid_format']);
});

test('credential references are listed in slot order with their required kinds', () => {
  const config = validateChannelConfig(minimalInput({
    ai: { provider: 'gemini', gateway: { accountId: 'a', gatewayId: 'b', tokenCredentialId: 'gw' } },
    telegram: { botTokenCredentialId: 'bot', chatIdCredentialId: 'chat' },
  }));
  assert.deepEqual(listCredentialReferences(config), [
    { field: 'telegram.botTokenCredentialId', kind: 'telegram_bot_token', credentialId: 'bot' },
    { field: 'telegram.chatIdCredentialId', kind: 'telegram_chat_id', credentialId: 'chat' },
    { field: 'ai.gateway.tokenCredentialId', kind: 'ai_gateway_token', credentialId: 'gw' },
  ]);
  assert.deepEqual(listCredentialReferences(validateChannelConfig(minimalInput())), []);
});

test('unknown fields are rejected at every level while echoed record metadata is ignored', () => {
  assert.deepEqual(issuesOf(minimalInput({
    secretToken: 'should-not-be-here',
    prompt: { audience: 'IT', systemPrompt: 'legacy' },
    ai: { provider: 'claude', apiKey: 'raw-key' },
    telegram: { botToken: 'raw-token' },
    limits: { retries: 2 },
  })), [
    'secretToken:unknown_field',
    'prompt.systemPrompt:unknown_field',
    'ai.apiKey:unknown_field',
    'telegram.botToken:unknown_field',
    'limits.retries:unknown_field',
  ]);
  const config = validateChannelConfig(minimalInput({ version: 4, createdAt: 'x', updatedAt: 'y', updatedBy: 'z' }));
  assert.equal('version' in config, false);
});

test('enabled channels need at least one enabled source; disabled channels may pause them all', () => {
  const sources = [{ type: 'preset', preset: 'bigTechBlogs', enabled: false }];
  assert.deepEqual(issuesOf(minimalInput({ sources })), ['sources:no_enabled_sources']);
  assert.equal(validateChannelConfig(minimalInput({ enabled: false, sources })).sources[0].enabled, false);
  assert.deepEqual(issuesOf(minimalInput({ enabled: 'yes' })), ['enabled:invalid_type']);
});

test('validation errors name fields and codes but never echo submitted values', () => {
  const secretLooking = 'sk-live-should-never-be-echoed';
  let error;
  try {
    validateChannelConfig(minimalInput({ id: secretLooking.toUpperCase(), name: secretLooking.repeat(10), unexpected: secretLooking }));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ChannelValidationError);
  assert.equal(error.code, 'validation_failed');
  assert.match(error.message, /^Channel configuration is invalid: unexpected unknown_field, id invalid_format, name too_long$/);
  const serialized = JSON.stringify({ message: error.message, issues: error.issues });
  assert.ok(!serialized.includes(secretLooking));
  assert.ok(!serialized.includes(secretLooking.toUpperCase()));
  for (const issue of error.issues) assert.ok(issue.message.length > 0);
});

test('unknown field names are echoed with a bounded length', () => {
  const key = 'k'.repeat(500);
  const [issue] = issuesOf(minimalInput({ [key]: true }));
  assert.equal(issue, `${'k'.repeat(64)}…:unknown_field`);
});
