import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SOURCE_ENTRIES,
  PRESET_FACTORIES,
  PRESET_NAMES,
  createSourcePlugins,
  normalizeSourceEntries,
} from '../../src/app/channels/source-factories.js';
import { IssueCollector } from '../../src/app/channels/validation.js';
import { SourcePlugin } from '../../src/core/contracts.js';
import * as presets from '../../src/presets/index.js';
import {
  DevToSource,
  GitHubTrendingSource,
  HackerNewsSource,
  HTMLScraperSource,
  JSONAPISource,
  RedditSource,
  RSSSource,
} from '../../src/sources/index.js';

function normalize(value) {
  const issues = new IssueCollector();
  const entries = normalizeSourceEntries(issues, value);
  return { entries, issues: issues.issues.map(({ field, code }) => `${field}:${code}`), details: issues.issues };
}

function normalizeValid(value) {
  const { entries, issues } = normalize(value);
  assert.deepEqual(issues, []);
  return entries;
}

const typedSources = [
  {
    entry: { type: 'rss', config: { id: 'example-feed', name: 'Example Feed', feedUrl: 'https://example.test/feed.xml', category: 'Testing' } },
    plugin: RSSSource,
    id: 'example-feed',
  },
  { entry: { type: 'hackernews', config: { query: 'kubernetes', minPoints: 120 } }, plugin: HackerNewsSource, id: 'hackernews:kubernetes' },
  { entry: { type: 'reddit', config: { subreddit: 'programming', sort: 'top', minUpvotes: 300 } }, plugin: RedditSource, id: 'reddit:programming' },
  { entry: { type: 'devto', config: { tag: 'devops', minReactions: 25 } }, plugin: DevToSource, id: 'devto:devops' },
  { entry: { type: 'github-trending', config: { language: 'rust', since: 'weekly', minStars: 200 } }, plugin: GitHubTrendingSource, id: 'github-trending:rust' },
  { entry: { type: 'html', config: { id: 'example-html', name: 'Example HTML', url: 'https://example.test/blog' } }, plugin: HTMLScraperSource, id: 'example-html' },
  {
    entry: { type: 'json', config: { id: 'example-json', name: 'Example JSON', url: 'https://example.test/api', fields: { title: 'headline', url: 'link' } } },
    plugin: JSONAPISource,
    id: 'example-json',
  },
];

test('the preset map covers every preset exported by src/presets', () => {
  const exported = Object.entries(presets).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort();
  assert.deepEqual([...PRESET_NAMES].sort(), exported);
  for (const name of PRESET_NAMES) {
    assert.equal(PRESET_FACTORIES[name], presets[name], name);
    const sources = PRESET_FACTORIES[name]();
    assert.ok(sources.length > 0 && sources.every(source => source instanceof SourcePlugin), name);
  }
});

test('every typed source normalizes and builds its plugin', () => {
  for (const { entry, plugin, id } of typedSources) {
    const [normalized] = normalizeValid([entry]);
    assert.deepEqual(normalized, { type: entry.type, enabled: true, config: entry.config }, entry.type);
    const [built] = createSourcePlugins([normalized]);
    assert.ok(built instanceof plugin, entry.type);
    assert.equal(built.id, id, entry.type);
  }
});

test('typed sources keep plugin defaults for omitted optional settings', () => {
  const [hackerNews, devTo, github] = createSourcePlugins(normalizeValid([
    { type: 'hackernews' },
    { type: 'devto', config: {} },
    { type: 'github-trending', config: {} },
  ]));
  assert.equal(hackerNews.sourceKey, new HackerNewsSource().sourceKey);
  assert.equal(devTo.sourceKey, new DevToSource().sourceKey);
  assert.equal(github.sourceKey, new GitHubTrendingSource().sourceKey);
});

test('typed source configs are validated per type', () => {
  assert.deepEqual(normalize([
    { type: 'rss', config: { name: 'No id', feedUrl: 'file:///etc/passwd' } },
    { type: 'reddit', config: { subreddit: 'r/programming' } },
    { type: 'reddit', config: { subreddit: 'a/../b' } },
    { type: 'devto', config: { tag: 'DevOps' } },
    { type: 'github-trending', config: { language: 'jupyter notebook', since: 'monthly' } },
    { type: 'hackernews', config: { filter: 'show_hn', minPoints: -1 } },
    { type: 'html', config: { id: 'page', name: 'Page' } },
  ]).issues, [
    'sources.0.config.id:required',
    'sources.0.config.feedUrl:invalid_url',
    'sources.1.config.subreddit:invalid_format',
    'sources.2.config.subreddit:invalid_format',
    'sources.3.config.tag:invalid_format',
    'sources.4.config.language:invalid_format',
    'sources.4.config.since:invalid_value',
    'sources.5.config.filter:invalid_value',
    'sources.5.config.minPoints:out_of_range',
    'sources.6.config.url:required',
  ]);
});

test('source configs cannot carry secrets or unsupported plugin options', () => {
  assert.deepEqual(normalize([
    { type: 'github-trending', config: { token: 'ghp_fake' } },
    { type: 'json', config: { id: 'api', name: 'API', url: 'https://example.test/api', headers: { authorization: 'Bearer fake' }, fields: { title: 't', url: 'u' } } },
    { type: 'html', config: { id: 'page', name: 'Page', url: 'https://example.test', selectors: {} } },
    { type: 'preset', preset: 'bigTechBlogs', config: {} },
  ]).issues, [
    'sources.0.config.token:unknown_field',
    'sources.1.config.headers:unknown_field',
    'sources.2.config.selectors:unknown_field',
    'sources.3.config:unknown_field',
  ]);
});

test('JSON sources need a title and URL mapping with safe paths', () => {
  assert.deepEqual(normalize([
    { type: 'json', config: { id: 'api', name: 'API', url: 'https://example.test/api' } },
    { type: 'json', config: { id: 'api-2', name: 'API', url: 'https://example.test/api', itemsPath: 'data.__proto__', fields: { title: 'a..b', content: 'x y' } } },
  ]).issues, [
    'sources.0.config.fields:required',
    'sources.1.config.itemsPath:invalid_format',
    'sources.1.config.fields.title:invalid_format',
    'sources.1.config.fields.url:required',
    'sources.1.config.fields.content:invalid_format',
  ]);
});

test('entry shape, type, preset name, and list size are validated', () => {
  assert.deepEqual(normalize(undefined).issues, ['sources:required']);
  assert.deepEqual(normalize([]).issues, ['sources:required']);
  assert.deepEqual(normalize({ type: 'preset' }).issues, ['sources:invalid_type']);
  assert.deepEqual(
    normalize(Array.from({ length: MAX_SOURCE_ENTRIES + 1 }, () => ({ type: 'hackernews' }))).issues,
    ['sources:too_many'],
  );
  assert.deepEqual(normalize([
    'rss',
    { type: 'atom' },
    { type: 'preset', preset: 'everything' },
    { type: 'preset', preset: 'bigTechBlogs', enabled: 'no' },
  ]).issues, [
    'sources.0:invalid_type',
    'sources.1.type:invalid_value',
    'sources.2.preset:invalid_value',
    'sources.3.enabled:invalid_type',
  ]);
});

test('overlapping presets are allowed and their shared sources are built once', () => {
  const entries = normalizeValid([
    { type: 'preset', preset: 'aiMLBlogs' },
    { type: 'preset', preset: 'aiNewsSources' },
  ]);
  const ids = createSourcePlugins(entries).map(source => source.id);
  const expected = [...new Set([...presets.aiMLBlogs(), ...presets.aiNewsSources()].map(source => source.id))];
  assert.deepEqual(ids, expected);
  assert.ok(ids.length < presets.aiMLBlogs().length + presets.aiNewsSources().length);
});

test('duplicate entries and different sources sharing an id are reported', () => {
  const result = normalize([
    { type: 'preset', preset: 'aiNewsSources' },
    { type: 'rss', config: { id: 'openai', name: 'Another OpenAI feed', feedUrl: 'https://example.test/openai.xml' } },
    { type: 'preset', preset: 'aiNewsSources' },
    { type: 'hackernews', config: { query: 'rust' } },
    { type: 'hackernews', config: { query: 'rust' } },
  ]);
  assert.deepEqual(result.issues, [
    'sources.2:duplicate',
    'sources.4:duplicate',
    'sources.1:duplicate_source_id',
  ]);
  assert.match(result.details.at(-1).message, /"openai"/);
  assert.throws(
    () => createSourcePlugins([
      { type: 'preset', preset: 'aiNewsSources', enabled: true },
      { type: 'rss', enabled: true, config: { id: 'openai', name: 'Another', feedUrl: 'https://example.test/openai.xml' } },
    ]),
    /Different sources share the same source id: openai/,
  );
});

test('JSON sources map API responses into validated articles', async t => {
  const [source] = createSourcePlugins(normalizeValid([{
    type: 'json',
    config: {
      id: 'release-feed',
      name: 'Release Feed',
      url: 'https://example.test/releases',
      category: 'Releases',
      itemsPath: 'data.items',
      fields: { title: 'headline', url: 'links.html', id: 'id', content: 'summary', publishedAt: 'published', author: 'by.name' },
    },
  }]));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: {
      items: [
        { id: 7, headline: '<b>Kubernetes 1.40</b> released', links: { html: 'https://example.test/k8s' }, summary: '<p>Sidecars are GA.</p>', published: 1_791_028_800, by: { name: 'Release Team' } },
        { headline: 'PostgreSQL 18', links: { html: 'https://example.test/pg' }, published: '2026-10-02T08:00:00Z' },
        { headline: 'Missing link' },
        { links: { html: 'https://example.test/untitled' } },
        'not an object',
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  const { articles, diagnostic } = await source.fetchWithDiagnostics({ limit: 10 });

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(diagnostic.status, 'success');
  assert.deepEqual(articles, [
    {
      id: '7',
      title: 'Kubernetes 1.40 released',
      url: 'https://example.test/k8s',
      content: 'Sidecars are GA.',
      source: 'Release Feed',
      category: 'Releases',
      author: 'Release Team',
      publishedAt: new Date('2026-10-03T12:00:00.000Z'),
      meta: { icon: '🔌' },
    },
    {
      id: 'https://example.test/pg',
      title: 'PostgreSQL 18',
      url: 'https://example.test/pg',
      content: '',
      source: 'Release Feed',
      category: 'Releases',
      publishedAt: new Date('2026-10-02T08:00:00.000Z'),
      meta: { icon: '🔌' },
    },
  ]);
});

test('a JSON response without the configured item list is an invalid source shape', async t => {
  const [source] = createSourcePlugins(normalizeValid([{
    type: 'json',
    config: { id: 'release-feed', name: 'Release Feed', url: 'https://example.test/releases', itemsPath: 'data.items', fields: { title: 'title', url: 'url' } },
  }]));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { items: 'none' } }), { status: 200 }));

  const { articles, diagnostic } = await source.fetchWithDiagnostics({ limit: 10 });
  assert.deepEqual(articles, []);
  assert.equal(diagnostic.status, 'failed');
  assert.equal(diagnostic.failureType, 'invalid_shape');
});
