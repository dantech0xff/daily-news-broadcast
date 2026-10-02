import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

test('all failed sources return failed/sources_failed without AI or output mutation', async () => {
  const source = new RecordingSource([], { status: 'failed', articleCount: 0, failureType: 'http', httpStatus: 503 });
  const ai = new RecordingAI();
  const output = new RecordingOutput();
  const result = await new ContentRadar()
    .addSource(source)
    .useAI(ai)
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0 })
    .run({ requestId: 'sources-failed' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'sources_failed');
  assert.equal(ai.calls.length, 0);
  assert.equal(output.calls.length, 0);
});

test('proven healthy empty sources return a truthful exhausted skip', async () => {
  const source = new RecordingSource([], { status: 'empty', articleCount: 0 });
  const result = await new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI())
    .addOutput(new RecordingOutput())
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0 })
    .run({ requestId: 'sources-empty' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_articles');
  assert.equal(result.sourceHealth.exhaustionEligible, true);
});

test('mixed degradation may deliver healthy articles but remains visible', async () => {
  const healthy = new RecordingSource([{
    id: 'healthy-1', title: 'Healthy', url: 'https://example.com/healthy', content: '', source: 'Healthy',
  }], { status: 'success', articleCount: 1 });
  const failed = new RecordingSource([], { status: 'failed', articleCount: 0, failureType: 'transport' });
  Object.defineProperty(failed, 'id', { get: () => 'failed-source' });
  const result = await new ContentRadar()
    .addSource(healthy)
    .addSource(failed)
    .useAI(new RecordingAI())
    .addOutput(new RecordingOutput())
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0 })
    .run({ requestId: 'sources-degraded' });
  assert.equal(result.status, 'success');
  assert.equal(result.sourceHealth.degraded, true);
  assert.equal(result.sourceHealth.exhaustionEligible, false);
});
