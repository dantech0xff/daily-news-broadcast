import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TelegramOutput } from '../../src/outputs/telegram.js';
import {
  OutputTimeoutError,
  fetchWithTimeout,
  readResponseBody,
} from '../../src/outputs/telegram-client.js';
import { assertCanonicalResult, noDelay } from './test-helpers.js';

test('response reader cancels immediately when a streamed chunk reaches the byte cap', async () => {
  const state = { reads: 0, cancelled: false, released: false };
  const reader = {
    async read() {
      state.reads += 1;
      return state.reads === 1
        ? { done: false, value: new Uint8Array(64).fill(65) }
        : { done: false, value: new Uint8Array(64).fill(66) };
    },
    async cancel() { state.cancelled = true; },
    releaseLock() { state.released = true; },
  };

  const parsed = await readResponseBody({
    body: { getReader: () => reader },
    headers: new Headers(),
  }, 32);

  assert.equal(parsed.validJson, false);
  assert.equal(parsed.tooLarge, true);
  assert.equal(parsed.readError, 'Provider response exceeded byte limit');
  assert.equal(parsed.text, '');
  assert.equal(state.reads, 1);
  assert.equal(state.cancelled, true);
  assert.equal(state.released, true);
});

test('response reader rejects declared oversized bodies without starting a read', async () => {
  const state = { reads: 0, cancelled: false };
  const parsed = await readResponseBody({
    body: {
      getReader() {
        state.reads += 1;
        throw new Error('must not acquire reader');
      },
      async cancel() { state.cancelled = true; },
    },
    headers: new Headers({ 'Content-Length': '9000' }),
  });

  assert.equal(parsed.tooLarge, true);
  assert.equal(state.reads, 0);
  assert.equal(state.cancelled, true);
});

test('response reader never returns malformed provider text', async () => {
  const privateText = 'malformed-private-provider-payload';
  const parsed = await readResponseBody(new Response(privateText, { status: 200 }));

  assert.deepEqual(parsed, {
    text: '',
    data: null,
    validJson: false,
    readError: 'Invalid provider response',
  });
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(privateText));
});

test('provider timeout remains active after headers while the response body stalls', async () => {
  const state = { cancelled: false };
  const response = await fetchWithTimeout(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          async cancel() { state.cancelled = true; },
          releaseLock() {},
        };
      },
    },
  }), 'https://offline-provider.invalid', {}, { timeoutMs: 10 });

  await assert.rejects(readResponseBody(response), OutputTimeoutError);
  assert.equal(state.cancelled, true);
});

test('response reader accepts valid JSON whose byte length exactly matches the cap', async () => {
  const body = '{"ok":true}';
  const parsed = await readResponseBody(new Response(body, {
    headers: { 'Content-Length': String(Buffer.byteLength(body)) },
  }), Buffer.byteLength(body));

  assert.equal(parsed.validJson, true);
  assert.deepEqual(parsed.data, { ok: true });
});

test('oversized Telegram errors retain HTTP classification without retaining their body', async () => {
  const privateText = 'private-provider-body';
  const output = new TelegramOutput({
    botToken: 'test-token',
    chatId: 'test-chat',
    sleep: noDelay,
    now: () => Date.parse('2026-07-20T10:00:00.000Z'),
    fetch: async () => new Response(privateText.repeat(1_000), {
      status: 429,
      headers: { 'Retry-After': '2' },
    }),
  });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'definitive_failure', 'automatic');
  assert.equal(result.meta.providerCode, '429');
  assert.equal(result.meta.retryAfterMs, 2_000);
  assert.equal(result.meta.nextAttemptAt, '2026-07-20T10:00:02.000Z');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText));
});
