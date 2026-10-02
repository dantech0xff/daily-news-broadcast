import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryCache } from '../../src/core/caches.js';
import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { TelegramOutput } from '../../src/outputs/telegram.js';
import { RecordingAI, RecordingSource } from '../helpers/fakes.js';

test('Telegram single-mutation canary makes exactly one plain-text provider request', async () => {
  const calls = [];
  const output = new TelegramOutput({
    botToken: 'test-token',
    chatId: 'test-chat',
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await output.send('**one message**', {
    singleMutation: true,
    article: { imageUrl: 'https://example.com/image.png' },
  });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(typeof calls[0].body.text, 'string');
  assert.equal(calls[0].body.parse_mode, undefined);
});

test('Telegram single-mutation canary rejects oversized content before provider I/O', async () => {
  let calls = 0;
  const output = new TelegramOutput({
    botToken: 'test-token',
    chatId: 'test-chat',
    fetch: async () => { calls += 1; throw new Error('must not run'); },
  });
  const result = await output.send('x'.repeat(4_097), { singleMutation: true });
  assert.equal(result.success, false);
  assert.equal(result.meta.deliveryState, 'definitive_failure');
  assert.equal(result.meta.retryDisposition, 'never');
  assert.equal(calls, 0);
});

test('engine preserves the single-mutation guard and never truncates an oversized canary into provider I/O', async () => {
  let providerCalls = 0;
  const output = new TelegramOutput({
    botToken: 'test-token',
    chatId: 'test-chat',
    fetch: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  const store = new MemoryDeliveryStore({ durable: true });
  const now = '2026-07-20T08:00:00.000Z';
  await store.transact(tx => tx.put('channel_state', 'telegram-main', {
    channelId: 'telegram-main',
    mutationState: 'free',
    activeOutputAttemptId: null,
    paused: true,
    createdAt: now,
    updatedAt: now,
  }, { expectedVersion: 0 }));
  const engine = new ContentRadar()
    .addSource(new RecordingSource([{
      id: 'canary-article',
      title: 'Canary article',
      url: 'https://example.invalid/canary',
      content: 'Offline content',
      source: 'offline-source',
    }]))
    .useAI(new RecordingAI('x'.repeat(4_097)))
    .addOutput(output)
    .useCache(new MemoryCache())
    .useDeliveryStore(store)
    .configure({
      channelId: 'telegram-main',
      maxRetries: 0,
      clock: () => new Date(now),
    });

  const result = await engine.runDrip({
    requestId: 'opaque-canary-request',
    idempotencyKey: 'opaque-canary-request',
    force: true,
    operatorForce: true,
    confirmPausedMutation: true,
    singleMutation: true,
    articleLimit: 1,
    batchSize: 1,
  });

  assert.equal(result.status, 'failed');
  assert.equal(providerCalls, 0);
  const [delivery] = await store.list('deliveries');
  assert.equal(delivery.singleMutation, true);
  assert.equal(delivery.generatedContent.length, 4_097);
  assert.equal((await store.list('delivery_outputs'))[0].state, 'exhausted');
});
