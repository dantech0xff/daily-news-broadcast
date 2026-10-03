import test from 'node:test';
import assert from 'node:assert/strict';

import { describeHttpError, errorBody } from '../../src/app/api/errors.js';
import { ChannelCredentialError } from '../../src/app/channels/build-channel.js';
import { ChannelConflictError } from '../../src/app/channels/channel-repository.js';
import { RuntimeError } from '../../src/app/runtime/errors.js';
import { CredentialInUseError } from '../../src/app/secrets/credential-repository.js';
import { startStubApp, stubRuntime } from './helpers/stub-app.js';

const PROVIDER_FAILURE = 'ordinary outage provider body={"api_key":"raw-api-key"} https://secret.example/hook Bearer raw-bearer';

test('unexpected failures answer 500 "Request failed" and are logged sanitized', async t => {
  const runtime = stubRuntime({
    preview: async () => { throw new Error(PROVIDER_FAILURE); },
    listChannels: () => { throw new Error('database is locked at https://internal.example/db token=raw-db-token'); },
  });
  const app = await startStubApp(t, { runtime });
  const preview = await app.api('/api/channels/news/preview', { as: 'operator', method: 'POST' });
  assert.equal(preview.status, 500);
  assert.deepEqual(preview.body, { error: 'internal_error', message: 'Request failed' });
  assert.equal(preview.headers['cache-control'], 'no-store');
  const list = await app.api('/api/channels', { as: 'viewer' });
  assert.equal(list.status, 500);

  const logs = app.logs.join('\n');
  assert.match(logs, /ordinary outage/);
  assert.match(logs, /POST \/api\/channels\/:id\/preview failed/);
  assert.match(logs, /database is locked/);
  for (const secret of ['raw-api-key', 'secret.example', 'raw-bearer', 'internal.example', 'raw-db-token']) {
    assert.equal(logs.includes(secret) || preview.text.includes(secret) || list.text.includes(secret), false, secret);
  }
});

test('failures on credential routes log the error class only', async t => {
  const runtime = stubRuntime({
    createCredential: () => { throw new Error('sealing failed for value 123456:SECRET-in-error-message'); },
  });
  const app = await startStubApp(t, { runtime });
  const response = await app.api('/api/credentials', {
    as: 'operator', method: 'POST', body: { label: 'Bot', kind: 'telegram_bot_token', value: '123456:SECRET-in-error-message' },
  });
  assert.equal(response.status, 500);
  const logs = app.logs.join('\n');
  assert.match(logs, /POST \/api\/credentials failed: Error \(details withheld/);
  assert.equal(logs.includes('SECRET-in-error-message'), false);
  assert.equal(response.text.includes('SECRET-in-error-message'), false);
});

test('control results are projected to identifiers, states, and versions', async t => {
  const runtime = stubRuntime({
    control: async (channelId, action) => ({
      channelId, action, status: 'confirmed', replayed: false, deliveryId: 'opaque-delivery', deliveryState: 'succeeded', version: 8,
      generatedContent: 'secret digest', providerDestination: 'hidden-provider',
    }),
  });
  const app = await startStubApp(t, { runtime });
  const response = await app.api('/api/channels/news/control/confirm-delivered', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'k', expectedVersion: 7, reason: 'verified', deliveryId: 'd', outputKey: 'o' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    channelId: 'news', action: 'confirm-delivered', status: 'confirmed', replayed: false,
    version: 8, deliveryId: 'opaque-delivery', deliveryState: 'succeeded',
  });
});

test('runtime refusals map to stable codes with sanitized details', async t => {
  const runtime = stubRuntime({
    control: async () => { throw new RuntimeError('control_rejected', 'Output retry needs confirmPausedMutation; see https://secret.example/x token=raw'); },
  });
  const app = await startStubApp(t, { runtime });
  const response = await app.api('/api/channels/news/control/retry-output', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'k', expectedVersion: 7, reason: 'retry', deliveryId: 'd', outputKey: 'o' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'control_rejected');
  assert.match(response.body.details.reason, /confirmPausedMutation/);
  assert.equal(response.text.includes('secret.example') || response.text.includes('token=raw'), false);

  const cases = [
    [new RuntimeError('runtime_not_leased', 'x'), 503, 'runtime_not_leased'],
    [new RuntimeError('runtime_stopped', 'x'), 503, 'runtime_stopped'],
    [new RuntimeError('channel_busy', 'x'), 409, 'channel_busy'],
    [new RuntimeError('channel_not_paused', 'x'), 409, 'channel_not_paused'],
    [new RuntimeError('channel_has_unresolved', 'x', { details: { unresolved: 2 } }), 409, 'channel_has_unresolved'],
    [new RuntimeError('channel_disabled', 'x'), 409, 'channel_disabled'],
    [new RuntimeError('version_conflict', 'x'), 409, 'version_conflict'],
    [new RuntimeError('target_not_found', 'x'), 404, 'target_not_found'],
    [new ChannelConflictError('version_conflict', 'news', { currentVersion: 4 }), 409, 'version_conflict'],
    [new ChannelConflictError('channel_exists', 'news'), 409, 'channel_exists'],
    [new CredentialInUseError('cred', ['news']), 409, 'credential_in_use'],
    [new ChannelCredentialError('news', ['telegram.botTokenCredentialId']), 422, 'missing_credential'],
    [new ChannelCredentialError('news', ['ai.apiKeyCredentialId'], { code: 'credential_unavailable' }), 422, 'credential_unavailable'],
    [new RuntimeError('some_new_code', 'x'), 500, 'internal_error'],
    [new TypeError('bug'), 500, 'internal_error'],
  ];
  for (const [error, status, code] of cases) {
    const view = describeHttpError(error);
    assert.deepEqual([view.status, view.code], [status, code], error.message);
    const body = errorBody(view);
    assert.equal(typeof body.message, 'string');
    assert.equal(body.message.length > 0, true);
  }
  assert.deepEqual(errorBody(describeHttpError(new RuntimeError('channel_has_unresolved', 'x', { details: { unresolved: 2 } }))).details, { unresolved: 2 });
  assert.deepEqual(errorBody(describeHttpError(new ChannelConflictError('version_conflict', 'news', { currentVersion: 4 }))).details, { currentVersion: 4 });
  assert.deepEqual(errorBody(describeHttpError(new CredentialInUseError('cred', ['news']))).details, { usedBy: ['news'] });
});
