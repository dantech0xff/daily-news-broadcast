import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATOR_EMAIL,
  SERVICE_OPERATOR_ID,
  createChannelViaApi,
  createCredentialsViaApi,
  resumeViaApi,
  startTestApp,
} from './helpers/app-server.js';
import { channelInput } from './helpers/runtime-fixture.js';

test('operators create channels that start paused; the actor comes from the token', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  const created = await app.api('/api/channels', {
    as: 'operator',
    method: 'POST',
    body: { ...channelInput(ids), updatedBy: 'attacker@example.test', version: 99 },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.id, 'telegram-ops');
  assert.equal(created.body.version, 1);
  assert.equal(created.body.updatedBy, OPERATOR_EMAIL);
  assert.equal(created.body.telegram.botTokenCredentialId, ids.botToken);
  assert.equal(created.headers['cache-control'], 'no-store');

  const status = await app.api('/api/channels/telegram-ops/status', { as: 'viewer' });
  assert.equal(status.body.paused, true);
  assert.deepEqual(status.body.allowedActions, ['resume']);
  assert.equal(app.cron.active().has('telegram-ops'), true);

  const list = await app.api('/api/channels', { as: 'viewer' });
  assert.deepEqual(list.body.channels.map(channel => channel.id), ['telegram-main', 'telegram-ops']);
  assert.equal((await app.api('/api/channels/telegram-ops', { as: 'viewer' })).body.name, 'Telegram Ops');
  const missing = await app.api('/api/channels/nope', { as: 'viewer' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'channel_not_found');

  const duplicate = await app.api('/api/channels', { as: 'operator', method: 'POST', body: channelInput(ids) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'channel_exists');
});

test('invalid channel input is a 400 listing every field issue', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  const invalid = await app.api('/api/channels', {
    as: 'operator',
    method: 'POST',
    body: channelInput(ids, { id: 'Bad Id', cron: 'every minute', surprise: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'validation_failed');
  assert.deepEqual(invalid.body.issues.map(issue => [issue.field, issue.code]).sort(), [
    ['cron', 'invalid_cron'],
    ['id', 'invalid_format'],
    ['surprise', 'unknown_field'],
  ]);
  const unknownCredential = await app.api('/api/channels', {
    as: 'operator',
    method: 'POST',
    body: channelInput({ ...ids, botToken: 'missing-credential' }, { id: 'needs-bot' }),
  });
  assert.equal(unknownCredential.status, 400);
  assert.deepEqual(unknownCredential.body.issues.map(issue => [issue.field, issue.code]), [['telegram.botTokenCredentialId', 'credential_not_found']]);
  const wrongKind = await app.api('/api/channels', {
    as: 'operator',
    method: 'POST',
    body: channelInput({ ...ids, botToken: ids.chatId }, { id: 'wrong-kind' }),
  });
  assert.deepEqual(wrongKind.body.issues.map(issue => issue.code), ['credential_kind_mismatch']);
  const notObject = await app.api('/api/channels', { as: 'operator', method: 'POST', body: ['telegram-ops'] });
  assert.equal(notObject.status, 400);
  assert.deepEqual((await app.api('/api/channels', { as: 'viewer' })).body.channels.map(channel => channel.id), ['telegram-main']);
});

test('updates need the current version; stale versions conflict with the current one reported', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);

  const updated = await app.api('/api/channels/telegram-ops', {
    as: 'serviceOperator',
    method: 'PUT',
    body: { version: 1, name: 'Renamed', cron: '30 7 * * 1-5', notBefore: '2026-10-03T07:00:00+07:00', updatedBy: 'ignored@example.test' },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.body.version, 2);
  assert.equal(updated.body.name, 'Renamed');
  assert.equal(updated.body.notBefore, '2026-10-03T00:00:00.000Z');
  assert.equal(updated.body.updatedBy, `service:${SERVICE_OPERATOR_ID}`);
  assert.equal(app.cron.active().get('telegram-ops').expression, '30 7 * * 1-5', 'the schedule reloads immediately');

  const stale = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'PUT', body: { version: 1, name: 'Lost update' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version_conflict');
  assert.deepEqual(stale.body.details, { currentVersion: 2 });

  const noVersion = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'PUT', body: { name: 'No version' } });
  assert.equal(noVersion.status, 400);
  assert.deepEqual(noVersion.body.issues.map(issue => issue.field), ['version']);
  const stringVersion = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'PUT', body: { version: '2', name: 'x' } });
  assert.equal(stringVersion.status, 400);
  const renamedId = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'PUT', body: { version: 2, id: 'other-id' } });
  assert.deepEqual(renamedId.body.issues.map(issue => [issue.field, issue.code]), [['id', 'immutable']]);
  const missing = await app.api('/api/channels/nope', { as: 'operator', method: 'PUT', body: { version: 1, name: 'x' } });
  assert.equal(missing.status, 404);

  // The full record read from the API can be sent back as an update.
  const record = (await app.api('/api/channels/telegram-ops', { as: 'viewer' })).body;
  const roundTrip = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'PUT', body: { ...record, notBefore: null } });
  assert.equal(roundTrip.status, 200, roundTrip.text);
  assert.equal(roundTrip.body.version, 3);
  assert.equal(roundTrip.body.notBefore, null);
});

test('deleting a channel needs its config version and a paused, resolved channel', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  assert.equal((await resumeViaApi(app.api, 'telegram-ops')).status, 200);

  const active = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: { expectedVersion: 1 } });
  assert.equal(active.status, 409);
  assert.equal(active.body.error, 'channel_not_paused');

  const status = (await app.api('/api/channels/telegram-ops/status', { as: 'viewer' })).body;
  const paused = await app.api('/api/channels/telegram-ops/control/pause', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'pause-before-delete', expectedVersion: status.version, reason: 'Retire channel' },
  });
  assert.equal(paused.status, 200, paused.text);

  const withoutVersion = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: {} });
  assert.equal(withoutVersion.status, 400);
  assert.deepEqual(withoutVersion.body.issues.map(issue => issue.field), ['expectedVersion']);
  const stale = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: { expectedVersion: 7 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version_conflict');
  const extraField = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: { expectedVersion: 1, force: true } });
  assert.equal(extraField.status, 400);

  const deleted = await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: { expectedVersion: 1 } });
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.body, { channelId: 'telegram-ops', deleted: true });
  assert.equal((await app.api('/api/channels/telegram-ops', { as: 'viewer' })).status, 404);
  assert.equal(app.cron.active().has('telegram-ops'), false);
  assert.equal((await app.api('/api/channels/telegram-ops', { as: 'operator', method: 'DELETE', body: { expectedVersion: 1 } })).status, 404);
});
