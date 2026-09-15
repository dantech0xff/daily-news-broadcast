import test from 'node:test';
import assert from 'node:assert/strict';

import {
  excludeCoveredStories,
  isSameStory,
  pickDistinctStories,
  storySignature,
} from '../../src/core/story-dedup.js';

function article(title, url = `https://example.test/${encodeURIComponent(title)}`) {
  return { id: url, title, url, source: 'Fixture', content: '' };
}

function same(left, right) {
  return isSameStory(storySignature(left), storySignature(right));
}

test('rewritten headlines and shared links about one story are the same story', () => {
  const pairs = [
    [
      article('OpenAI launches GPT-5.5 with lower inference latency'),
      article('GPT-5.5 is here: what OpenAI changed in its newest model'),
    ],
    [article('Nvidia unveils Rubin GPUs at GTC'), article('At GTC, Nvidia shows off Rubin architecture')],
    [
      article('Microsoft patches zero-day in Exchange'),
      article('Microsoft Exchange zero-day exploited in the wild'),
    ],
    [article("Apple's iOS 27 beta brings Siri changes"), article('Apple ships iOS 27 beta with a rebuilt Siri')],
    [
      article('Critical flaw found in popular VPN', 'https://news.example/security/vpn-flaw'),
      article('Someone posted this on Reddit', 'https://www.news.example/security/vpn-flaw/?utm_source=reddit&ref=hn#comments'),
    ],
    [
      article('Rust 1.90 released', 'https://blog.example/rust-190'),
      article("What's new in Rust 1.90", 'https://other.example/rust-190-notes'),
    ],
  ];

  for (const [left, right] of pairs) {
    assert.equal(same(left, right), true, `${left.title} ~ ${right.title}`);
  }
});

test('distinct launches that share a headline template are different stories', () => {
  const pairs = [
    [article('Anthropic launches Claude for Chrome'), article('Anthropic launches Claude for Excel')],
    [article('Introducing Gemini 3 Flash'), article('Introducing Gemini 3 Pro')],
    [article('Cloudflare Workers now support Python'), article('Cloudflare Workers now support Rust')],
    [article('Linux 7.0 released'), article('Linux 6.18 LTS lands in stable distributions')],
    [article('OpenAI launches GPT-5.5'), article('OpenAI hires a new CFO')],
    [article('AI trends to watch in 2026'), article('2026 state of Rust survey results')],
    [article('Top 10 Kubernetes mistakes'), article('10 years of Rust in production')],
  ];

  for (const [left, right] of pairs) {
    assert.equal(same(left, right), false, `${left.title} !~ ${right.title}`);
  }
});

test('signatures canonicalize links and ignore years, single digits, and filler words', () => {
  const signature = storySignature(article(
    'Why Google finally ships Gemini 3 in 2026',
    'HTTPS://WWW.Example.test/path/?utm_medium=feed&id=7#top',
  ));

  assert.equal(signature.url, 'https://example.test/path?id=7');
  assert.deepEqual([...signature.anchors], []);
  assert.ok(signature.tokens.has('google'));
  assert.ok(signature.tokens.has('gemini'));
  assert.ok(!signature.tokens.has('why'));
  assert.ok(!signature.tokens.has('3'));
  assert.equal(storySignature({ title: 'No link', url: 'not a url' }).url, null);
  assert.equal(same({ title: '', url: null }, { title: '', url: null }), false);
});

test('covered stories are excluded and each scan keeps one article per story', () => {
  const covered = [article('OpenAI launches GPT-5.5 with lower inference latency', 'https://openai.example/gpt-5-5')];
  const candidates = [
    article('GPT-5.5 is here: what OpenAI changed in its newest model', 'https://verge.example/gpt-5-5'),
    article('Postgres 18 adds asynchronous I/O', 'https://pg.example/18'),
    article('PostgreSQL 18 adds asynchronous I/O support', 'https://other.example/pg-18'),
    article('Kubernetes 1.40 ships sidecar containers', 'https://k8s.example/1-40'),
  ];

  const uncovered = excludeCoveredStories(candidates, covered);
  assert.deepEqual(uncovered.map(value => value.url), [
    'https://pg.example/18',
    'https://other.example/pg-18',
    'https://k8s.example/1-40',
  ]);
  assert.deepEqual(pickDistinctStories(uncovered, 5).map(value => value.url), [
    'https://pg.example/18',
    'https://k8s.example/1-40',
  ]);
  assert.deepEqual(pickDistinctStories(uncovered, 1).map(value => value.url), ['https://pg.example/18']);
});
