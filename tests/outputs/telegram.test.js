import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TelegramOutput } from '../../src/outputs/telegram.js';
import {
  assertCanonicalResult,
  jsonResponse,
  noDelay,
  sequenceFetch,
} from './test-helpers.js';

const config = {
  botToken: '123456:super-secret-token',
  chatId: '-1009876543210',
  sleep: noDelay,
};

test('Telegram returns canonical success metadata and all message IDs', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 11 } }),
    jsonResponse(200, { ok: true, result: { message_id: 12 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send(`${'a'.repeat(4096)}\n\nsecond`);

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '11');
  assert.deepEqual(result.meta.successfulMessageIds, ['11', '12']);
  assert.equal(result.meta.parts, 2);
  assert.equal(transport.calls.length, 2);
});

test('Telegram stops at the first failed part and preserves partial mutation evidence', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 21 } }),
    jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: rejected' }),
    jsonResponse(200, { ok: true, result: { message_id: 23 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const content = ['a'.repeat(4090), 'b'.repeat(4090), 'c'.repeat(100)].join('\n\n');

  const result = await output.send(content);

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, '21');
  assert.deepEqual(result.meta.successfulMessageIds, ['21']);
  assert.equal(result.meta.partsAttempted, 2);
  assert.equal(result.meta.partsTotal, 3);
  assert.deepEqual(result.meta.partialMutation, {
    successfulSteps: 1,
    completedSteps: 1,
    totalSteps: 3,
    failedStep: 2,
    messageIds: ['21'],
  });
  assert.equal(result.meta.partResults[0].messageId, '21');
  assert.equal(result.meta.partResults[1].deliveryState, 'definitive_failure');
  assert.equal(transport.calls.length, 2);
});

test('Telegram only retries Markdown as plain text after definitive format rejection', async () => {
  const transport = sequenceFetch([
    jsonResponse(400, {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }),
    jsonResponse(200, { ok: true, result: { message_id: 31 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '31');
  assert.equal(result.meta.fallbackAttempted, true);
  assert.equal(transport.calls.length, 2);
  assert.equal(JSON.parse(transport.calls[1].init.body).parse_mode, undefined);
});

test('Telegram does not fallback after an ambiguous provider response', async () => {
  const transport = sequenceFetch([
    jsonResponse(503, { ok: false, description: "can't parse entities" }),
    jsonResponse(200, { ok: true, result: { message_id: 42 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(transport.calls.length, 1);
});

test('Telegram HTTP 5xx stays ambiguous even if the body claims a 4xx parse error', async () => {
  const transport = sequenceFetch([
    jsonResponse(503, {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }),
    jsonResponse(200, { ok: true, result: { message_id: 43 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, '400');
  assert.equal(transport.calls.length, 1);
});

test('Telegram invalid success envelopes are ambiguous and never retried as fallback', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: {} }),
    jsonResponse(200, { ok: true, result: { message_id: 44 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, 'invalid_response');
  assert.equal(transport.calls.length, 1);
});

test('Telegram aborts a never-resolving request and classifies it as ambiguous', async () => {
  let signal;
  const fetch = (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  };
  const output = new TelegramOutput({ ...config, fetch, timeoutMs: 5 });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, 'timeout');
  assert.equal(signal.aborted, true);
});

test('Telegram 429 is a definitive automatic retry with bounded timing metadata', async () => {
  const now = () => Date.parse('2026-07-20T10:00:00.000Z');
  const transport = sequenceFetch([
    jsonResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 7 },
    }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch, now });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'definitive_failure', 'automatic');
  assert.equal(result.meta.providerCode, '429');
  assert.equal(result.meta.retryAfterMs, 7000);
  assert.equal(result.meta.nextAttemptAt, '2026-07-20T10:00:07.000Z');
});

test('Telegram sanitizes provider errors and never exposes its destination or token', async () => {
  const transport = sequenceFetch([
    jsonResponse(400, {
      ok: false,
      error_code: 400,
      description: 'Bad https://private.example/hook for -1009876543210 token 123456:super-secret-token',
    }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('hello');
  const serialized = JSON.stringify(result);

  assertCanonicalResult(result, 'definitive_failure', 'never');
  assert.doesNotMatch(serialized, /private\.example/);
  assert.doesNotMatch(serialized, /-1009876543210/);
  assert.doesNotMatch(serialized, /super-secret-token/);
});

test('Telegram photo fallback is blocked after uncertainty and long-photo flows stop on failure', async () => {
  const uncertainPhoto = sequenceFetch([
    jsonResponse(500, { ok: false, description: 'upstream error' }),
    jsonResponse(200, { ok: true, result: { message_id: 51 } }),
  ]);
  const uncertainOutput = new TelegramOutput({ ...config, fetch: uncertainPhoto.fetch });

  const uncertain = await uncertainOutput.send('caption', {
    article: { imageUrl: 'https://example.test/image.png' },
  });

  assertCanonicalResult(uncertain, 'ambiguous', 'manual');
  assert.equal(uncertainPhoto.calls.length, 1);

  const partialPhoto = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 61 } }),
    jsonResponse(400, { ok: false, error_code: 400, description: 'text rejected' }),
    jsonResponse(200, { ok: true, result: { message_id: 63 } }),
  ]);
  const partialOutput = new TelegramOutput({ ...config, fetch: partialPhoto.fetch });

  const partial = await partialOutput.send('x'.repeat(1500), {
    article: { imageUrl: 'https://example.test/image.png' },
  });

  assertCanonicalResult(partial, 'ambiguous', 'manual');
  assert.equal(partial.messageId, '61');
  assert.deepEqual(partial.meta.successfulMessageIds, ['61']);
  assert.equal(partialPhoto.calls.length, 2);
});
