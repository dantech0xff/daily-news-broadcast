import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECRET_VALUES,
  VIEWER_EMAIL,
  createChannelViaApi,
  createCredentialsViaApi,
  httpRequest,
  openEventStream,
  sharedAccessSigner,
  startTestApp,
} from './helpers/app-server.js';
import { STUB_NOW, eventually, startStubApp } from './helpers/stub-app.js';

test('the event stream needs a viewer token and delivers runtime events without secrets', async t => {
  const app = await startTestApp(t);
  const anonymous = await openEventStream(app.url, null);
  assert.equal(anonymous.status, 401);
  await anonymous.ended;
  const unmapped = await openEventStream(app.url, app.tokens.unmapped);
  assert.equal(unmapped.status, 403);
  await unmapped.ended;

  const stream = await openEventStream(app.url, app.tokens.viewer);
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /^text\/event-stream/);
  assert.equal(stream.headers['cache-control'], 'no-store');
  const connected = await stream.next(frame => frame.data?.type === 'connected');
  assert.equal(connected.retry, 5_000);

  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  const changed = await stream.next(frame => frame.data?.type === 'channel.changed' && frame.data.data.channelId === 'telegram-ops');
  assert.deepEqual(changed.data.data, { channelId: 'telegram-ops', action: 'created', version: 1 });
  const paused = await stream.next(frame => frame.data?.type === 'control.applied' && frame.data.data.channelId === 'telegram-ops');
  assert.equal(paused.data.data.action, 'pause');
  const credential = await stream.next(frame => frame.data?.type === 'credential.changed');
  assert.deepEqual(Object.keys(credential.data.data).sort(), ['action', 'credentialId', 'kind']);
  for (const secret of Object.values(SECRET_VALUES)) assert.equal(stream.raw.includes(secret), false);
});

test('event data is projected to bounded, sanitized scalars', async t => {
  const app = await startStubApp(t);
  const stream = await openEventStream(app.url, app.tokens.operator);
  t.after(() => stream.close());
  await stream.next(frame => frame.data?.type === 'connected');
  app.runtime.emit({
    type: 'run.finished',
    at: '2026-10-03T08:00:00.000Z',
    data: {
      runId: 'run-1',
      status: 'failed',
      reason: 'provider body={"api_key":"raw-key"} at https://secret.example/hook token=raw-token',
      outputs: 2,
      replayed: false,
      nested: { content: 'generated digest' },
      'not a key': 'dropped',
    },
  });
  const frame = await stream.next(entry => entry.data?.type === 'run.finished');
  assert.deepEqual(Object.keys(frame.data.data).sort(), ['outputs', 'reason', 'replayed', 'runId', 'status']);
  for (const leaked of ['raw-key', 'secret.example', 'raw-token', 'generated digest']) {
    assert.equal(stream.raw.includes(leaked), false, leaked);
  }
});

test('a stream ends when its Access token expires so the client re-authenticates; HEAD opens no stream', async t => {
  const app = await startStubApp(t);
  const signer = await sharedAccessSigner();
  // Expires exactly at the app clock: still accepted within the clock tolerance, then ended at once.
  const expiring = await signer.sign({ email: VIEWER_EMAIL }, { now: new Date(STUB_NOW.getTime() - 3_600_000), ttlSeconds: 3_600 });
  const stream = await openEventStream(app.url, expiring);
  assert.equal(stream.status, 200);
  await Promise.race([
    stream.ended,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the stream outlived its token')), 2_000)),
  ]);
  assert.equal(stream.frames[0].data.type, 'connected');
  await eventually(() => app.runtime.listeners.size === 0);

  const head = await httpRequest(app.url, '/api/events', { method: 'HEAD', headers: { 'cf-access-jwt-assertion': app.tokens.viewer } });
  assert.equal(head.status, 200);
  assert.match(head.headers['content-type'], /^text\/event-stream/);
  assert.equal(app.runtime.listeners.size, 0);
});

test('heartbeats keep the stream alive and closed clients unsubscribe immediately', async t => {
  const app = await startStubApp(t, { sseHeartbeatMs: 20 });
  const stream = await openEventStream(app.url, app.tokens.viewer);
  await stream.next(frame => frame.data?.type === 'connected');
  assert.equal(app.runtime.listeners.size, 1);
  await stream.next(frame => frame.comments.includes('heartbeat'));

  stream.close();
  await eventually(() => app.runtime.listeners.size === 0, { message: 'the closed stream kept its runtime subscription' });

  const second = await openEventStream(app.url, app.tokens.viewer);
  await second.next(frame => frame.data?.type === 'connected');
  app.closeEventStreams();
  await second.ended;
  assert.equal(app.runtime.listeners.size, 0, 'closeAll ends every stream and unsubscribes');
});
