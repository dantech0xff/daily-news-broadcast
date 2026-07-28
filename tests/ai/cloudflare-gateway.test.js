import assert from 'node:assert/strict';
import test from 'node:test';

import { geminiGateway } from '../../src/ai/openai-compat.js';
import { defineChannels } from '../../src/channels/definitions.js';

const article = {
  id: 'gateway-test',
  title: 'Cloudflare AI Gateway',
  url: 'https://example.test/gateway',
  content: 'Gateway request test',
  source: 'Test',
};

test('Gemini gateway uses Cloudflare auth and stored BYOK without a provider key', async () => {
  let request;
  const ai = geminiGateway({
    accountId: 'account/id',
    gatewayId: 'news-engine',
    token: 'cf-token',
    model: 'gemini-3.5-flash-lite',
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Gateway digest' } }],
        model: 'google-ai-studio/gemini-3.5-flash-lite',
      }), { status: 200 });
    },
  });

  const result = await ai.summarize([article]);
  const body = JSON.parse(request.init.body);

  assert.equal(
    request.url,
    'https://gateway.ai.cloudflare.com/v1/account%2Fid/news-engine/compat/chat/completions',
  );
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(request.init.headers['cf-aig-authorization'], 'Bearer cf-token');
  assert.equal(request.init.headers['cf-aig-collect-log'], 'false');
  assert.equal(request.init.headers['cf-aig-collect-log-payload'], 'false');
  assert.equal(request.init.headers['cf-aig-skip-cache'], 'true');
  assert.equal(request.init.headers['cf-aig-byok-alias'], undefined);
  assert.equal(body.model, 'google-ai-studio/gemini-3.5-flash-lite');
  assert.equal(result.text, 'Gateway digest');
});

test('Gemini channel accepts complete gateway config without GEMINI_API_KEY', () => {
  const [channel] = defineChannels({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'destination',
    AI_PROVIDER: 'gemini',
    AI_MODEL: 'gemini-3.5-flash-lite',
    CF_AIG_TOKEN: 'cf-token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    AI_GATEWAY_ID: 'news-engine',
  });

  assert.match(channel.ai.name, /Cloudflare AI Gateway/);
});

test('Gemini channel rejects partial gateway config instead of falling back', () => {
  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'destination',
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'provider-key',
    CF_AIG_TOKEN: 'cf-token',
  }), /Incomplete Cloudflare AI Gateway config/);
});

test('Gateway variables do not satisfy credentials for another AI provider', () => {
  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'destination',
    AI_PROVIDER: 'claude',
    CF_AIG_TOKEN: 'cf-token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    AI_GATEWAY_ID: 'news-engine',
  }), /ANTHROPIC_API_KEY/);
});
