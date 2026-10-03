import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATOR_EMAIL,
  SECRET_VALUES,
  createChannelViaApi,
  createCredentialsViaApi,
  openEventStream,
  startTestApp,
} from './helpers/app-server.js';

const METADATA_KEYS = ['createdAt', 'id', 'isSet', 'kind', 'label', 'updatedAt', 'updatedBy', 'usedBy'];

function assertNoSecrets(text, secrets, where) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} leaked a credential value`);
}

test('credentials are write-only: responses, events, and logs never contain their values', async t => {
  const app = await startTestApp(t);
  const events = await openEventStream(app.url, app.tokens.viewer);
  t.after(() => events.close());
  await events.next(frame => frame.data?.type === 'connected');

  const ids = await createCredentialsViaApi(app.api);
  const replacement = '654321:API-test-replaced-token-secret';
  const replaced = await app.api(`/api/credentials/${ids.botToken}`, { as: 'operator', method: 'PUT', body: { value: replacement } });
  assert.equal(replaced.status, 200, replaced.text);
  assert.deepEqual(Object.keys(replaced.body).sort(), METADATA_KEYS);
  assert.equal(replaced.body.isSet, true);
  assert.equal(replaced.body.kind, 'telegram_bot_token');

  const listed = await app.api('/api/credentials', { as: 'viewer' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.credentials.length, 3);
  for (const credential of listed.body.credentials) {
    assert.deepEqual(Object.keys(credential).sort(), METADATA_KEYS);
    assert.equal(credential.isSet, true);
    assert.equal(credential.updatedBy, OPERATOR_EMAIL);
  }

  // Failure paths that carry a value: wrong format, malformed JSON, oversized, unknown fields.
  const leakyValue = 'not-a-chat-id-API-leak-check';
  const badFormat = await app.api('/api/credentials', { as: 'operator', method: 'POST', body: { label: 'Chat', kind: 'telegram_chat_id', value: leakyValue } });
  assert.equal(badFormat.status, 400);
  assert.deepEqual(badFormat.body.issues.map(issue => [issue.field, issue.code]), [['value', 'invalid_format']]);
  const malformed = await app.api('/api/credentials', { as: 'operator', method: 'POST', rawBody: `{"label":"x","kind":"ai_api_key","value":"${leakyValue}` });
  assert.equal(malformed.status, 400);
  const oversized = await app.api('/api/credentials', { as: 'operator', method: 'POST', body: { label: 'x', kind: 'ai_api_key', value: `${leakyValue}${'x'.repeat(9_000)}` } });
  assert.equal(oversized.status, 413);
  const withActor = await app.api('/api/credentials', {
    as: 'operator', method: 'POST', body: { label: 'x', kind: 'ai_api_key', value: leakyValue, actor: 'attacker@example.test' },
  });
  assert.equal(withActor.status, 400);
  assert.deepEqual(withActor.body.issues.map(issue => [issue.field, issue.code]), [['actor', 'unknown_field']]);
  const replaceKind = await app.api(`/api/credentials/${ids.aiKey}`, { as: 'operator', method: 'PUT', body: { value: leakyValue, kind: 'telegram_bot_token' } });
  assert.equal(replaceKind.status, 400);
  const missing = await app.api('/api/credentials/does-not-exist', { as: 'operator', method: 'PUT', body: { value: leakyValue } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'credential_not_found');

  await events.next(frame => frame.data?.type === 'credential.changed' && frame.data.data.action === 'replaced');
  const secrets = [...Object.values(SECRET_VALUES), replacement, leakyValue];
  for (const response of app.responses) assertNoSecrets(response.text, secrets, `response ${response.status}`);
  assertNoSecrets(events.raw, secrets, 'event stream');
  assertNoSecrets(app.logs.join('\n'), secrets, 'logs');
  assert.equal((await app.api('/api/credentials', { as: 'viewer' })).body.credentials.length, 3, 'failed requests stored nothing');
});

test('a credential used by a channel cannot be deleted until the channel lets go of it', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);

  const inUse = await app.api(`/api/credentials/${ids.aiKey}`, { as: 'operator', method: 'DELETE' });
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.error, 'credential_in_use');
  assert.deepEqual(inUse.body.details, { usedBy: ['telegram-ops'] });
  const usage = (await app.api('/api/credentials', { as: 'viewer' })).body.credentials.find(credential => credential.id === ids.aiKey);
  assert.deepEqual(usage.usedBy, ['telegram-ops']);

  const spare = await app.api('/api/credentials', { as: 'operator', method: 'POST', body: { label: 'Spare', kind: 'ai_api_key', value: 'spare-key-value' } });
  const withBody = await app.api(`/api/credentials/${spare.body.id}`, { as: 'operator', method: 'DELETE', body: { force: true } });
  assert.equal(withBody.status, 400);
  const deleted = await app.api(`/api/credentials/${spare.body.id}`, { as: 'operator', method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { credentialId: spare.body.id, deleted: true });
  assert.equal((await app.api(`/api/credentials/${spare.body.id}`, { as: 'operator', method: 'DELETE' })).status, 404);
  const noBody = await app.api(`/api/credentials/${ids.chatId}`, { as: 'operator', method: 'DELETE', body: null });
  assert.equal(noBody.status, 409, 'a DELETE without a body is accepted and reaches the in-use check');
});
