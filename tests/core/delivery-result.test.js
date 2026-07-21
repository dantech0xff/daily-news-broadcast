import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSendResults,
  buildOutputTopology,
  normalizeSendResult,
  projectArticle,
  publishingDayFor,
  sanitizeError,
} from '../../src/core/delivery.js';
import { OutputPlugin } from '../../src/core/contracts.js';

test('normalizes legacy and canonical send results without inventing false success', () => {
  assert.deepEqual(normalizeSendResult({ success: true, messageId: 'm1' }), {
    success: true,
    messageId: 'm1',
    meta: {
      deliveryState: 'success',
      retryDisposition: 'never',
      successfulMessageIds: ['m1'],
    },
  });

  const legacyFailure = normalizeSendResult({ success: false, error: 'socket closed' });
  assert.equal(legacyFailure.success, false);
  assert.equal(legacyFailure.meta.deliveryState, 'ambiguous');
  assert.equal(legacyFailure.meta.retryDisposition, 'manual');

  const thrown = normalizeSendResult(null, { error: new Error('timeout with token=secret') });
  assert.equal(thrown.meta.deliveryState, 'ambiguous');
  assert.equal(thrown.meta.retryDisposition, 'manual');
  assert.doesNotMatch(thrown.meta.sanitizedError, /secret/);
});

test('canonical provider proof and retry timing are preserved through an allowlist', () => {
  const result = normalizeSendResult({
    success: false,
    error: 'rate limited',
    deliveryState: 'success',
    meta: {
      deliveryState: 'definitive_failure',
      retryDisposition: 'automatic',
      providerCode: '429',
      retryAfterMs: 2_000,
      arbitraryProviderPayload: { token: 'leak' },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.meta.deliveryState, 'definitive_failure');
  assert.equal(result.meta.retryDisposition, 'automatic');
  assert.equal(result.meta.retryAfterMs, 2_000);
  assert.equal(result.meta.providerCode, '429');
  assert.equal(result.meta.arbitraryProviderPayload, undefined);
});

test('rejects invalid classification combinations', () => {
  assert.throws(() => normalizeSendResult({
    success: true,
    meta: { deliveryState: 'definitive_failure', retryDisposition: 'automatic' },
  }), /conflicts/i);
  assert.throws(() => normalizeSendResult({
    success: false,
    meta: { deliveryState: 'mystery', retryDisposition: 'automatic' },
  }), /deliveryState/);
  assert.throws(() => normalizeSendResult({
    success: false,
    meta: {
      deliveryState: 'definitive_failure',
      retryDisposition: 'automatic',
      nextAttemptAt: 'not-a-date',
    },
  }), /canonical ISO instant/i);
  assert.throws(() => normalizeSendResult({
    success: false,
    meta: {
      deliveryState: 'definitive_failure',
      retryDisposition: 'manual',
      nextAttemptAt: '2026-07-20T10:00:00.000Z',
    },
  }), /requires retryDisposition=automatic/i);
});

test('aggregates success, safe partial failure, and ambiguity truthfully', () => {
  assert.equal(aggregateSendResults([
    normalizeSendResult({ success: true }),
    normalizeSendResult({ success: true }),
  ]).status, 'success');

  assert.equal(aggregateSendResults([
    normalizeSendResult({ success: true }),
    normalizeSendResult({
      success: false,
      meta: { deliveryState: 'definitive_failure', retryDisposition: 'automatic' },
    }),
  ]).status, 'partial');

  assert.equal(aggregateSendResults([
    normalizeSendResult({ success: true }),
    normalizeSendResult({ success: false }),
  ]).status, 'ambiguous');

  assert.equal(aggregateSendResults([
    normalizeSendResult({
      success: false,
      meta: { deliveryState: 'definitive_failure', retryDisposition: 'never' },
    }),
  ]).status, 'failed');
});

test('article projection is bounded, allowlisted, and rejects cyclic input', () => {
  const projected = projectArticle({
    id: 'article-1',
    title: 'T'.repeat(800),
    url: 'https://example.com/article',
    content: 'C'.repeat(20_000),
    source: 'Example',
    meta: { token: 'must-not-persist' },
  });
  assert.equal(projected.title.length, 500);
  assert.equal(projected.content.length, 4_000);
  assert.equal(projected.meta, undefined);

  const cyclic = { id: 'cycle', title: 'Cycle', source: 'test' };
  cyclic.meta = cyclic;
  assert.throws(() => projectArticle(cyclic), /serializable|cyclic/i);
});

test('topology is stable, opaque, and rejects duplicate destination keys', async () => {
  class FakeOutput extends OutputPlugin {
    constructor(key) { super(); this.key = key; }
    get id() { return 'fake'; }
    get name() { return 'Fake'; }
    get deliveryKey() { return this.key; }
  }

  const topology = await buildOutputTopology([
    new FakeOutput('telegram:chat-123'),
    new FakeOutput('discord:hook-456'),
  ]);
  assert.equal(topology.outputs.length, 2);
  assert.match(topology.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(topology), /chat-123|hook-456/);

  await assert.rejects(
    buildOutputTopology([new FakeOutput('same'), new FakeOutput('same')]),
    /Duplicate output deliveryKey/,
  );
});

test('publishing day is captured in the requested timezone', () => {
  const instant = new Date('2026-07-20T17:30:00.000Z');
  assert.equal(publishingDayFor(instant, 'UTC'), '2026-07-20');
  assert.equal(publishingDayFor(instant, 'Asia/Singapore'), '2026-07-21');
});

test('error sanitization strips credentials and private URL details', () => {
  const sanitized = sanitizeError(
    'Bearer abc.def.ghi token=supersecret failed at https://internal.example/private?q=secret',
  );
  assert.doesNotMatch(sanitized, /abc\.def|supersecret|private|q=secret/);
  assert.match(sanitized, /\[redacted/);
});
