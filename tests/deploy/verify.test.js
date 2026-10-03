import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { classifyAnonymousResponse, classifyOriginProbe, probeOriginHttp } from '../../scripts/deploy/verify.mjs';
import {
  FAKE,
  FAKE_SECRETS,
  createFakePlatform,
  defaultAppResponder,
  deployEnv,
  runScript,
} from './helpers/fake-platform.js';

const SPA_HTML = '<!doctype html><html lang="vi"><head><title>Content Radar</title></head><body><div id="root"></div></body></html>';
const APP_401_JSON = JSON.stringify({ error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' });
const APP_401_HTML = '<!doctype html><title>Chưa xác thực</title><p>Cần đăng nhập qua Cloudflare Access.</p>';
const url = `https://${FAKE.hostname}/`;

function assertNoSecrets(text) {
  for (const secret of FAKE_SECRETS) assert.equal(text.includes(secret), false, 'a secret value was printed');
}

async function deployed() {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  return platform;
}

test('anonymous answers: an Access redirect or denial passes, anything from the app fails', () => {
  const cases = [
    [{ url, status: 302, location: `https://${FAKE.authDomain}/cdn-cgi/access/login/${FAKE.hostname}?kid=1&redirect_url=%2F` }, 'pass', 'access_redirect'],
    [{ url, status: 302, location: '/cdn-cgi/access/login?redirect_url=%2F' }, 'pass', 'access_redirect'],
    [{ url, status: 403, contentType: 'text/html', body: '<html><title>Forbidden</title>You do not have access.</html>' }, 'pass', 'access_denied'],
    [{ url, status: 401, contentType: 'text/plain', body: '' }, 'pass', 'access_denied'],
    [{ url, status: 200, contentType: 'text/html', body: SPA_HTML }, 'fail', 'app_content'],
    [{ url: `${url}api/health`, status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', runtime: { leased: true }, channelCount: 1 }) }, 'fail', 'app_content'],
    [{ url: `${url}api/health`, status: 401, contentType: 'application/json', body: APP_401_JSON }, 'fail', 'reached_app'],
    [{ url, status: 401, contentType: 'text/html', body: APP_401_HTML }, 'fail', 'reached_app'],
    [{ url, status: 302, location: 'https://login.example.net/' }, 'fail', 'unexpected_redirect'],
    [{ url, status: 302, location: null }, 'fail', 'unexpected_redirect'],
    [{ url, status: 530, contentType: 'text/html', body: 'error code: 1033' }, 'fail', 'unexpected_status'],
    [{ url, error: 'request failed (ENOTFOUND)' }, 'fail', 'request_failed'],
  ];
  for (const [response, verdict, kind] of cases) {
    const result = classifyAnonymousResponse(response);
    assert.equal(result.verdict, verdict, `${kind}: ${result.detail}`);
    assert.equal(result.kind, kind);
  }
  // The query string of the login redirect is not repeated in the detail.
  assert.equal(classifyAnonymousResponse(cases[0][0]).detail.includes('redirect_url'), false);
});

test('origin probe: Traefik 404 or no listener passes; the app or the Cloudflare edge fails', () => {
  const address = FAKE.originIp;
  const traefik = classifyOriginProbe({ address, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '404 page not found\n' });
  assert.deepEqual([traefik.verdict, traefik.kind], ['pass', 'traefik_404']);
  assert.equal(classifyOriginProbe({ address, error: 'ECONNREFUSED' }).verdict, 'pass');
  assert.equal(classifyOriginProbe({ address, error: 'ETIMEDOUT' }).kind, 'unreachable');
  assert.equal(classifyOriginProbe({ address, status: 401, headers: { 'content-type': 'text/html' }, body: APP_401_HTML }).kind, 'reached_app');
  assert.equal(classifyOriginProbe({ address, status: 200, headers: {}, body: SPA_HTML }).kind, 'reached_app');
  assert.equal(classifyOriginProbe({ address, status: 403, headers: { server: 'cloudflare', 'cf-ray': 'abc' }, body: '' }).kind, 'cloudflare_edge');
  assert.equal(classifyOriginProbe({ address, status: 200, headers: {}, body: 'Dokploy' }).kind, 'unexpected');
  assert.equal(classifyOriginProbe({ address, error: 'EPROTO' }).kind, 'probe_failed');
});

test('verify passes on a protected deployment and sends the service token only to the app', async () => {
  const platform = await deployed();
  const probes = [];
  const result = await runScript(['verify'], {
    platform,
    probeOrigin: async options => {
      probes.push(options);
      return { address: options.address, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '404 page not found\n' };
    },
    lookup: async hostname => {
      assert.equal(hostname, 'dokploy.example.test');
      return FAKE.originIp;
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /\[ok\] anonymous GET \/: HTTP 302 to the Access login \(radar-team\.cloudflareaccess\.com\/cdn-cgi\/access\/login\)/);
  assert.match(result.stdout, /\[ok\] anonymous GET \/api\/health: HTTP 302/);
  assert.match(result.stdout, /\[ok\] GET \/api\/health with the service token: HTTP 200, runtime leased by this instance, channelCount 1/);
  assert.match(result.stdout, /\[ok\] GET \/api\/channels\/telegram-main\/status with the service token: paused, cutoverRequired, no cutover mark yet/);
  assert.match(result.stdout, /\[ok\] GET http:\/\/203\.0\.113\.10\/ with Host: radar\.example\.test: Traefik's "404 page not found"/);
  assert.match(result.stdout, /\[ok\] no Traefik domain or published port: none/);
  assert.match(result.stdout, /\[ok\] one replica, stop-first updates: replicas 1, Order stop-first/);
  assert.match(result.stdout, /7 passed, 0 failed/);
  assert.deepEqual(probes, [{ address: FAKE.originIp, port: 80, hostHeader: FAKE.hostname, path: '/', timeoutMs: 10_000 }]);

  const appCalls = result.calls.filter(call => call.service === 'app');
  assert.equal(appCalls.length, 4);
  for (const call of appCalls) assert.equal(call.redirect, 'manual', 'redirects are never followed with the service token');
  const anonymous = appCalls.slice(0, 2);
  for (const call of anonymous) assert.equal('cf-access-client-secret' in call.headers, false);
  for (const call of appCalls.slice(2)) assert.equal(call.headers['cf-access-client-secret'], FAKE.clientSecret);
  for (const call of result.calls.filter(entry => entry.service !== 'app')) {
    assert.equal(JSON.stringify(call.headers).includes(FAKE.clientSecret), false, 'the service token secret goes only to the app');
  }
  assert.deepEqual(result.calls.filter(call => call.method !== 'GET'), []);
  assertNoSecrets(result.output);
});

test('with DOKPLOY_BEHIND_ACCESS the service token also reaches Dokploy, never the Cloudflare API', async () => {
  const env = deployEnv({ DOKPLOY_BEHIND_ACCESS: 'true' });
  const platform = createFakePlatform();
  const deploy = await runScript(['deploy'], { platform, env });
  assert.equal(deploy.code, 0, deploy.output);
  const result = await runScript(['verify'], {
    platform,
    env,
    probeOrigin: async options => ({ address: options.address, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '404 page not found\n' }),
    lookup: async () => FAKE.originIp,
  });
  assert.equal(result.code, 0, result.output);
  for (const run of [deploy, result]) {
    const dokployCalls = run.calls.filter(call => call.service === 'dokploy');
    assert.ok(dokployCalls.length > 0);
    for (const call of dokployCalls) assert.equal(call.headers['cf-access-client-secret'], FAKE.clientSecret);
    for (const call of run.calls.filter(entry => entry.service !== 'app' && entry.service !== 'dokploy')) {
      assert.equal(JSON.stringify(call.headers).includes(FAKE.clientSecret), false, 'the service token secret never goes to the Cloudflare API');
    }
    assertNoSecrets(run.output);
  }
});

test('DOKPLOY_BEHIND_ACCESS without the service token secret is refused before any call', async () => {
  const env = deployEnv({ DOKPLOY_BEHIND_ACCESS: 'true', CF_ACCESS_CLIENT_SECRET: '' });
  const result = await runScript(['preflight'], { platform: createFakePlatform(), env });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /DOKPLOY_BEHIND_ACCESS=true needs CF_ACCESS_CLIENT_SECRET/);
  assert.deepEqual(result.calls, []);
});

test('verify fails when the app answers anonymous requests or the origin serves it', async () => {
  const platform = await deployed();
  const leaky = createFakePlatform({
    appResponder: request => (request.headers['cf-access-client-id']
      ? defaultAppResponder(request)
      : new Response(SPA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })),
  });
  // Reuse the deployed Dokploy state with the leaky app.
  Object.assign(leaky.dokploy, platform.dokploy);
  const result = await runScript(['verify'], {
    platform: leaky,
    probeOrigin: async ({ address }) => ({ address, status: 401, headers: { 'content-type': 'text/html' }, body: APP_401_HTML }),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] anonymous GET \/: HTTP 200 with app content, served without Access/);
  assert.match(result.stderr, /\[fail\] GET http:\/\/203\.0\.113\.10\/ with Host: radar\.example\.test: HTTP 401 from the app/);
  assert.match(result.stdout, /3 failed/);
});

test('verify reports a rejected service token and a channel that is not paused', async () => {
  const platform = createFakePlatform({
    appResponder: request => {
      if (request.path === '/api/channels/telegram-main/status' && request.headers['cf-access-client-id']) {
        return new Response(JSON.stringify({ paused: false, cutoverRequired: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return defaultAppResponder(request);
    },
  });
  const wrongSecret = await runScript(['verify'], { platform, env: deployEnv({ CF_ACCESS_CLIENT_SECRET: 'wrong-secret-value-0005' }) });
  assert.equal(wrongSecret.code, 1);
  assert.match(wrongSecret.stderr, /\[fail\] GET \/api\/health with the service token: HTTP 302 redirect to radar-team\.cloudflareaccess\.com \(the service token was not accepted\)/);
  assert.equal(wrongSecret.output.includes('wrong-secret-value-0005'), false);

  const resumed = await runScript(['verify'], { platform });
  assert.match(resumed.stderr, /\[fail\] GET \/api\/channels\/telegram-main\/status with the service token: paused=false, cutoverRequired=true/);
  // No Dokploy application yet: reported, not thrown.
  assert.match(resumed.stderr, /\[fail\] Dokploy application: application "content-radar" not found/);
});

test('--redeploy-check confirms the data survives and a single instance runs', async () => {
  const platform = await deployed();
  const result = await runScript(['verify', '--redeploy-check'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = [...platform.dokploy.applications.values()].find(app => app.name === 'content-radar').applicationId;
  assert.deepEqual(result.calls.filter(call => call.method !== 'GET').map(call => [call.target, call.body.applicationId]), [['application.redeploy', mainId]]);
  assert.match(result.stdout, /\[ok\] app back after redeploy: a new instance answers and holds the runtime lease/);
  assert.match(result.stdout, /\[ok\] telegram-main kept across the redeploy: same createdAt 2026-10-03T08:00:00\.000Z/);
  assert.match(result.stdout, /\[ok\] a single running instance: 5 health answers from the lease holder, replicas 1/);
  assert.match(result.stdout, /10 passed, 0 failed/);
});

test('--redeploy-check does not mistake the old instance for the restarted one', async () => {
  const platform = await deployed();
  const stuck = createFakePlatform({
    appResponder: request => {
      if (request.path === '/api/health' && request.headers['cf-access-client-id']) {
        return new Response(JSON.stringify({
          status: 'ok', runtime: { leased: true, leaseHolder: { id: 'old-instance', self: true } }, channelCount: 1,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return defaultAppResponder(request);
    },
  });
  Object.assign(stuck.dokploy, platform.dokploy);
  const result = await runScript(['verify', '--redeploy-check'], { platform: stuck });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] app back after redeploy: no new instance holding the lease after 5 min/);
  assert.equal(result.stdout.includes('kept across the redeploy'), false, 'data is not compared against the old instance');
});

test('--redeploy-check fails when the channel was seeded again or two instances answer', async () => {
  const platform = await deployed();
  let healthAnswers = 0;
  const reseeding = createFakePlatform({
    onRequest(call, fake) {
      if (call.target === 'application.redeploy') fake.app.channelCreatedAt = '2026-10-04T00:00:00.000Z';
    },
    appResponder: request => {
      if (request.path === '/api/health' && request.headers['cf-access-client-id']) {
        healthAnswers += 1;
        // Every other answer comes from an instance that does not hold the lease.
        if (healthAnswers > 2 && healthAnswers % 2 === 0) {
          return new Response(JSON.stringify({
            status: 'ok', runtime: { leased: false, leaseHolder: { id: 'a1b2c3d4', self: false } }, channelCount: 1,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
      return defaultAppResponder(request);
    },
  });
  Object.assign(reseeding.dokploy, platform.dokploy);
  const result = await runScript(['verify', '--redeploy-check'], { platform: reseeding });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] telegram-main kept across the redeploy: createdAt changed to 2026-10-04T00:00:00\.000Z \(re-seeded\)/);
  assert.match(result.stderr, /\[fail\] a single running instance: .*some from an instance without the lease/);
});

test('--origin-ip overrides the DNS lookup of the Dokploy host', async () => {
  const platform = await deployed();
  const probes = [];
  const result = await runScript(['verify', '--origin-ip', '198.51.100.20'], {
    platform,
    lookup: async () => assert.fail('the lookup must not run when --origin-ip is given'),
    probeOrigin: async options => {
      probes.push(options.address);
      return { address: options.address, status: 403, headers: { server: 'cloudflare', 'cf-ray': '1' }, body: '' };
    },
  });
  assert.deepEqual(probes, ['198.51.100.20']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /198\.51\.100\.20 is a Cloudflare address, not the server; pass --origin-ip <server IP>/);
});

test('probeOriginHttp sends the requested Host header (fetch would not)', async t => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.host);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 page not found\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const result = await probeOriginHttp({ address: '127.0.0.1', port, hostHeader: FAKE.hostname, path: '/', timeoutMs: 5_000 });
  assert.deepEqual(seen, [FAKE.hostname]);
  assert.equal(result.status, 404);
  assert.equal(classifyOriginProbe(result).kind, 'traefik_404');

  const closed = await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: freePort } = probe.address();
      probe.close(() => resolve(freePort));
    });
  });
  const refused = await probeOriginHttp({ address: '127.0.0.1', port: closed, hostHeader: FAKE.hostname, path: '/', timeoutMs: 5_000 });
  assert.equal(refused.error, 'ECONNREFUSED');
});
