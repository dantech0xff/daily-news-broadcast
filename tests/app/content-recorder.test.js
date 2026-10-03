import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRecorder } from '../../src/app/runtime/content-recorder.js';
import { createAppMiddlewares } from '../../src/app/runtime/run-channel.js';
import { channelArticleHash } from '../../src/core/delivery.js';

const SEEN_AT = '2026-10-03T08:00:00.000Z';
const clock = () => new Date(SEEN_AT);
const silent = { warn() {} };

function article(id, title, overrides = {}) {
  return { id, title, url: `https://example.test/${id}`, source: 'Feed A', category: 'AI/ML', content: title, ...overrides };
}

async function runChain(middlewares, articles) {
  let current = articles;
  for (const middleware of middlewares) current = await middleware(current);
  return current;
}

test('each stage records the candidates it drops with its reason and survivors as selected', async () => {
  const recorder = new ContentRecorder({
    channelId: 'telegram-main',
    runId: 'run-1',
    sources: [{ id: 'rss-a', name: 'Feed A' }],
    clock,
    logger: silent,
  });
  const chain = createAppMiddlewares({ maxArticles: 3, notBefore: '2026-10-01T00:00:00.000Z' }, { recorder });
  const candidates = [
    article('old', 'Rust compiler release notes', { publishedAt: '2026-09-30T00:00:00.000Z' }),
    article('gossip', 'Celebrity wedding gossip roundup', { category: undefined, content: 'Red carpet fashion.' }),
    article('k8s', 'Kubernetes 1.40 ships sidecar containers', { meta: { points: 1_000 } }),
    article('k8s-again', 'Kubernetes 1.40 ships sidecar containers today', { meta: { points: 100 } }),
    article('quiet', 'Database indexing notes', { meta: { points: 0 } }),
    article('rust', 'Rust 2.0 compiler lands async closures', { meta: { points: 500 } }),
  ];

  const kept = await runChain(chain, candidates);
  assert.deepEqual(kept.map(entry => entry.id), ['k8s', 'rust']);

  const observed = Object.fromEntries(recorder.observations().map(row => [row.title, row]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(observed).map(([title, row]) => [title, [row.status, row.rejectReason]])),
    {
      'Rust compiler release notes': ['rejected', 'before_cutoff'],
      'Celebrity wedding gossip roundup': ['rejected', 'not_tech'],
      'Database indexing notes': ['rejected', 'low_score'],
      'Kubernetes 1.40 ships sidecar containers today': ['rejected', 'duplicate'],
      'Kubernetes 1.40 ships sidecar containers': ['selected', null],
      'Rust 2.0 compiler lands async closures': ['selected', null],
    },
  );
  const selected = observed['Kubernetes 1.40 ships sidecar containers'];
  assert.equal(selected.articleKey, await channelArticleHash('telegram-main', candidates[2]));
  assert.deepEqual({ ...selected, articleKey: undefined }, {
    channelId: 'telegram-main',
    articleKey: undefined,
    title: 'Kubernetes 1.40 ships sidecar containers',
    url: 'https://example.test/k8s',
    sourceId: 'rss-a',
    sourceName: 'Feed A',
    category: 'AI/ML',
    publishedAt: null,
    status: 'selected',
    rejectReason: null,
    runId: 'run-1',
    seenAt: SEEN_AT,
  });
});

test('wrapping keeps each stage label and selection key, so engine counts and drip fingerprints match', () => {
  const recorder = new ContentRecorder({ channelId: 'telegram-main', clock, logger: silent });
  const plain = createAppMiddlewares({ maxArticles: 5, notBefore: null });
  const wrapped = createAppMiddlewares({ maxArticles: 5, notBefore: null }, { recorder });
  assert.deepEqual(wrapped.map(stage => stage.selectionKey), plain.map(stage => stage.selectionKey));
  assert.deepEqual(wrapped.map(stage => stage.label), plain.map(stage => stage.label));
});

test('a later pass of the same article replaces its earlier observation', async () => {
  const recorder = new ContentRecorder({ channelId: 'telegram-main', clock, logger: silent });
  const chain = createAppMiddlewares({ maxArticles: 1, notBefore: null }, { recorder });
  await runChain(chain, [article('a', 'Rust compiler update ships'), article('b', 'GPU driver update lands', { meta: { points: 900 } })]);
  await runChain(chain, [article('a', 'Rust compiler update ships')]);
  const byTitle = Object.fromEntries(recorder.observations().map(row => [row.title, row.status]));
  assert.deepEqual(byTitle, { 'Rust compiler update ships': 'selected', 'GPU driver update lands': 'selected' });
  assert.equal(recorder.observations().length, 2);
});

test('source names shared by several sources map to no source id', async () => {
  const recorder = new ContentRecorder({
    channelId: 'telegram-main',
    sources: [{ id: 'hn:rust', name: 'Hacker News' }, { id: 'hn:go', name: 'Hacker News' }, { id: 'rss-a', name: 'Feed A' }],
    clock,
    logger: silent,
  });
  const chain = createAppMiddlewares({ maxArticles: 5, notBefore: null }, { recorder });
  await runChain(chain, [article('hn-1', 'Rust compiler update ships', { source: 'Hacker News' })]);
  assert.equal(recorder.observations()[0].sourceId, null);
  assert.equal(recorder.observations()[0].sourceName, 'Hacker News');
});

test('recording problems are logged and never change the selection', async () => {
  const warnings = [];
  const recorder = new ContentRecorder({
    channelId: 'telegram-main',
    clock: () => { throw new Error('clock unavailable token=abc123'); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  const chain = createAppMiddlewares({ maxArticles: 5, notBefore: null }, { recorder });
  const kept = await runChain(chain, [article('a', 'Rust compiler update ships')]);
  assert.deepEqual(kept.map(entry => entry.id), ['a']);
  assert.equal(recorder.observations().length, 0);
  assert.ok(warnings.length > 0);
  assert.equal(JSON.stringify(warnings).includes('abc123'), false);

  const unprojectable = new ContentRecorder({ channelId: 'telegram-main', clock, logger: silent });
  const skippingChain = createAppMiddlewares({ maxArticles: 5, notBefore: null }, { recorder: unprojectable });
  const survivors = await runChain(skippingChain, [
    article('a', 'Rust compiler update ships'),
    article('bad-date', 'GPU kernels land in Linux', { publishedAt: 'not a date' }),
  ]);
  assert.equal(survivors.length, 2);
  assert.deepEqual(unprojectable.observations().map(row => row.title), ['Rust compiler update ships']);
});

test('candidates dropped outside the chain are recorded with the given reason', async () => {
  const recorder = new ContentRecorder({ channelId: 'telegram-main', clock, logger: silent });
  await recorder.observeExcluded([article('recap', 'Developers get GPT-6 from OpenAI today')], 'duplicate');
  assert.deepEqual(recorder.observations().map(row => [row.title, row.status, row.rejectReason]), [
    ['Developers get GPT-6 from OpenAI today', 'rejected', 'duplicate'],
  ]);
  await assert.rejects(recorder.observeExcluded([], 'covered'), TypeError);
});

test('stages need a known reject reason', () => {
  const recorder = new ContentRecorder({ channelId: 'telegram-main', clock, logger: silent });
  assert.throws(() => recorder.wrapStages([{ middleware: articles => articles, reason: 'boring' }]), TypeError);
  assert.throws(() => recorder.wrapStages([]), TypeError);
  assert.throws(() => new ContentRecorder({ channelId: '' }), TypeError);
});
