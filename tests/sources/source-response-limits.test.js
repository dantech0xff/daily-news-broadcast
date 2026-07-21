import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { DevToSource, JSONAPISource } from '../../src/sources/devto.js';
import { HTMLScraperSource } from '../../src/sources/html-scraper.js';
import { enrichMissingImages } from '../../src/sources/og-image.js';
import { RSSSource } from '../../src/sources/rss.js';
import { MAX_SOURCE_RESPONSE_BODY_BYTES } from '../../src/sources/source-result.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('declared oversized JSON responses are canceled before parsing', async () => {
  const tracked = trackedResponse({
    chunks: ['[]'],
    contentLength: MAX_SOURCE_RESPONSE_BODY_BYTES + 1,
  });
  const source = new JSONAPISource({
    id: 'bounded-json',
    name: 'Bounded JSON',
    url: 'https://example.test/api?token=private-value',
    transform: data => data,
  });
  globalThis.fetch = async () => tracked.response;

  let reported;
  const result = await source.fetchWithDiagnostics({
    reportError: diagnostic => { reported = diagnostic; },
  });

  assertOversizedDiagnostic(result.diagnostic);
  assert.deepEqual(reported, result.diagnostic);
  assert.deepEqual(result.articles, []);
  assert.equal(tracked.wasCancelled(), true);
  assert.doesNotMatch(JSON.stringify(reported), /private-value|token/i);
});

test('chunked oversized JSON responses stop at the byte cap and cancel the stream', async () => {
  const tracked = trackedResponse({
    chunks: [
      new Uint8Array(MAX_SOURCE_RESPONSE_BODY_BYTES - 1),
      new Uint8Array(2),
    ],
  });
  const source = new DevToSource();
  globalThis.fetch = async () => tracked.response;

  const result = await source.fetchWithDiagnostics();

  assertOversizedDiagnostic(result.diagnostic);
  assert.deepEqual(result.articles, []);
  assert.equal(tracked.wasCancelled(), true);
  assert.equal(tracked.chunksRead(), 2);
});

test('declared oversized text responses are canceled before parsing', async () => {
  const tracked = trackedResponse({
    chunks: ['<rss><channel></channel></rss>'],
    contentLength: MAX_SOURCE_RESPONSE_BODY_BYTES + 1,
  });
  const source = new RSSSource({
    id: 'bounded-rss',
    name: 'Bounded RSS',
    feedUrl: 'https://example.test/feed.xml',
  });
  globalThis.fetch = async () => tracked.response;

  const result = await source.fetchWithDiagnostics();

  assertOversizedDiagnostic(result.diagnostic);
  assert.deepEqual(result.articles, []);
  assert.equal(tracked.wasCancelled(), true);
  assert.equal(tracked.chunksRead(), 0);
});

test('chunked oversized text responses stop at the byte cap and cancel the stream', async () => {
  const tracked = trackedResponse({
    chunks: [
      new Uint8Array(MAX_SOURCE_RESPONSE_BODY_BYTES),
      new Uint8Array([60]),
    ],
  });
  const source = new HTMLScraperSource({
    id: 'bounded-html',
    name: 'Bounded HTML',
    url: 'https://example.test/blog',
  });
  globalThis.fetch = async () => tracked.response;

  const result = await source.fetchWithDiagnostics();

  assertOversizedDiagnostic(result.diagnostic);
  assert.deepEqual(result.articles, []);
  assert.equal(tracked.wasCancelled(), true);
  assert.equal(tracked.chunksRead(), 2);
});

test('OG image enrichment rejects declared oversized article pages', async () => {
  const tracked = trackedResponse({
    chunks: ['<meta property="og:image" content="https://example.test/image.png">'],
    contentLength: 50 * 1024 + 1,
  });
  const article = { url: 'https://example.test/article' };
  globalThis.fetch = async () => tracked.response;

  await enrichMissingImages([article]);

  assert.equal(article.imageUrl, undefined);
  assert.equal(tracked.wasCancelled(), true);
  assert.equal(tracked.chunksRead(), 0);
});

test('RSS keeps external abort forwarding active while reading the response body', async () => {
  const readStarted = deferred();
  let forwardedSignal;
  let streamCancelled = false;
  globalThis.fetch = async (_url, init) => {
    forwardedSignal = init.signal;
    return stalledResponse(init.signal, {
      onRead: () => readStarted.resolve(),
      onCancel: () => { streamCancelled = true; },
    });
  };
  const source = new RSSSource({
    id: 'abortable-rss',
    name: 'Abortable RSS',
    feedUrl: 'https://example.test/stalled-feed.xml',
  });
  const controller = new AbortController();

  const pending = source.fetchWithDiagnostics({ signal: controller.signal });
  await readStarted.promise;
  controller.abort(new Error('caller stopped the source'));
  const result = await withWatchdog(pending);

  assert.deepEqual(result.articles, []);
  assert.deepEqual(result.diagnostic, {
    status: 'failed',
    articleCount: 0,
    failureType: 'transport',
  });
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(streamCancelled, true);
});

function assertOversizedDiagnostic(diagnostic) {
  assert.deepEqual(diagnostic, {
    status: 'failed',
    articleCount: 0,
    failureType: 'response_too_large',
  });
}

function trackedResponse({ chunks, contentLength }) {
  const encoder = new TextEncoder();
  const pendingChunks = chunks.map(chunk => (
    typeof chunk === 'string' ? encoder.encode(chunk) : chunk
  ));
  let cancelled = false;
  let chunksRead = 0;
  const cancel = async () => { cancelled = true; };
  const body = {
    getReader() {
      return {
        async read() {
          const chunk = pendingChunks.shift();
          if (!chunk) return { done: true, value: undefined };
          chunksRead += 1;
          return { done: false, value: chunk };
        },
        cancel,
        releaseLock() {},
      };
    },
    cancel,
  };
  const headers = new Headers(contentLength === undefined
    ? undefined
    : { 'Content-Length': String(contentLength) });
  return {
    response: {
      ok: true,
      status: 200,
      headers,
      body,
    },
    wasCancelled: () => cancelled,
    chunksRead: () => chunksRead,
  };
}

function stalledResponse(signal, { onRead, onCancel }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          read() {
            onRead();
            return new Promise((resolve, reject) => {
              const rejectAbort = () => reject(signal.reason || new Error('aborted'));
              if (signal.aborted) rejectAbort();
              else signal.addEventListener('abort', rejectAbort, { once: true });
            });
          },
          async cancel() { onCancel(); },
          releaseLock() {},
        };
      },
      async cancel() { onCancel(); },
    },
  };
}

async function withWatchdog(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('source did not settle after abort')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
