import test from 'node:test';
import assert from 'node:assert/strict';

import { defineChannels, validateChannels } from '../../src/channels/definitions.js';

function validChannel(overrides = {}) {
  return {
    id: 'channel', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC',
    sources: [{}], ai: {}, output: {}, ...overrides,
  };
}

test('channel definitions fail missing AI credentials before runtime delivery', () => {
  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination', AI_PROVIDER: 'claude',
  }), /ANTHROPIC_API_KEY/);
});

test('X channel fails closed without a stable authenticated destination identity', () => {
  assert.throws(() => defineChannels({
    X_CLIENT_ID: 'client',
    TOKEN_ENCRYPTION_KEY: 'encryption-key',
    NEWS_CACHE: {},
    ANTHROPIC_API_KEY: 'ai-key',
  }), /X_DESTINATION_ID/);
});

test('channel validation rejects duplicate IDs, invalid cron, and invalid timezones', () => {
  assert.throws(() => validateChannels([validChannel(), validChannel()]), /duplicate/i);
  assert.throws(() => validateChannels([validChannel({ schedule: '75 9 * * *' })]), /cron/i);
  assert.throws(() => validateChannels([validChannel({ timezone: 'Not/A-Timezone' })]), /timezone/i);
});

test('channel validation rejects unsafe numeric runtime bounds', () => {
  for (const overrides of [
    { concurrency: -1 },
    { concurrency: 0 },
    { concurrency: 1.5 },
    { batchSize: -1 },
    { delayMs: -1 },
    { maxArticles: 0 },
    { maxArticlesPerSource: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => validateChannels([validChannel(overrides)]), /invalid|must|range/i);
  }

  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination',
    ANTHROPIC_API_KEY: 'key', CONCURRENCY_LIMIT: '5oops',
  }), /CONCURRENCY_LIMIT/);
});
