import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignJWT, UnsecuredJWT, exportJWK } from 'jose';

import {
  ACCESS_JWT_HEADER,
  AccessTokenError,
  createAccessKeySet,
  createAccessVerifier,
  readAccessToken,
  warmUpAccessKeySet,
} from '../../src/app/auth/access-jwt.js';
import { actorFor, createRoleResolver, hasRole, identityFromClaims } from '../../src/app/auth/roles.js';
import {
  ACCESS_AUD,
  ACCESS_ISSUER,
  createAccessSigner,
  sharedAccessSigner,
  signAccessToken,
} from './helpers/app-server.js';

const NOW = new Date('2026-10-03T08:00:00.000Z');

async function verifier(overrides = {}) {
  const signer = await sharedAccessSigner();
  return createAccessVerifier({
    issuer: ACCESS_ISSUER,
    audience: [ACCESS_AUD],
    keySet: signer.keySet,
    clock: () => NOW,
    ...overrides,
  });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, error => error instanceof AccessTokenError && error.code === code);
}

test('a valid RS256 user token from the team issuer and audience verifies', async () => {
  const signer = await sharedAccessSigner();
  const token = await signer.sign({ email: 'Ops@Example.test' }, { now: NOW });
  const claims = await (await verifier()).verify(token);
  assert.equal(claims.email, 'Ops@Example.test');
  assert.equal(claims.iss, ACCESS_ISSUER);
  assert.deepEqual(claims.aud, [ACCESS_AUD]);
});

test('any configured audience is accepted when the token lists several', async () => {
  const signer = await sharedAccessSigner();
  const token = await signer.sign({ email: 'ops@example.test' }, { now: NOW, audience: ['other-app', 'second-aud'] });
  const claims = await (await verifier({ audience: [ACCESS_AUD, 'second-aud'] })).verify(token);
  assert.equal(claims.email, 'ops@example.test');
});

test('wrong audience, wrong issuer, expired, not-yet-valid, and exp-less tokens are rejected', async () => {
  const signer = await sharedAccessSigner();
  const check = await verifier();
  await rejectsWith(check.verify(await signer.sign({ email: 'a@b.test' }, { now: NOW, audience: ['another-app'] })), 'invalid_token');
  await rejectsWith(check.verify(await signer.sign({ email: 'a@b.test' }, { now: NOW, issuer: 'https://evil.cloudflareaccess.com' })), 'invalid_token');
  const expiredAt = new Date(NOW.getTime() - 2 * 3_600_000);
  await rejectsWith(check.verify(await signer.sign({ email: 'a@b.test' }, { now: expiredAt, ttlSeconds: 3_600 })), 'invalid_token');
  const future = new Date(NOW.getTime() + 10 * 60_000);
  await rejectsWith(check.verify(await signer.sign({ email: 'a@b.test' }, { now: future })), 'invalid_token');
  await rejectsWith(check.verify(await signer.sign({ email: 'a@b.test' }, { now: NOW, omitExp: true })), 'invalid_token');
});

test('a small clock skew within the tolerance is accepted', async () => {
  const signer = await sharedAccessSigner();
  // Expired 10 seconds ago, within the 30-second tolerance.
  const token = await signer.sign({ email: 'a@b.test' }, { now: new Date(NOW.getTime() - 70_000), ttlSeconds: 60 });
  assert.equal((await (await verifier()).verify(token)).email, 'a@b.test');
  assert.throws(() => createAccessVerifier({ issuer: ACCESS_ISSUER, audience: [ACCESS_AUD], keySet: () => {}, clockToleranceSeconds: 120 }), /tolerance/);
});

test('a token signed by an unknown key or with an unknown kid is rejected', async () => {
  const stranger = await createAccessSigner();
  const check = await verifier();
  await rejectsWith(check.verify(await stranger.sign({ email: 'a@b.test' }, { now: NOW })), 'invalid_token');
  const signer = await sharedAccessSigner();
  const wrongKid = await signAccessToken(signer.privateKey, { kid: 'unknown-kid', now: NOW }, { email: 'a@b.test' });
  await rejectsWith(check.verify(wrongKid), 'invalid_token');
  // Correct kid, signature from another key.
  const forged = await signAccessToken(stranger.privateKey, { kid: signer.kid, now: NOW }, { email: 'a@b.test' });
  await rejectsWith(check.verify(forged), 'invalid_token');
});

test('HS256 and alg "none" tokens are rejected', async () => {
  const signer = await sharedAccessSigner();
  const check = await verifier();
  const issuedAt = Math.floor(NOW.getTime() / 1000);
  const hs256 = await new SignJWT({ email: 'a@b.test' })
    .setProtectedHeader({ alg: 'HS256', kid: signer.kid })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUD)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 600)
    .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough-123456'));
  await rejectsWith(check.verify(hs256), 'invalid_token');

  // alg "none": an unsigned token with an empty signature segment.
  const unsigned = new UnsecuredJWT({ email: 'a@b.test' })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUD)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 600)
    .encode();
  await rejectsWith(check.verify(unsigned), 'invalid_token');
});

test('missing, malformed, and oversized tokens are rejected before verification', async () => {
  const check = await verifier();
  await rejectsWith(check.verify(null), 'missing_token');
  await rejectsWith(check.verify(''), 'missing_token');
  for (const token of ['abc', 'a.b', 'a.b.c.d', 'not a token.x.y', `${'a'.repeat(9_000)}.b.c`]) {
    await rejectsWith(check.verify(token), 'invalid_token');
  }
});

test('the token is read only from the Cf-Access-Jwt-Assertion header', () => {
  assert.equal(ACCESS_JWT_HEADER, 'cf-access-jwt-assertion');
  assert.equal(readAccessToken({ 'cf-access-jwt-assertion': '  a.b.c  ' }), 'a.b.c');
  assert.equal(readAccessToken({ 'cf-access-authenticated-user-email': 'ops@example.test' }), null);
  assert.equal(readAccessToken({ cookie: 'CF_Authorization=a.b.c' }), null);
  assert.equal(readAccessToken({ authorization: 'Bearer a.b.c' }), null);
  assert.equal(readAccessToken({}), null);
});

test('a local JWKS file is loaded; private key material is refused', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-jwks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const signer = await createAccessSigner();
  const publicPath = join(directory, 'jwks.json');
  await writeFile(publicPath, JSON.stringify(signer.jwks));
  const keySet = await createAccessKeySet({ jwksFile: publicPath, certsUrl: 'https://unused.example/certs' });
  const check = createAccessVerifier({ issuer: ACCESS_ISSUER, audience: [ACCESS_AUD], keySet, clock: () => NOW });
  assert.equal((await check.verify(await signer.sign({ email: 'a@b.test' }, { now: NOW }))).email, 'a@b.test');

  const privatePath = join(directory, 'private.json');
  await writeFile(privatePath, JSON.stringify({ keys: [{ ...await exportJWK(signer.privateKey), kid: 'k' }] }));
  await assert.rejects(createAccessKeySet({ jwksFile: privatePath }), /no private key material/);
  await writeFile(privatePath, 'not json');
  await assert.rejects(createAccessKeySet({ jwksFile: privatePath }), /JSON Web Key Set/);
  await assert.rejects(createAccessKeySet({ jwksFile: join(directory, 'missing.json') }), /could not be read \(ENOENT\)/);
});

test('an unreachable remote JWKS is a 503 key failure, not an invalid token', async () => {
  // Tests deny network access, like a production outage of the team JWKS.
  const keySet = await createAccessKeySet({ jwksFile: null, certsUrl: `${ACCESS_ISSUER}/cdn-cgi/access/certs` });
  const check = createAccessVerifier({ issuer: ACCESS_ISSUER, audience: [ACCESS_AUD], keySet, clock: () => NOW });
  const signer = await sharedAccessSigner();
  const error = await check.verify(await signer.sign({ email: 'a@b.test' }, { now: NOW })).then(() => null, value => value);
  assert.ok(error instanceof AccessTokenError);
  assert.equal(error.code, 'keys_unavailable');
  assert.equal(error.status, 503);
  assert.equal(String(error.reason).includes(ACCESS_ISSUER), false, 'URLs are redacted from the logged reason');
});

test('identities come from email (people) or common_name (service tokens)', () => {
  assert.deepEqual(identityFromClaims({ email: ' Ops@Example.TEST ' }), { type: 'user', email: 'ops@example.test' });
  assert.deepEqual(identityFromClaims({ common_name: 'abc.access', sub: '' }), { type: 'service', clientId: 'abc.access' });
  assert.deepEqual(identityFromClaims({ email: 'ops@example.test', common_name: 'abc.access' }), { type: 'user', email: 'ops@example.test' });
  assert.equal(identityFromClaims({ sub: 'someone' }), null);
  assert.equal(identityFromClaims({ email: 'no-at-sign' }), null);
  assert.equal(identityFromClaims({ email: 42 }), null);
});

test('roles map emails and service tokens; operator includes viewer; unmapped has no role', () => {
  const roles = createRoleResolver({
    operatorEmails: ['ops@example.test', 'both@example.test'],
    viewerEmails: ['viewer@example.test', 'both@example.test'],
    serviceTokens: [{ clientId: 'agent.access', role: 'operator' }, { clientId: 'reader.access', role: 'viewer' }],
  });
  assert.equal(roles.roleFor({ type: 'user', email: 'ops@example.test' }), 'operator');
  assert.equal(roles.roleFor({ type: 'user', email: 'both@example.test' }), 'operator');
  assert.equal(roles.roleFor({ type: 'user', email: 'viewer@example.test' }), 'viewer');
  assert.equal(roles.roleFor({ type: 'user', email: 'stranger@example.test' }), null);
  assert.equal(roles.roleFor({ type: 'service', clientId: 'agent.access' }), 'operator');
  assert.equal(roles.roleFor({ type: 'service', clientId: 'reader.access' }), 'viewer');
  assert.equal(roles.roleFor({ type: 'service', clientId: 'ops@example.test' }), null);
  assert.equal(roles.roleFor({ type: 'user', email: 'agent.access' }), null);
  assert.equal(roles.roleFor(null), null);

  assert.equal(hasRole('operator', 'viewer'), true);
  assert.equal(hasRole('operator', 'operator'), true);
  assert.equal(hasRole('viewer', 'viewer'), true);
  assert.equal(hasRole('viewer', 'operator'), false);
  assert.equal(hasRole(null, 'viewer'), false);
  assert.throws(() => hasRole('viewer', 'admin'), TypeError);

  assert.equal(actorFor({ type: 'user', email: 'ops@example.test' }), 'ops@example.test');
  assert.equal(actorFor({ type: 'service', clientId: 'agent.access' }), 'service:agent.access');
});

test('the remote key set is warmed up in the background and retries without throwing', async () => {
  const logs = [];
  const logger = { log: line => logs.push(line), warn: line => logs.push(line) };
  const sleeps = [];
  const sleep = async ms => { sleeps.push(ms); };

  let calls = 0;
  const flaky = Object.assign(() => {}, {
    reload: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('timed out'), { code: 'ERR_JWKS_TIMEOUT' });
    },
  });
  assert.equal(await warmUpAccessKeySet(flaky, { logger, sleep }), true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2_000, 4_000]);
  assert.match(logs.join('\n'), /attempt 1\/3\): ERR_JWKS_TIMEOUT/);
  assert.match(logs.at(-1), /signing keys loaded/);

  const down = Object.assign(() => {}, { reload: async () => { throw new Error('offline'); } });
  assert.equal(await warmUpAccessKeySet(down, { logger, sleep }), false);

  assert.equal(await warmUpAccessKeySet(() => {}, { logger, sleep }), false, 'a local key set needs no warm-up');
});

test('the remote key set allows slow first fetches and exposes reload for warm-up', async () => {
  const keySet = await createAccessKeySet({ certsUrl: 'https://team.example.invalid/cdn-cgi/access/certs' });
  assert.equal(typeof keySet.reload, 'function');
});
