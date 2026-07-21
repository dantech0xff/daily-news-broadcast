import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { DevToSource, JSONAPISource } from '../../src/sources/devto.js';
import { GitHubTrendingSource } from '../../src/sources/github-trending.js';
import { HackerNewsSource } from '../../src/sources/hackernews.js';
import { HTMLScraperSource } from '../../src/sources/html-scraper.js';
import { RedditSource } from '../../src/sources/reddit.js';
import { RSSSource } from '../../src/sources/rss.js';
import { SOURCE_FETCH_DIAGNOSTIC_CAPABILITY } from '../../src/sources/source-result.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('all built-in sources advertise bounded diagnostics without changing fetch()', () => {
  const sources = [
    new RSSSource({ id: 'rss', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
    new HTMLScraperSource({ id: 'html', name: 'HTML', url: 'https://example.test/blog' }),
    new HackerNewsSource(),
    new RedditSource({ subreddit: 'programming' }),
    new DevToSource(),
    new JSONAPISource({
      id: 'json',
      name: 'JSON',
      url: 'https://example.test/api',
      transform: () => [],
    }),
    new GitHubTrendingSource(),
  ];

  for (const source of sources) {
    assert.equal(source.diagnosticCapability, SOURCE_FETCH_DIAGNOSTIC_CAPABILITY);
    assert.deepEqual(source.lastFetchDiagnostic, { status: 'unknown', articleCount: 0 });
    assert.equal(typeof source.fetch, 'function');
    assert.equal(typeof source.fetchWithDiagnostics, 'function');
  }
});

test('recognized empty source payloads are proven empty', async (t) => {
  const cases = [
    {
      name: 'RSS',
      source: new RSSSource({ id: 'rss', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>'),
    },
    {
      name: 'Hacker News',
      source: new HackerNewsSource(),
      response: jsonResponse({ hits: [] }),
    },
    {
      name: 'Reddit',
      source: new RedditSource({ subreddit: 'programming' }),
      response: jsonResponse({ data: { children: [] } }),
    },
    {
      name: 'Dev.to',
      source: new DevToSource(),
      response: jsonResponse([]),
    },
    {
      name: 'GitHub',
      source: new GitHubTrendingSource(),
      response: jsonResponse({ items: [] }),
    },
    {
      name: 'JSON API',
      source: new JSONAPISource({
        id: 'json',
        name: 'JSON',
        url: 'https://example.test/api',
        transform: data => data,
      }),
      response: jsonResponse([]),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      globalThis.fetch = async () => entry.response;
      let reported = false;
      const result = await entry.source.fetchWithDiagnostics({
        reportError: () => { reported = true; },
      });

      assert.deepEqual(result.articles, []);
      assert.deepEqual(result.diagnostic, { status: 'empty', articleCount: 0 });
      assert.equal(reported, false);
    });
  }
});

test('structurally valid but unsupported HTML is unknown, not empty', async () => {
  const source = new HTMLScraperSource({
    id: 'html',
    name: 'HTML',
    url: 'https://example.test/blog',
  });
  globalThis.fetch = async () => textResponse('<!doctype html><html><body><main>Archive</main></body></html>');

  let reported;
  const result = await source.fetchWithDiagnostics({
    reportError: diagnostic => { reported = diagnostic; },
  });

  assert.deepEqual(result.articles, []);
  assert.deepEqual(result.diagnostic, {
    status: 'unknown',
    articleCount: 0,
    failureType: 'unsupported_shape',
  });
  assert.deepEqual(reported, result.diagnostic);
});

test('malformed HTTP 200 payloads are failures, never healthy empty results', async (t) => {
  const cases = [
    {
      name: 'RSS',
      source: new RSSSource({ id: 'rss', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<rss><channel><item><title>Broken</title></channel></rss>'),
      failureType: 'parse',
    },
    {
      name: 'RSS reversed item tags',
      source: new RSSSource({ id: 'rss-order', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<rss><channel></item><item></channel></rss>'),
      failureType: 'parse',
    },
    {
      name: 'RSS malformed unrelated element',
      source: new RSSSource({ id: 'rss-whole-document', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<rss><channel><foo></channel></rss>'),
      failureType: 'parse',
    },
    {
      name: 'RSS text outside root',
      source: new RSSSource({ id: 'rss-outside-text', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('garbage<rss><channel></channel></rss>'),
      failureType: 'parse',
    },
    {
      name: 'RSS nested root',
      source: new RSSSource({ id: 'rss-nested-root', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<wrapper><rss><channel></channel></rss></wrapper>'),
      failureType: 'invalid_shape',
    },
    {
      name: 'RSS unescaped entity',
      source: new RSSSource({ id: 'rss-entity', name: 'RSS', feedUrl: 'https://example.test/feed.xml' }),
      response: textResponse('<rss><channel><title>A & B</title></channel></rss>'),
      failureType: 'parse',
    },
    {
      name: 'HTML',
      source: new HTMLScraperSource({ id: 'html', name: 'HTML', url: 'https://example.test/blog' }),
      response: textResponse('{"not":"html"}'),
      failureType: 'invalid_shape',
    },
    {
      name: 'Hacker News',
      source: new HackerNewsSource(),
      response: jsonResponse({}),
      failureType: 'invalid_shape',
    },
    {
      name: 'Hacker News invalid filtered record',
      source: new HackerNewsSource({ minPoints: 50 }),
      response: jsonResponse({
        hits: [{ objectID: ' ', title: 'Broken', points: 0, created_at: 'not-a-date' }],
      }),
      failureType: 'invalid_shape',
    },
    {
      name: 'Reddit',
      source: new RedditSource({ subreddit: 'programming' }),
      response: jsonResponse({ data: {} }),
      failureType: 'invalid_shape',
    },
    {
      name: 'Reddit image metadata',
      source: new RedditSource({ subreddit: 'programming' }),
      response: jsonResponse({
        data: {
          children: [{
            data: {
              id: 'abc',
              title: 'Malformed image metadata',
              url: 'https://example.test/reddit-story',
              permalink: '/r/programming/comments/abc/malformed/',
              selftext: '',
              ups: 120,
              num_comments: 30,
              created_utc: 1784541600,
              thumbnail: 123,
            },
          }],
        },
      }),
      failureType: 'invalid_shape',
    },
    {
      name: 'Reddit invalid filtered flag',
      source: new RedditSource({ subreddit: 'programming' }),
      response: jsonResponse({
        data: {
          children: [{
            data: {
              id: 'abc',
              title: 'Malformed stickied flag',
              url: 'https://example.test/reddit-story',
              permalink: '/r/programming/comments/abc/malformed/',
              selftext: '',
              ups: 120,
              num_comments: 30,
              created_utc: 1784541600,
              stickied: 'false',
            },
          }],
        },
      }),
      failureType: 'invalid_shape',
    },
    {
      name: 'Dev.to',
      source: new DevToSource(),
      response: jsonResponse({ articles: [] }),
      failureType: 'invalid_shape',
    },
    {
      name: 'Dev.to invalid filtered date',
      source: new DevToSource({ minReactions: 20 }),
      response: jsonResponse([{
        id: 1,
        title: 'Broken date',
        url: 'https://example.test/devto-story',
        public_reactions_count: 0,
        published_at: 'not-a-date',
      }]),
      failureType: 'invalid_shape',
    },
    {
      name: 'GitHub',
      source: new GitHubTrendingSource(),
      response: jsonResponse({ items: {} }),
      failureType: 'invalid_shape',
    },
    {
      name: 'JSON API transform',
      source: new JSONAPISource({
        id: 'json',
        name: 'JSON',
        url: 'https://example.test/api',
        transform: () => ({ articles: [] }),
      }),
      response: jsonResponse({}),
      failureType: 'invalid_shape',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      globalThis.fetch = async () => entry.response;
      const result = await entry.source.fetchWithDiagnostics();

      assert.deepEqual(result.articles, []);
      assert.equal(result.diagnostic.status, 'failed');
      assert.equal(result.diagnostic.failureType, entry.failureType);
      assert.equal(result.diagnostic.articleCount, 0);
    });
  }
});

test('JSON parse failures have a dedicated sanitized classification', async () => {
  const source = new DevToSource();
  globalThis.fetch = async () => textResponse('{"secret response fragment"');

  const result = await source.fetchWithDiagnostics();

  assert.deepEqual(result.diagnostic, {
    status: 'failed',
    articleCount: 0,
    failureType: 'parse',
  });
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /secret|fragment/i);
});

test('HTTP and transport diagnostics are sanitized and reportable', async (t) => {
  await t.test('HTTP failure', async () => {
    const source = new JSONAPISource({
      id: 'private-json',
      name: 'Private JSON',
      url: 'https://example.test/api?access_token=top-secret',
      headers: { Authorization: 'Bearer top-secret' },
      transform: data => data,
    });
    globalThis.fetch = async () => jsonResponse({}, 503);

    let reported;
    const articles = await source.fetch({ reportError: diagnostic => { reported = diagnostic; } });

    assert.deepEqual(articles, []);
    assert.deepEqual(source.lastFetchDiagnostic, {
      status: 'failed',
      articleCount: 0,
      failureType: 'http',
      httpStatus: 503,
    });
    assert.deepEqual(reported, source.lastFetchDiagnostic);
    assert.doesNotMatch(JSON.stringify(reported), /top-secret|access_token|authorization/i);
  });

  await t.test('transport failure', async () => {
    const source = new RedditSource({ subreddit: 'programming' });
    globalThis.fetch = async () => { throw new Error('socket failed with private-token'); };

    const result = await source.fetchWithDiagnostics();

    assert.deepEqual(result.articles, []);
    assert.deepEqual(result.diagnostic, {
      status: 'failed',
      articleCount: 0,
      failureType: 'transport',
    });
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /private-token|socket/i);
  });
});

test('successful source payloads produce structurally valid articles', async (t) => {
  await t.test('RSS', async () => {
    const source = new RSSSource({ id: 'rss', name: 'RSS', feedUrl: 'https://example.test/feed.xml' });
    globalThis.fetch = async () => textResponse(`
      <rss><channel><item>
        <title>Reliable delivery</title>
        <link>https://example.test/reliable-delivery</link>
        <description>How to deliver safely.</description>
        <media:thumbnail url="https://example.test/image.png" />
        <pubDate>Mon, 20 Jul 2026 10:00:00 GMT</pubDate>
      </item></channel></rss>
    `);

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('HTML', async () => {
    const source = new HTMLScraperSource({ id: 'html', name: 'HTML', url: 'https://example.test/blog' });
    globalThis.fetch = async () => textResponse(`
      <html><body><article>
        <a href="/post/reliable-delivery"><h2>Reliable delivery patterns</h2></a>
        <p>Persist acknowledgements before continuing.</p>
      </article></body></html>
    `);

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('Hacker News', async () => {
    const source = new HackerNewsSource({ minPoints: 50 });
    globalThis.fetch = sequenceFetch([
      jsonResponse({
        hits: [{
          objectID: '42',
          title: 'Reliable delivery patterns',
          url: 'https://example.test/hn-story',
          points: 120,
          num_comments: 30,
          created_at: '2026-07-20T10:00:00.000Z',
        }],
      }),
      jsonResponse({}, 404),
    ]);

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('Reddit', async () => {
    const source = new RedditSource({ subreddit: 'programming', minUpvotes: 50 });
    globalThis.fetch = async () => jsonResponse({
      data: {
        children: [{
          data: {
            id: 'abc',
            title: 'Reliable delivery patterns',
            url: 'https://example.test/reddit-story',
            permalink: '/r/programming/comments/abc/reliable_delivery/',
            selftext: '',
            ups: 120,
            num_comments: 30,
            created_utc: 1784541600,
            stickied: false,
          },
        }],
      },
    });

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('Dev.to', async () => {
    const source = new DevToSource({ minReactions: 20 });
    globalThis.fetch = async () => jsonResponse([{
      id: 7,
      title: 'Reliable delivery patterns',
      url: 'https://example.test/devto-story',
      description: 'Persist acknowledgements before continuing.',
      public_reactions_count: 45,
      comments_count: 4,
      reading_time_minutes: 6,
      tag_list: ['reliability'],
      user: { name: 'Editor' },
      published_at: '2026-07-20T10:00:00.000Z',
    }]);

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('GitHub', async () => {
    const source = new GitHubTrendingSource();
    globalThis.fetch = sequenceFetch([
      jsonResponse({
        items: [{
          full_name: 'example/reliable-delivery',
          html_url: 'https://github.com/example/reliable-delivery',
          description: 'Crash-safe delivery example',
          stargazers_count: 500,
          forks_count: 25,
          language: 'JavaScript',
          topics: ['reliability'],
          owner: { login: 'example' },
          pushed_at: '2026-07-20T10:00:00.000Z',
        }],
      }),
      jsonResponse({}, 404),
    ]);

    const result = await source.fetchWithDiagnostics();
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.diagnostic, { status: 'success', articleCount: 1 });
  });

  await t.test('JSON API', async () => {
    const source = new JSONAPISource({
      id: 'json',
      name: 'JSON',
      url: 'https://example.test/api',
      transform: data => data.map(item => ({ ...item, publishedAt: new Date(item.publishedAt) })),
    });
    globalThis.fetch = async () => jsonResponse([{
      id: 'json:1',
      title: 'Reliable delivery patterns',
      url: 'https://example.test/json-story',
      content: 'Persist acknowledgements before continuing.',
      source: 'JSON',
      publishedAt: '2026-07-20T10:00:00.000Z',
    }]);

    const articles = await source.fetch();
    assert.equal(Array.isArray(articles), true);
    assert.equal(articles.length, 1);
    assert.deepEqual(source.lastFetchDiagnostic, { status: 'success', articleCount: 1 });
  });
});

test('invalid transformed articles fail structural validation', async () => {
  const source = new JSONAPISource({
    id: 'json',
    name: 'JSON',
    url: 'https://example.test/api',
    transform: () => [{ id: 'missing-required-fields' }],
  });
  globalThis.fetch = async () => jsonResponse({});

  const result = await source.fetchWithDiagnostics();

  assert.deepEqual(result.articles, []);
  assert.deepEqual(result.diagnostic, {
    status: 'failed',
    articleCount: 0,
    failureType: 'invalid_shape',
  });
});

test('structural validation covers the complete transformed array before limiting', async () => {
  const source = new JSONAPISource({
    id: 'json',
    name: 'JSON',
    url: 'https://example.test/api',
    transform: () => [
      {
        id: 'json:valid',
        title: 'Valid first article',
        url: 'https://example.test/valid',
        content: '',
        source: 'JSON',
      },
      { id: 'json:invalid' },
    ],
  });
  globalThis.fetch = async () => jsonResponse({});

  const result = await source.fetchWithDiagnostics({ limit: 1 });

  assert.deepEqual(result.articles, []);
  assert.equal(result.diagnostic.failureType, 'invalid_shape');
});

test('concurrent fetchWithDiagnostics calls retain their own diagnostic', async () => {
  const source = new JSONAPISource({
    id: 'json',
    name: 'JSON',
    url: 'https://example.test/api',
    transform: data => data,
  });
  globalThis.fetch = sequenceFetch([
    jsonResponse({}, 503),
    jsonResponse([]),
  ]);

  const reportStarted = deferred();
  const releaseReport = deferred();
  const failedFetch = source.fetchWithDiagnostics({
    reportError: async () => {
      reportStarted.resolve();
      await releaseReport.promise;
    },
  });

  await reportStarted.promise;
  const emptyFetch = await source.fetchWithDiagnostics();
  releaseReport.resolve();
  const failedResult = await failedFetch;

  assert.deepEqual(emptyFetch.diagnostic, { status: 'empty', articleCount: 0 });
  assert.deepEqual(failedResult.diagnostic, {
    status: 'failed',
    articleCount: 0,
    failureType: 'http',
    httpStatus: 503,
  });
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function sequenceFetch(responses) {
  let index = 0;
  return async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('Unexpected fetch');
    return response;
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
