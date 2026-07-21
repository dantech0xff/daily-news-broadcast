import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeAI } from '../../src/ai/claude.js';
import { OpenAICompatibleAI } from '../../src/ai/openai-compat.js';

const PRIVATE_ARTICLE_TEXT = 'article-body-must-never-enter-an-error';
const PRIVATE_PROVIDER_TEXT = 'provider-body-must-never-enter-an-error';
const PRIVATE_PROMPT_TEXT = 'prompt-must-never-enter-an-error';
const article = {
  id: 'security-test',
  title: 'Provider response security',
  url: 'https://example.test/security',
  content: PRIVATE_ARTICLE_TEXT,
  source: 'Security Test',
};

const providers = [
  {
    name: 'Claude',
    provider: 'claude',
    status: 429,
    create: fetch => new ClaudeAI({ apiKey: 'test-key', fetch }),
  },
  {
    name: 'OpenAI-compatible',
    provider: 'openai-compatible',
    status: 401,
    create: fetch => new OpenAICompatibleAI({ apiKey: 'test-key', fetch }),
  },
];

for (const scenario of providers) {
  test(`${scenario.name} rejects HTTP errors without reading or exposing the provider body`, async () => {
    const tracked = trackedResponse({
      ok: false,
      status: scenario.status,
      chunks: [new TextEncoder().encode(PRIVATE_PROVIDER_TEXT)],
    });
    const ai = scenario.create(async () => tracked.response);

    const error = await captureError(ai.summarize([article], {
      _rawUserPrompt: PRIVATE_PROMPT_TEXT,
    }));

    assert.equal(error.name, 'AIProviderError');
    assert.equal(error.code, 'provider_http_error');
    assert.equal(error.status, scenario.status);
    assert.equal(error.provider, scenario.provider);
    assert.equal(tracked.state.reads, 0);
    assert.equal(tracked.state.cancelled, true);
    assertPrivateTextAbsent(error);
  });
}

test('Claude cancels an oversized success stream at the byte boundary', async () => {
  const tracked = trackedResponse({
    ok: true,
    status: 200,
    chunks: [
      new TextEncoder().encode(PRIVATE_PROVIDER_TEXT.repeat(8_000)),
      new TextEncoder().encode('this chunk must never be read'),
    ],
  });
  const ai = new ClaudeAI({ apiKey: 'test-key', fetch: async () => tracked.response });

  const error = await captureError(ai.summarize([article]));

  assert.equal(error.code, 'provider_response_too_large');
  assert.equal(error.status, 200);
  assert.equal(tracked.state.reads, 1);
  assert.equal(tracked.state.cancelled, true);
  assert.equal(tracked.state.released, true);
  assertPrivateTextAbsent(error);
});

test('OpenAI-compatible replaces malformed response details with a fixed classification', async () => {
  const ai = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async () => new Response(`{"choices":["${PRIVATE_PROVIDER_TEXT}`, { status: 200 }),
  });

  const error = await captureError(ai.summarize([article], {
    _rawUserPrompt: PRIVATE_PROMPT_TEXT,
  }));

  assert.equal(error.code, 'provider_invalid_response');
  assert.equal(error.status, 200);
  assertPrivateTextAbsent(error);
});

test('AI transport exceptions are reduced to fixed network and abort codes', async () => {
  const networkAI = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async () => { throw new Error(`${PRIVATE_PROVIDER_TEXT} at a private URL`); },
  });
  const networkError = await captureError(networkAI.summarize([article]));
  assert.equal(networkError.code, 'provider_network_error');
  assert.equal(networkError.status, null);
  assertPrivateTextAbsent(networkError);

  const controller = new AbortController();
  controller.abort(new Error(PRIVATE_PROMPT_TEXT));
  const abortedAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async () => { throw controller.signal.reason; },
  });
  const abortError = await captureError(abortedAI.summarize([article], {
    signal: controller.signal,
  }));
  assert.equal(abortError.code, 'provider_aborted');
  assert.equal(abortError.status, null);
  assertPrivateTextAbsent(abortError);
});

for (const scenario of providers) {
  test(`${scenario.name} aborts a success body that stalls after response headers`, async () => {
    const readStarted = deferred();
    const state = { cancelled: false, released: false };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() { readStarted.resolve(); return new Promise(() => {}); },
            async cancel() { state.cancelled = true; },
            releaseLock() { state.released = true; },
          };
        },
      },
    };
    const controller = new AbortController();
    const ai = scenario.create(async () => response);
    const pending = ai.summarize([article], { signal: controller.signal });
    await readStarted.promise;
    controller.abort(new Error(PRIVATE_PROMPT_TEXT));
    const error = await captureError(pending);

    assert.equal(error.code, 'provider_aborted');
    assert.equal(error.status, 200);
    assert.equal(state.cancelled, true);
    assert.equal(state.released, true);
    assertPrivateTextAbsent(error);
  });
}

test('bounded AI readers preserve valid provider success envelopes', async () => {
  const claude = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Claude digest' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    }), { status: 200 }),
  });
  assert.deepEqual(await claude.summarize([article]), {
    text: 'Claude digest',
    model: 'claude-sonnet-4-20250514',
    usage: { input: 11, output: 7 },
  });

  const openAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OpenAI digest' } }],
      model: 'provider-model',
      usage: { prompt_tokens: 13, completion_tokens: 5 },
    }), { status: 200 }),
  });
  assert.deepEqual(await openAI.summarize([article]), {
    text: 'OpenAI digest',
    model: 'provider-model',
    usage: { input: 13, output: 5 },
  });
});

function trackedResponse({ ok, status, chunks }) {
  const state = { reads: 0, cancelled: false, released: false };
  let index = 0;
  const reader = {
    async read() {
      state.reads += 1;
      if (index >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[index++] };
    },
    async cancel() { state.cancelled = true; },
    releaseLock() { state.released = true; },
  };
  const body = {
    getReader() { return reader; },
    async cancel() { state.cancelled = true; },
  };
  return {
    response: { ok, status, headers: new Headers(), body },
    state,
  };
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected provider call to reject');
}

function assertPrivateTextAbsent(error) {
  const serialized = JSON.stringify({
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.status,
    provider: error?.provider,
    stack: error?.stack,
  });
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_ARTICLE_TEXT));
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_PROVIDER_TEXT));
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_PROMPT_TEXT));
  assert.ok(error.message.length < 128, 'provider error message must remain bounded');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
