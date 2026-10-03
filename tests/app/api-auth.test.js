import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTENT_SECURITY_POLICY } from '../../src/app/api/http.js';
import {
  OPERATOR_EMAIL,
  PUBLIC_ORIGIN,
  SERVICE_OPERATOR_ID,
  createAccessSigner,
  createCredentialsViaApi,
  httpRequest,
  startTestApp,
} from './helpers/app-server.js';
import { channelInput } from './helpers/runtime-fixture.js';

const UI_MARKER = 'Content Radar UI build marker';

async function writeWebBuild(directory) {
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'index.html'), `<!doctype html><title>${UI_MARKER}</title><div id="root"></div><script type="module" src="/assets/app.js"></script>`);
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("radar");\n');
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-powered-by'], undefined);
}

test('/healthz answers ok without authentication and reveals nothing else', async t => {
  const app = await startTestApp(t);
  const response = await httpRequest(app.url, '/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.text, 'ok');
  assert.match(response.headers['content-type'], /^text\/plain/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assertSecurityHeaders(response);
  const head = await httpRequest(app.url, '/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('every API route needs a valid Access JWT from the Cf-Access-Jwt-Assertion header', async t => {
  const app = await startTestApp(t);
  const valid = app.tokens.operator;
  const stranger = await createAccessSigner();
  const forged = await stranger.sign({ email: OPERATOR_EMAIL }, { now: app.clock() });
  const wrongAudience = await app.signer.sign({ email: OPERATOR_EMAIL }, { now: app.clock(), audience: ['another-app'] });
  const wrongIssuer = await app.signer.sign({ email: OPERATOR_EMAIL }, { now: app.clock(), issuer: 'https://other.cloudflareaccess.com' });
  const expired = await app.signer.sign({ email: OPERATOR_EMAIL }, { now: new Date(app.clock().getTime() - 7_200_000) });

  const attempts = [
    { name: 'no credentials', headers: {} },
    { name: 'email header only', headers: { 'cf-access-authenticated-user-email': OPERATOR_EMAIL } },
    { name: 'cookie only', headers: { cookie: `CF_Authorization=${valid}` } },
    { name: 'bearer only', headers: { authorization: `Bearer ${valid}` } },
    { name: 'forged signature', headers: { 'cf-access-jwt-assertion': forged } },
    { name: 'wrong audience', headers: { 'cf-access-jwt-assertion': wrongAudience } },
    { name: 'wrong issuer', headers: { 'cf-access-jwt-assertion': wrongIssuer } },
    { name: 'expired', headers: { 'cf-access-jwt-assertion': expired } },
    { name: 'garbage', headers: { 'cf-access-jwt-assertion': 'not-a-jwt' } },
  ];
  for (const path of ['/api/health', '/api/me', '/api/channels', '/api/does-not-exist']) {
    for (const attempt of attempts) {
      const response = await httpRequest(app.url, path, { headers: attempt.headers });
      assert.equal(response.status, 401, `${path} with ${attempt.name}`);
      assert.equal(response.body.error, 'unauthenticated');
      assert.equal(response.headers['cache-control'], 'no-store');
      assertSecurityHeaders(response);
    }
  }
  const health = await httpRequest(app.url, '/api/health', { headers: { 'cf-access-jwt-assertion': valid } });
  assert.equal(health.status, 200);
  assert.equal(app.logs.join('\n').includes(valid), false, 'tokens are never logged');
});

test('/api/health accepts any valid Access identity and reports runtime facts only', async t => {
  const app = await startTestApp(t, { env: { NEWS_BUILD_VERSION: '9.9.9-test' } });
  for (const as of ['operator', 'viewer', 'unmapped', 'serviceUnmapped']) {
    const response = await app.api('/api/health', { as });
    assert.equal(response.status, 200, as);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const { body } = await app.api('/api/health', { as: 'serviceUnmapped' });
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '9.9.9-test');
  assert.equal(body.time, '2026-10-03T08:00:00.000Z');
  assert.equal(body.channelCount, 1, 'telegram-main is seeded');
  assert.equal(body.runtime.active, true);
  assert.equal(body.runtime.leaseHolder.self, true);
  assert.match(body.runtime.leaseHolder.id, /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(body).includes('api-test-owner'), false, 'the raw owner id is not exposed');
});

test('/api/me returns the identity and role; unmapped identities are forbidden', async t => {
  const app = await startTestApp(t);
  assert.deepEqual((await app.api('/api/me', { as: 'operator' })).body, { identity: { type: 'user', email: OPERATOR_EMAIL }, role: 'operator' });
  assert.deepEqual((await app.api('/api/me', { as: 'viewer' })).body.role, 'viewer');
  assert.deepEqual((await app.api('/api/me', { as: 'serviceOperator' })).body, {
    identity: { type: 'service', clientId: SERVICE_OPERATOR_ID },
    role: 'operator',
  });
  for (const as of ['unmapped', 'serviceUnmapped']) {
    const response = await app.api('/api/me', { as });
    assert.equal(response.status, 403, as);
    assert.equal(response.body.error, 'forbidden');
  }
  const noIdentity = await app.signer.sign({ sub: 'no-email-or-common-name' }, { now: app.clock() });
  assert.equal((await app.api('/api/health', { as: noIdentity })).status, 200);
  assert.equal((await app.api('/api/me', { as: noIdentity })).status, 403);
});

test('viewers read everything but every mutation needs the operator role', async t => {
  const app = await startTestApp(t);
  for (const path of ['/api/channels', '/api/channels/telegram-main', '/api/channels/telegram-main/status', '/api/channels/telegram-main/queue',
    '/api/channels/telegram-main/unresolved', '/api/channels/telegram-main/runs', '/api/credentials', '/api/content',
    '/api/stats?from=2026-10-01T00:00:00Z&to=2026-10-04T00:00:00Z']) {
    for (const as of ['viewer', 'serviceViewer', 'operator']) {
      assert.equal((await app.api(path, { as })).status, 200, `${as} GET ${path}`);
    }
    for (const as of ['unmapped', 'serviceUnmapped']) {
      assert.equal((await app.api(path, { as })).status, 403, `${as} GET ${path}`);
    }
  }

  const mutations = [
    ['POST', '/api/channels', channelInput({}, { id: 'viewer-channel' })],
    ['PUT', '/api/channels/telegram-main', { version: 1, name: 'Hijacked' }],
    ['DELETE', '/api/channels/telegram-main', { expectedVersion: 1 }],
    ['POST', '/api/credentials', { label: 'x', kind: 'ai_api_key', value: 'viewer-should-not-store-this' }],
    ['PUT', '/api/credentials/any', { value: 'x' }],
    ['DELETE', '/api/credentials/any', {}],
    ['POST', '/api/channels/telegram-main/run', {}],
    ['POST', '/api/channels/telegram-main/preview', {}],
    ['POST', '/api/channels/telegram-main/control/resume', { idempotencyKey: 'k', expectedVersion: 2, reason: 'r' }],
  ];
  for (const [method, path, body] of mutations) {
    for (const as of ['viewer', 'serviceViewer', 'unmapped', 'serviceUnmapped']) {
      const response = await app.api(path, { as, method, body });
      assert.equal(response.status, 403, `${as} ${method} ${path}`);
      assert.equal(response.body.error, 'forbidden');
    }
  }
  assert.equal((await app.api('/api/channels', { as: 'operator' })).body.channels.length, 1);
  assert.equal((await app.api('/api/channels/telegram-main', { as: 'operator' })).body.name, 'Telegram Main');
  assert.equal((await app.api('/api/credentials', { as: 'operator' })).body.credentials.length, 0);
  assert.equal((await app.api('/api/channels/telegram-main/status', { as: 'operator' })).body.paused, true);
  assert.equal(app.plugins.ai.calls.length, 0);
});

test('a mapped service token operator can mutate and is audited as service:<clientId>', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api, 'serviceOperator');
  const created = await app.api('/api/channels', { as: 'serviceOperator', method: 'POST', body: channelInput(ids) });
  assert.equal(created.status, 201);
  assert.equal(created.body.updatedBy, `service:${SERVICE_OPERATOR_ID}`);
  const credentials = (await app.api('/api/credentials', { as: 'viewer' })).body.credentials;
  assert.ok(credentials.every(credential => credential.updatedBy === `service:${SERVICE_OPERATOR_ID}`));
});

test('mutations need the exact public origin and a JSON content type', async t => {
  const app = await startTestApp(t);
  const body = { label: 'Bot', kind: 'telegram_bot_token', value: '111:origin-test-token' };
  const missingOrigin = await app.api('/api/credentials', { as: 'operator', method: 'POST', body, origin: null });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.error, 'same_origin_required');
  for (const origin of ['https://evil.example', 'http://radar.example.test', `${PUBLIC_ORIGIN}:8443`, 'null']) {
    const response = await app.api('/api/credentials', { as: 'operator', method: 'POST', body, origin });
    assert.equal(response.status, 403, origin);
  }
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const response = await app.api('/api/credentials', { as: 'operator', method: 'POST', rawBody: JSON.stringify(body), contentType });
    assert.equal(response.status, 415, contentType);
    assert.equal(response.body.error, 'unsupported_media_type');
  }
  const noContentType = await app.api('/api/credentials', { as: 'operator', method: 'POST', rawBody: JSON.stringify(body), contentType: null });
  assert.equal(noContentType.status, 415);
  assert.equal((await app.api('/api/credentials', { as: 'viewer' })).body.credentials.length, 0, 'nothing was stored');

  const accepted = await app.api('/api/credentials', { as: 'operator', method: 'POST', body, contentType: 'application/json; charset=utf-8' });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers['cache-control'], 'no-store');
});

test('JSON bodies are limited to 8 KB, except channel create/update at 64 KB', async t => {
  const app = await startTestApp(t);
  const ids = await createCredentialsViaApi(app.api);

  const credential = await app.api('/api/credentials', {
    as: 'operator', method: 'POST', body: { label: 'Big', kind: 'ai_api_key', value: 'k'.repeat(9_000) },
  });
  assert.equal(credential.status, 413);
  assert.equal(credential.body.error, 'payload_too_large');
  const control = await app.api('/api/channels/telegram-main/control/pause', {
    as: 'operator', method: 'POST', body: { idempotencyKey: 'big', expectedVersion: 2, reason: 'r'.repeat(9_000) },
  });
  assert.equal(control.status, 413);

  // A maximal 8,000-character system prompt of accented Vietnamese is up to ~24 KB of
  // UTF-8 (3 bytes per accented letter): above the 8 KB default, within 64 KB.
  const prompt = `Viết bản tin ngắn gọn về công nghệ. ${'ệ'.repeat(8_000)}`.slice(0, 8_000);
  const body = channelInput(ids, {
    id: 'long-prompt',
    prompt: { language: 'vi', style: 'digest', audience: 'IT', customSystemPrompt: prompt },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 16 * 1024);
  const created = await app.api('/api/channels', { as: 'operator', method: 'POST', body });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.prompt.customSystemPrompt, prompt.trim());
  const updated = await app.api('/api/channels/long-prompt', {
    as: 'operator', method: 'PUT', body: { version: 1, prompt: { ...body.prompt, customSystemPrompt: `${prompt.slice(0, 7_990)} cập nhật` } },
  });
  assert.equal(updated.status, 200, updated.text);

  const tooLarge = await app.api('/api/channels', {
    as: 'operator', method: 'POST', body: channelInput(ids, { id: 'too-large', name: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
});

test('malformed JSON and undecodable paths are 400s that echo nothing', async t => {
  const app = await startTestApp(t);
  const response = await app.api('/api/channels', { as: 'operator', method: 'POST', rawBody: '{"id": "half-open-secret-marker' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_json');
  assert.equal(response.text.includes('half-open-secret-marker'), false);
  assert.equal(app.logs.join('\n').includes('half-open-secret-marker'), false);

  const undecodable = await app.api('/api/channels/%E0%A4%A', { as: 'viewer' });
  assert.equal(undecodable.status, 400);
  assert.equal(undecodable.body.error, 'bad_request');
  assert.equal(app.logs.some(line => line.includes('failed:')), false, 'client errors are not logged as failures');
});

test('the UI and its SPA fallback are served only with a valid token and role', async t => {
  const webDir = await mkdtemp(join(tmpdir(), 'content-radar-web-'));
  t.after(() => rm(webDir, { recursive: true, force: true }));
  await writeWebBuild(webDir);
  const app = await startTestApp(t, { webDir });

  for (const path of ['/', '/index.html', '/channels/telegram-main', '/assets/app.js']) {
    const response = await httpRequest(app.url, path);
    assert.equal(response.status, 401, path);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.match(response.text, /Chưa xác thực/);
    assert.equal(response.text.includes(UI_MARKER) || response.text.includes('console.log'), false, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assertSecurityHeaders(response);
  }
  for (const as of ['unmapped', 'serviceUnmapped']) {
    const response = await app.api('/', { as });
    assert.equal(response.status, 403, as);
    assert.equal(response.text.includes(UI_MARKER), false);
  }

  const index = await app.api('/', { as: 'viewer' });
  assert.equal(index.status, 200);
  assert.ok(index.text.includes(UI_MARKER));
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['cache-control'], 'private, no-cache');
  assertSecurityHeaders(index);
  const clientRoute = await app.api('/channels/telegram-main/settings', { as: 'operator' });
  assert.equal(clientRoute.status, 200);
  assert.ok(clientRoute.text.includes(UI_MARKER), 'client-side routes fall back to index.html');
  const asset = await app.api('/assets/app.js', { as: 'viewer' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.headers['cache-control'], 'private, no-cache');
  assert.equal((await app.api('/assets/missing.js', { as: 'viewer' })).status, 404);
  assert.equal((await app.api('/.env', { as: 'viewer' })).status, 404);
  assert.notEqual((await app.api('/assets/..%2f..%2fpackage.json', { as: 'viewer' })).status, 200);
  assert.equal((await app.api('/', { as: 'operator', method: 'POST' })).status, 404);

  const unknownApi = await app.api('/api/does-not-exist', { as: 'viewer' });
  assert.equal(unknownApi.status, 404);
  assert.deepEqual(unknownApi.body, { error: 'not_found', message: 'Không tìm thấy.' });
  const upperCase = await httpRequest(app.url, '/API/channels');
  assert.equal(upperCase.status, 401, 'case variants of /api are authenticated like /api');
  assert.equal(upperCase.body.error, 'unauthenticated');
  assert.equal(upperCase.headers['cache-control'], 'no-store');
});

test('without a web build the UI answers 503 while the API keeps working', async t => {
  const app = await startTestApp(t);
  const ui = await app.api('/channels', { as: 'viewer' });
  assert.equal(ui.status, 503);
  assert.match(ui.text, /UI chưa được build/);
  assertSecurityHeaders(ui);
  assert.equal((await httpRequest(app.url, '/')).status, 401, 'the 503 page itself is behind authentication');
  assert.equal((await app.api('/api/channels', { as: 'viewer' })).status, 200);
});
