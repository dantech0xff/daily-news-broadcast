import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DiscordOutput,
  EmailOutput,
  MarkdownFileOutput,
  SlackOutput,
  WebhookOutput,
} from '../../src/outputs/channels.js';
import { FacebookOutput } from '../../src/outputs/facebook.js';
import { ThreadsOutput } from '../../src/outputs/threads.js';
import { TelegramOutput } from '../../src/outputs/telegram.js';
import { XOutput } from '../../src/outputs/x.js';
import {
  assertCanonicalResult,
  jsonResponse,
  noDelay,
  sequenceFetch,
  textResponse,
} from './test-helpers.js';

test('built-in outputs expose stable redacted destination delivery keys', () => {
  const cases = [
    [new TelegramOutput({ botToken: 'token', chatId: 'chat-secret' }), 'chat-secret'],
    [new SlackOutput({ webhookUrl: 'https://hooks.slack.test/raw-secret', channel: 'private-channel' }), 'raw-secret'],
    [new DiscordOutput({ webhookUrl: 'https://discord.test/raw-secret' }), 'raw-secret'],
    [new WebhookOutput({ id: 'custom', name: 'Custom', url: 'https://private.test/raw-secret' }), 'raw-secret'],
    [new EmailOutput({ provider: 'resend', apiKey: 'token', from: 'from@test.dev', to: 'private@test.dev' }), 'private@test.dev'],
    [new MarkdownFileOutput({ outputDir: '/private/news', filenamePattern: 'secret-{date}.md' }), '/private/news'],
    [new XOutput({ accessToken: 'token', channelId: 'x-private', destinationId: 'x-account-private' }), 'x-account-private'],
    [new ThreadsOutput({ accessToken: 'token', userId: 'threads-private', channelId: 'threads-channel' }), 'threads-private'],
    [new FacebookOutput({ pageToken: 'token', pageId: 'facebook-private' }), 'facebook-private'],
  ];

  for (const [output, rawDestination] of cases) {
    assert.equal(typeof output.deliveryKey, 'string', output.name);
    assert.ok(output.deliveryKey.startsWith(`${output.id}:`), output.name);
    assert.equal(output.deliveryKey, output.deliveryKey, output.name);
    assert.equal(output.deliveryKey.includes(rawDestination), false, output.name);
  }

  const first = new DiscordOutput({ webhookUrl: 'https://discord.test/one' });
  const same = new DiscordOutput({ webhookUrl: 'https://discord.test/one' });
  const other = new DiscordOutput({ webhookUrl: 'https://discord.test/two' });
  assert.equal(first.deliveryKey, same.deliveryKey);
  assert.notEqual(first.deliveryKey, other.deliveryKey);

  assert.equal(
    new TelegramOutput({ botToken: 'rotated-one', chatId: 'same-chat' }).deliveryKey,
    new TelegramOutput({ botToken: 'rotated-two', chatId: 'same-chat' }).deliveryKey,
  );
  assert.equal(
    new FacebookOutput({ pageToken: 'rotated-one', pageId: 'same-page' }).deliveryKey,
    new FacebookOutput({ pageToken: 'rotated-two', pageId: 'same-page' }).deliveryKey,
  );
});

test('X delivery topology requires a non-secret authenticated account identity', () => {
  assert.throws(() => new XOutput({
    accessToken: 'token',
    channelId: 'logical-channel-only',
  }), /destinationId is required/i);
});

test('Discord stops after the first non-success and preserves prior message IDs', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { id: 'discord-1' }),
    textResponse(400, 'invalid content'),
    jsonResponse(200, { id: 'discord-3' }),
  ]);
  const output = new DiscordOutput({
    webhookUrl: 'https://discord.test/webhook',
    fetch: transport.fetch,
    sleep: noDelay,
  });
  const content = `${'a'.repeat(2000)}\n${'b'.repeat(2000)}\nlast`;

  const result = await output.send(content);

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, 'discord-1');
  assert.deepEqual(result.meta.successfulMessageIds, ['discord-1']);
  assert.equal(result.meta.partsAttempted, 2);
  assert.equal(result.meta.partsTotal, 3);
  assert.equal(result.meta.partialMutation.successfulSteps, 1);
  assert.equal(result.meta.partialMutation.completedSteps, 1);
  assert.equal(transport.calls.length, 2);
});

test('Discord treats a bodyless successful part as mutation evidence', async () => {
  const transport = sequenceFetch([
    textResponse(204),
    textResponse(400, 'invalid content'),
  ]);
  const output = new DiscordOutput({
    webhookUrl: 'https://discord.test/webhook',
    fetch: transport.fetch,
    sleep: noDelay,
  });

  const result = await output.send('a'.repeat(2500));

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, undefined);
  assert.equal(result.meta.partialMutation.successfulSteps, 1);
  assert.deepEqual(result.meta.successfulMessageIds, []);
  assert.equal(transport.calls.length, 2);
});

test('Discord first-step 401 is definitive and does not attempt later parts', async () => {
  const transport = sequenceFetch([
    textResponse(401, 'bad bearer super-secret-value'),
    jsonResponse(200, { id: 'unexpected' }),
  ]);
  const output = new DiscordOutput({
    webhookUrl: 'https://discord.test/webhook',
    fetch: transport.fetch,
    sleep: noDelay,
  });

  const result = await output.send('a'.repeat(2500));

  assertCanonicalResult(result, 'definitive_failure', 'manual');
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
});

test('X stops a thread after failure and classifies prior mutation as ambiguous', async () => {
  const transport = sequenceFetch([
    jsonResponse(201, { data: { id: 'tweet-1' } }),
    jsonResponse(503, { title: 'Unavailable', detail: 'retry later' }),
    jsonResponse(201, { data: { id: 'tweet-3' } }),
  ]);
  const output = new XOutput({
    accessToken: 'x-secret',
    channelId: 'x-channel',
    destinationId: 'x-account-private',
    fetch: transport.fetch,
    sleep: noDelay,
  });

  const result = await output.send('1/3 first\n\n2/3 second\n\n3/3 third');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, 'tweet-1');
  assert.deepEqual(result.meta.successfulMessageIds, ['tweet-1']);
  assert.deepEqual(result.meta.partialMutation, {
    successfulSteps: 1,
    completedSteps: 1,
    totalSteps: 3,
    failedStep: 2,
    messageIds: ['tweet-1'],
  });
  assert.equal(transport.calls.length, 2);
});

test('Threads publish failure reports the created container and stops', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { id: 'container-1' }),
    jsonResponse(400, { error: { code: 100, message: 'publish rejected' } }),
    jsonResponse(200, { id: 'unexpected' }),
  ]);
  const output = new ThreadsOutput({
    accessToken: 'threads-secret',
    userId: 'threads-user',
    channelId: 'threads-channel',
    fetch: transport.fetch,
  });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, 'container-1');
  assert.deepEqual(result.meta.successfulMessageIds, ['container-1']);
  assert.deepEqual(result.meta.partialMutation, {
    successfulSteps: 1,
    completedSteps: 1,
    totalSteps: 2,
    failedStep: 2,
    messageIds: ['container-1'],
  });
  assert.equal(transport.calls.length, 2);
});

test('Threads create 429 remains definitive with automatic retry timing', async () => {
  const transport = sequenceFetch([
    jsonResponse(429, { error: { code: 4, message: 'rate limited' } }, { 'Retry-After': '3' }),
  ]);
  const output = new ThreadsOutput({
    accessToken: 'threads-secret',
    userId: 'threads-user',
    fetch: transport.fetch,
    now: () => Date.parse('2026-07-20T10:00:00.000Z'),
  });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'definitive_failure', 'automatic');
  assert.equal(result.meta.retryAfterMs, 3000);
  assert.equal(result.meta.nextAttemptAt, '2026-07-20T10:00:03.000Z');
  assert.equal(transport.calls.length, 1);
});

test('single-step HTTP outputs use the same classification matrix', async () => {
  const slackTransport = sequenceFetch([textResponse(401, 'invalid token')]);
  const slack = new SlackOutput({
    webhookUrl: 'https://slack.test/hook',
    fetch: slackTransport.fetch,
  });
  assertCanonicalResult(await slack.send('hello'), 'definitive_failure', 'manual');

  const facebookTransport = sequenceFetch([
    jsonResponse(500, { error: { code: 2, message: 'unknown server outcome' } }),
  ]);
  const facebook = new FacebookOutput({
    pageToken: 'facebook-secret',
    pageId: 'page',
    fetch: facebookTransport.fetch,
  });
  assertCanonicalResult(await facebook.send('hello'), 'ambiguous', 'manual');

  const email = new EmailOutput({
    provider: 'unsupported',
    apiKey: 'secret',
    from: 'from@test.dev',
    to: 'to@test.dev',
  });
  assertCanonicalResult(await email.send('hello'), 'definitive_failure', 'never');
});

test('HTTP classification matrix distinguishes rejection, throttling, and uncertainty', async () => {
  const cases = [
    {
      response: textResponse(200, 'ok'),
      state: 'success',
      disposition: 'never',
    },
    {
      response: textResponse(400, 'invalid payload'),
      state: 'definitive_failure',
      disposition: 'never',
    },
    {
      response: textResponse(401, 'invalid credentials'),
      state: 'definitive_failure',
      disposition: 'manual',
    },
    {
      response: textResponse(429, 'rate limited', { 'Retry-After': '2' }),
      state: 'definitive_failure',
      disposition: 'automatic',
      retryAfterMs: 2000,
    },
    {
      response: textResponse(503, 'unknown outcome'),
      state: 'ambiguous',
      disposition: 'manual',
    },
    {
      response: () => { throw new Error('socket failed'); },
      state: 'ambiguous',
      disposition: 'manual',
      providerCode: 'network_error',
    },
  ];

  for (const scenario of cases) {
    const transport = sequenceFetch([scenario.response]);
    const output = new SlackOutput({
      webhookUrl: 'https://slack.test/hook',
      fetch: transport.fetch,
      now: () => Date.parse('2026-07-20T10:00:00.000Z'),
    });
    const result = await output.send('hello');
    assertCanonicalResult(result, scenario.state, scenario.disposition);
    if (scenario.retryAfterMs) {
      assert.equal(result.meta.retryAfterMs, scenario.retryAfterMs);
      assert.equal(result.meta.nextAttemptAt, '2026-07-20T10:00:02.000Z');
    }
    if (scenario.providerCode) assert.equal(result.meta.providerCode, scenario.providerCode);
  }
});

test('expected-response outputs treat missing mutation IDs as ambiguous and stop', async () => {
  const xTransport = sequenceFetch([
    jsonResponse(201, { data: {} }),
    jsonResponse(201, { data: { id: 'unexpected' } }),
  ]);
  const x = new XOutput({
    accessToken: 'x-secret',
    channelId: 'x-channel',
    destinationId: 'x-account-private',
    fetch: xTransport.fetch,
    sleep: noDelay,
  });
  const xResult = await x.send('1/2 first\n\n2/2 second');
  assertCanonicalResult(xResult, 'ambiguous', 'manual');
  assert.equal(xResult.meta.providerCode, 'invalid_response');
  assert.equal(xTransport.calls.length, 1);

  const threadsTransport = sequenceFetch([
    jsonResponse(200, {}),
    jsonResponse(200, { id: 'unexpected' }),
  ]);
  const threads = new ThreadsOutput({
    accessToken: 'threads-secret',
    userId: 'threads-user',
    fetch: threadsTransport.fetch,
  });
  const threadsResult = await threads.send('hello');
  assertCanonicalResult(threadsResult, 'ambiguous', 'manual');
  assert.equal(threadsResult.meta.providerCode, 'invalid_response');
  assert.equal(threadsTransport.calls.length, 1);
});
