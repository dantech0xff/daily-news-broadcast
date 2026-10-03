import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppMiddlewares } from '../../src/app/runtime/run-channel.js';
import { buildEngine, createDefaultMiddlewares } from '../../src/channels/runner.js';
import { MemoryCache } from '../../src/core/caches.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

function channel(overrides = {}) {
  return {
    id: 'telegram-main',
    sources: [new RecordingSource()],
    ai: new RecordingAI(),
    output: new RecordingOutput(),
    prompt: {},
    maxArticles: 7,
    ...overrides,
  };
}

function stageNames(middlewares) {
  return middlewares.map(middleware => JSON.parse(middleware.selectionKey)[0]);
}

test('existing callers keep the default chain: tech gate, scoring, semantic dedup', () => {
  const legacy = buildEngine(channel(), new MemoryCache());
  const dependencies = buildEngine(channel(), { cache: new MemoryCache() });

  for (const engine of [legacy, dependencies]) {
    assert.deepEqual(stageNames(engine.middlewares), ['tech-relevance', 'scoring', 'semantic-dedup']);
    assert.deepEqual(
      engine.middlewares.map(middleware => middleware.selectionKey),
      createDefaultMiddlewares(channel()).map(middleware => middleware.selectionKey),
    );
    assert.equal(engine.middlewares[0].label, 'tech-relevance');
    assert.equal(JSON.parse(engine.middlewares[1].selectionKey)[1], 7);
  }
});

test('the default scoring cut falls back to 12 articles', () => {
  const [, scoring] = createDefaultMiddlewares({});
  assert.equal(JSON.parse(scoring.selectionKey)[1], 12);
});

test('callers can replace the selection chain', () => {
  const only = articles => articles;
  only.selectionKey = 'custom-only';
  const engine = buildEngine(channel(), { cache: new MemoryCache(), middlewares: [only] });
  assert.deepEqual(engine.middlewares, [only]);
  assert.deepEqual(buildEngine(channel(), { cache: new MemoryCache(), middlewares: [] }).middlewares, []);
});

test('an invalid chain is rejected', () => {
  for (const middlewares of [null, 'chain', [() => [], 'not a function']]) {
    assert.throws(() => buildEngine(channel(), { cache: new MemoryCache(), middlewares }), TypeError);
  }
});

test('the app chain puts the cutover filter ahead of the default chain', () => {
  const app = createAppMiddlewares({ maxArticles: 7, notBefore: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(stageNames(app), ['not-before', 'tech-relevance', 'scoring', 'semantic-dedup']);
  assert.deepEqual(
    app.slice(1).map(middleware => middleware.selectionKey),
    createDefaultMiddlewares({ maxArticles: 7 }).map(middleware => middleware.selectionKey),
  );
});
