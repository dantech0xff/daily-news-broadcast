import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEV_ACCESS_AUD,
  DEV_ACCESS_ISSUER,
  ensureDevKeys,
  signDevAccessToken,
} from '../../scripts/dev-access-token.mjs';
import { startTestApp } from './helpers/app-server.js';

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-dev-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('dev keys are created once, owner-only, with a public-only JWKS', async t => {
  const keyDir = join(await tempDir(t), 'dev-access');
  const first = await ensureDevKeys(keyDir);
  assert.equal(first.created, true);
  assert.equal((await stat(join(keyDir, 'signing-key.json'))).mode & 0o777, 0o600);
  const jwks = JSON.parse(await readFile(first.jwksPath, 'utf8'));
  assert.equal(jwks.keys.length, 1);
  assert.equal('d' in jwks.keys[0], false);
  assert.equal(jwks.keys[0].kid, first.privateJwk.kid);

  const second = await ensureDevKeys(keyDir);
  assert.equal(second.created, false);
  assert.equal(second.privateJwk.kid, first.privateJwk.kid);

  // A half-written or damaged key directory is reported instead of silently replaced.
  await rm(join(keyDir, 'jwks.json'));
  await assert.rejects(ensureDevKeys(keyDir), /incomplete/);
  await writeFile(join(keyDir, 'jwks.json'), '{}');
  await writeFile(join(keyDir, 'signing-key.json'), 'not json');
  await assert.rejects(ensureDevKeys(keyDir), /unreadable/);
});

test('dev tokens verify through ACCESS_JWKS_FILE for people and service tokens', async t => {
  const { privateJwk, jwksPath } = await ensureDevKeys(join(await tempDir(t), 'dev-access'));
  const app = await startTestApp(t, {
    env: {
      ACCESS_JWKS_FILE: jwksPath,
      ACCESS_TEAM_DOMAIN: DEV_ACCESS_ISSUER,
      ACCESS_AUD: DEV_ACCESS_AUD,
      APP_SERVICE_TOKEN_ROLES: 'local-agent.access:operator',
    },
    dependencies: { keySet: undefined },
  });
  const now = app.clock();
  const person = await signDevAccessToken({ privateJwk, email: 'Ops@Example.test', now });
  const me = await app.api('/api/me', { as: person.token });
  assert.equal(me.status, 200, me.text);
  assert.deepEqual(me.body, { identity: { type: 'user', email: 'ops@example.test' }, role: 'operator' });

  const service = await signDevAccessToken({ privateJwk, serviceClientId: 'local-agent.access', now, ttlSeconds: 600 });
  assert.deepEqual((await app.api('/api/me', { as: service.token })).body, {
    identity: { type: 'service', clientId: 'local-agent.access' },
    role: 'operator',
  });
  assert.equal(service.expiresAt.getTime(), now.getTime() + 600_000);

  const otherAudience = await signDevAccessToken({ privateJwk, email: 'ops@example.test', audience: 'another-app', now });
  assert.equal((await app.api('/api/me', { as: otherAudience.token })).status, 401);
});

test('dev token arguments are validated', async () => {
  const privateJwk = { kty: 'RSA', kid: 'unused' };
  await assert.rejects(signDevAccessToken({ privateJwk }), /exactly one/);
  await assert.rejects(signDevAccessToken({ privateJwk, email: 'a@b.test', serviceClientId: 'x' }), /exactly one/);
  await assert.rejects(signDevAccessToken({ privateJwk, email: 'not-an-email' }), /--email/);
  await assert.rejects(signDevAccessToken({ privateJwk, serviceClientId: 'bad id!' }), /--service-client-id/);
  await assert.rejects(signDevAccessToken({ privateJwk, email: 'a@b.test', ttlSeconds: 10 }), /--ttl/);
});
