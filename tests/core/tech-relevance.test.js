import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import {
  TRUSTED_TECH_CATEGORIES,
  createTechRelevanceMiddleware,
  scoreTechRelevance,
} from '../../src/core/tech-relevance.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

// Realistic headline shapes from the configured feeds, paraphrased. `keep` is the expected verdict.
const LABELED_ARTICLES = [
  { keep: true, category: 'AI News', title: 'Claude users found workarounds to research safeguards' },
  { keep: true, category: 'AI News', title: "Why this month's Microsoft patch release matters for admins" },
  { keep: true, category: 'AI News', title: 'With iOS 27, Siri finally feels useful again' },
  { keep: true, category: 'Community', title: 'Principles for fast Tokio applications', content: '412 points, 88 comments' },
  { keep: true, category: 'Community', title: 'Distributed systems classics worth rereading', content: '230 points, 41 comments' },
  { keep: true, category: 'Community', title: 'Notes on migrating our team to self-hosted Ollama' },
  { keep: true, category: 'Community', title: 'Qwen3.5-72B quantized runs on two used GPUs', content: '640 upvotes, 120 comments' },
  { keep: true, category: 'Community', title: 'Show HN: A Rust compiler plugin for WebAssembly' },
  { keep: true, category: 'AI News', title: 'OpenAI ships GPT-5.5 API with lower inference latency' },
  { keep: true, category: 'AI News', title: 'Nvidia unveils new data center chips at GTC' },
  { keep: true, category: 'AI News', title: 'Google DeepMind details a robotics foundation model' },
  { keep: true, category: 'AI News', title: 'Fashion app Daydream taps Apple Intelligence for styling tips' },
  { keep: true, category: 'Community', title: 'Ask HN: How do you review AI-generated pull requests?' },
  { keep: true, category: 'Community', title: 'PostgreSQL 18 released with asynchronous I/O' },
  { keep: true, title: 'Critical zero-day in popular VPN appliance exploited in the wild' },
  { keep: true, category: 'Open Source', title: 'fast-kv: a Redis-compatible key-value store written in Rust', content: 'Stars: 1200' },
  {
    keep: true,
    category: 'javascript, webdev',
    title: 'Understanding closures once and for all',
    content: 'A walkthrough of JavaScript closures with examples for React developers.',
  },
  { keep: true, category: 'Big Tech', title: 'Our year in review' },
  { keep: true, category: 'AI Deep-Dive', title: 'Notes from a long weekend of reading' },
  {
    keep: false,
    category: 'AI News',
    title: 'Senators grill tech CEOs at election-year hearing',
    content: 'Lawmakers questioned executives from OpenAI and Anthropic.',
  },
  {
    keep: false,
    category: 'AI News',
    title: 'Senate hearing recap',
    content: 'Witnesses discussed AI chips, GPUs, and cloud data centers.',
  },
  { keep: false, category: 'Community', title: 'Holiday gift guide: best deals for gamers' },
  { keep: false, category: 'Community', title: 'Memecoin price prediction: is it going to the moon?' },
  { keep: false, category: 'AI News', title: 'Celebrity chef launches AI recipe app' },
  { keep: false, category: 'AI News', title: 'Astrology app claims AI can read your horoscope' },
  { keep: false, category: 'Community', title: 'The history of Roman aqueducts', content: '350 points, 90 comments' },
  { keep: false, title: 'NFL season preview: every team ranked' },
  { keep: false, category: 'Community', title: 'Rustic cabin tours along the fjords' },
  { keep: false, category: 'Community', title: 'Mail carriers said the new routes are slower' },
  { keep: false, category: 'career, productivity', title: 'My morning routine as a remote worker' },
  { keep: false, category: 'Open Source', title: 'awesome-memes: a curated list of memes', content: 'Stars: 5000' },
  { keep: false, category: 'big tech', title: 'Our year in review' },
  { keep: false, category: 'Community', title: 'Election night live updates', content: 'Coverage includes AI-generated maps.' },
  { keep: false, category: 'AI News', title: 'Weekly roundup' },
];

test('labeled headline fixtures match the expected tech relevance verdicts', () => {
  const middleware = createTechRelevanceMiddleware();
  const articles = LABELED_ARTICLES.map((fixture, index) => ({
    id: `fixture-${index}`,
    url: `https://example.test/${index}`,
    source: 'Fixture',
    content: '',
    ...fixture,
  }));
  const kept = new Set(middleware(articles).map(article => article.id));

  for (const article of articles) {
    assert.equal(kept.has(article.id), article.keep, `${article.keep ? 'kept' : 'dropped'}: ${article.title}`);
  }
});

test('each distinct term scores once, preferring the title weight', () => {
  const scored = scoreTechRelevance({ title: 'Rust tips', content: 'rust Rust RUST' });

  assert.equal(scored.techScore, 2);
  assert.equal(scored.titleTechHits, 1);
});

test('category labels are never scored as article text', () => {
  const scored = scoreTechRelevance({ category: 'AI News', title: 'Weekly roundup', content: '' });

  assert.equal(scored.trusted, false);
  assert.equal(scored.techScore, 0);
  assert.equal(scored.relevant, false);
});

test('plural and inflected forms match without matching inside other words', () => {
  assert.equal(scoreTechRelevance({ title: 'Cheaper GPUs arrive' }).techScore, 2);
  assert.equal(scoreTechRelevance({ title: 'Vendor patched the exploited flaw' }).techScore, 2);
  assert.equal(scoreTechRelevance({ title: 'Senators meet', content: '' }).offTopicScore, 2);
  assert.equal(scoreTechRelevance({ title: 'Rustic said mail' }).techScore, 0);
});

test('trusted categories match exactly and bypass scoring', () => {
  assert.ok(TRUSTED_TECH_CATEGORIES.includes('Big Tech'));
  assert.ok(!TRUSTED_TECH_CATEGORIES.includes('Open Source'));
  assert.equal(scoreTechRelevance({ category: 'Big Tech', title: 'Office party photos' }).relevant, true);
  assert.equal(scoreTechRelevance({ category: 'BIG TECH', title: 'Office party photos' }).relevant, false);
  assert.equal(scoreTechRelevance({ category: 'devops', title: 'Office party photos' }).relevant, false);
});

test('middleware keeps order, never mutates input, and exposes a stable selection key', () => {
  const articles = [
    { id: 'b', title: 'Kubernetes upgrade notes', category: 'Community', meta: { score: 1 } },
    { id: 'x', title: 'Celebrity gossip roundup', category: 'Community' },
    { id: 'a', title: 'Postgres indexing guide', category: 'Community' },
  ];
  const snapshot = structuredClone(articles);
  const middleware = createTechRelevanceMiddleware();

  assert.deepEqual(middleware(articles).map(article => article.id), ['b', 'a']);
  assert.deepEqual(articles, snapshot);
  assert.equal(middleware.label, 'tech-relevance');
  assert.equal(middleware.selectionKey, createTechRelevanceMiddleware().selectionKey);
  assert.notEqual(middleware.selectionKey, createTechRelevanceMiddleware({ minTechScore: 3 }).selectionKey);
  assert.notEqual(
    middleware.selectionKey,
    createTechRelevanceMiddleware({ trustedCategories: ['Big Tech'] }).selectionKey,
  );
});

test('off-topic items never reach AI generation and selection counts show the filter', async () => {
  const ai = new RecordingAI('digest');
  const source = new RecordingSource([
    { id: 'tech', title: 'Kubernetes 1.40 ships sidecar containers', url: 'https://example.test/k8s', content: '', source: 'Fixture', category: 'Community' },
    { id: 'off', title: 'Celebrity wedding photos go viral', url: 'https://example.test/wedding', content: '', source: 'Fixture', category: 'Community' },
  ]);
  const result = await new ContentRadar()
    .addSource(source)
    .useAI(ai)
    .addOutput(new RecordingOutput())
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .use(createTechRelevanceMiddleware())
    .configure({ channelId: 'telegram-main', maxRetries: 0 })
    .run({ requestId: 'tech-relevance-digest' });

  assert.equal(result.status, 'success');
  assert.deepEqual(ai.calls[0].articles.map(article => article.id), ['tech']);
  assert.deepEqual(result.stats.selection, { fetched: 2, fresh: 2, relevant: 1, ranked: 1 });
});
