import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { classifyAnonymousResponse, classifyOriginProbe, probeOriginHttps } from '../../scripts/deploy/verify.mjs';
import {
  APP_401_JSON,
  FAKE,
  FAKE_SECRETS,
  appDomain,
  createFakePlatform,
  defaultAppResponder,
  defaultOriginProbe,
  deployEnv,
  runScript,
  showsAddress,
} from './helpers/fake-platform.js';

const SPA_HTML = '<!doctype html><html lang="vi"><head><title>Content Radar</title></head><body><div id="root"></div></body></html>';
const APP_401_HTML = '<!doctype html><title>Chưa xác thực</title><p>Cần đăng nhập qua Cloudflare Access.</p>';
const HEALTH_JSON = JSON.stringify({ status: 'ok', runtime: { leased: true }, channelCount: 1 });
const url = `https://${FAKE.hostname}/`;
const mainApp = platform => [...platform.dokploy.applications.values()].find(app => app.name === 'content-radar');
const execFileAsync = promisify(execFile);

function assertNoSecrets(text) {
  for (const secret of FAKE_SECRETS) assert.equal(text.includes(secret), false, 'a secret value was printed');
  assert.equal(showsAddress(text), false, 'the origin address was printed');
}

async function deployed() {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  return platform;
}

// A key and a certificate that no public CA signed, like the origin's Cloudflare Origin CA certificate.
async function untrustedCertificate(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'key.pem');
  const certFile = join(directory, 'cert.pem');
  try {
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=origin-ca-stand-in']);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}

test('anonymous answers: an Access redirect or denial passes, anything from the app fails', () => {
  const cases = [
    [{ url, status: 302, location: `https://${FAKE.authDomain}/cdn-cgi/access/login/${FAKE.hostname}?kid=1&redirect_url=%2F` }, 'pass', 'access_redirect'],
    [{ url, status: 302, location: '/cdn-cgi/access/login?redirect_url=%2F' }, 'pass', 'access_redirect'],
    [{ url, status: 403, contentType: 'text/html', body: '<html><title>Forbidden</title>You do not have access.</html>' }, 'pass', 'access_denied'],
    [{ url, status: 401, contentType: 'text/plain', body: '' }, 'pass', 'access_denied'],
    [{ url, status: 200, contentType: 'text/html', body: SPA_HTML }, 'fail', 'app_content'],
    [{ url: `${url}api/health`, status: 200, contentType: 'application/json', body: HEALTH_JSON }, 'fail', 'app_content'],
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

test('origin answers: the app\'s /healthz and its own 401 pass; app data, Traefik\'s 404, and a Cloudflare edge fail', () => {
  const text = { 'content-type': 'text/plain; charset=utf-8' };
  const json = { 'content-type': 'application/json; charset=utf-8' };
  const cases = [
    ['/healthz', { status: 200, headers: text, body: 'ok' }, 'pass', 'healthz'],
    ['/healthz', { status: 404, headers: text, body: '404 page not found\n' }, 'fail', 'no_route'],
    ['/healthz', { status: 502, headers: text, body: 'Bad Gateway' }, 'fail', 'unexpected'],
    ['/healthz', { status: 200, headers: { 'content-type': 'text/html' }, body: SPA_HTML }, 'fail', 'unexpected'],
    ['/api/health', { status: 401, headers: json, body: APP_401_JSON }, 'pass', 'jwt_required'],
    ['/api/health', { status: 200, headers: json, body: HEALTH_JSON }, 'fail', 'app_data'],
    ['/api/health', { status: 204, headers: {}, body: '' }, 'fail', 'app_data'],
    ['/api/health', { status: 401, headers: text, body: 'Unauthorized' }, 'fail', 'unexpected'],
    ['/api/health', { status: 404, headers: text, body: '404 page not found' }, 'fail', 'no_route'],
    ['/api/health', { status: 403, headers: { server: 'cloudflare', 'cf-ray': 'abc' }, body: '' }, 'fail', 'cloudflare_edge'],
    ['/healthz', { error: 'ECONNREFUSED' }, 'fail', 'probe_failed'],
    ['/api/health', { error: 'ETIMEDOUT' }, 'fail', 'probe_failed'],
  ];
  for (const [path, result, verdict, kind] of cases) {
    const classification = classifyOriginProbe(path, result);
    assert.equal(classification.verdict, verdict, `${path} ${kind}: ${classification.detail}`);
    assert.equal(classification.kind, kind);
  }
});

test('verify passes on a protected deployment, probes the origin as Cloudflare does, and never prints the address', async () => {
  const platform = await deployed();
  const probes = [];
  const result = await runScript(['verify'], {
    platform,
    probeOrigin: async options => {
      probes.push(options);
      return defaultOriginProbe(options);
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /\[ok\] anonymous GET \/: HTTP 302 to the Access login \(radar-team\.cloudflareaccess\.com\/cdn-cgi\/access\/login\)/);
  assert.match(result.stdout, /\[ok\] anonymous GET \/api\/health: HTTP 302/);
  assert.match(result.stdout, /\[ok\] GET \/api\/health with the service token: HTTP 200, runtime leased by this instance, channelCount 1/);
  assert.match(result.stdout, /\[ok\] GET \/api\/channels\/telegram-main\/status with the service token: paused, cutoverRequired, no cutover mark yet/);
  assert.match(result.stdout, /\[ok\] GET https:\/\/<origin-ip>\/healthz with SNI and Host radar\.example\.test: HTTP 200 "ok" from the app/);
  assert.match(result.stdout, /\[ok\] GET https:\/\/<origin-ip>\/api\/health with SNI and Host radar\.example\.test: HTTP 401 from the app's own Access JWT check/);
  assert.match(result.stdout, /\[ok\] radar\.example\.test is a proxied A record to <origin-ip>: A <origin-ip> \(proxied\)/);
  assert.match(result.stdout, /\[ok\] Traefik domain for radar\.example\.test: https:\/\/radar\.example\.test\/ → port 3000 \(certificateType none: Traefik's default certificate\)/);
  assert.match(result.stdout, /\[ok\] no published port: none/);
  assert.match(result.stdout, /\[ok\] one replica, stop-first updates: replicas 1, Order stop-first/);
  assert.match(result.stdout, /10 passed, 0 failed/);
  assert.deepEqual(probes, ['/healthz', '/api/health'].map(path => ({ address: FAKE.originIp, port: 443, hostname: FAKE.hostname, path, timeoutMs: 10_000 })));

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
  const result = await runScript(['verify'], { platform, env });
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

test('verify fails when the app answers anonymous requests or the origin serves app data without a JWT', async () => {
  const platform = await deployed();
  const leaky = createFakePlatform({
    appResponder: request => (request.headers['cf-access-client-id']
      ? defaultAppResponder(request)
      : new Response(SPA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })),
  });
  // Reuse the deployed Dokploy and Cloudflare state with the leaky app.
  Object.assign(leaky.dokploy, platform.dokploy);
  Object.assign(leaky.cloudflare, platform.cloudflare);
  const result = await runScript(['verify'], {
    platform: leaky,
    probeOrigin: async ({ path }) => (path === '/healthz'
      ? defaultOriginProbe({ path })
      : { status: 200, headers: { 'content-type': 'application/json' }, body: HEALTH_JSON }),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] anonymous GET \/: HTTP 200 with app content, served without Access/);
  assert.match(result.stderr, /\[fail\] GET https:\/\/<origin-ip>\/api\/health with SNI and Host radar\.example\.test: HTTP 200 with app data, served without an Access JWT/);
  assert.match(result.stdout, /7 passed, 3 failed/);
  assertNoSecrets(result.output);
});

test('verify fails on a different or missing Traefik domain, a published port, and DNS that is not the proxied origin', async () => {
  const platform = await deployed();
  const app = mainApp(platform);
  app.domains[0].certificateType = 'letsencrypt';
  app.domains.push(appDomain({ domainId: 'domain-other', host: 'other.example.test' }));
  app.ports.push({ portId: 'p1', publishedPort: 3000, targetPort: 3000 });
  platform.cloudflare.dnsRecords[0].proxied = false;
  const result = await runScript(['verify'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] Traefik domain for radar\.example\.test: differs in certificateType from https:\/\/radar\.example\.test\/ → port 3000/);
  assert.match(result.stderr, /\[warn\] Application "content-radar" also has Traefik domains for other hostnames \(other\.example\.test\); the deploy keeps them\./);
  assert.match(result.stderr, /\[fail\] no published port: published port 3000 → 3000/);
  assert.match(result.stderr, /\[fail\] radar\.example\.test is a proxied A record to <origin-ip>: A <origin-ip>$/m);
  assert.match(result.stdout, /7 passed, 3 failed/);

  app.domains.splice(0);
  platform.cloudflare.dnsRecords.splice(0);
  const none = await runScript(['verify'], { platform });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /\[fail\] Traefik domain for radar\.example\.test: none/);
  assert.match(none.stderr, /\[fail\] radar\.example\.test is a proxied A record to <origin-ip>: no DNS record/);
  assert.deepEqual([...result.calls, ...none.calls].filter(call => call.method !== 'GET'), []);
  for (const run of [result, none]) assertNoSecrets(run.output);
});

function channelStatusPlatform(status) {
  return createFakePlatform({
    appResponder: request => {
      if (request.path === '/api/channels/telegram-main/status' && request.headers['cf-access-client-id']) {
        return new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return defaultAppResponder(request);
    },
  });
}

test('verify reports a rejected service token and an active channel without its cutover mark', async () => {
  const platform = channelStatusPlatform({ paused: false, cutoverRequired: true, notBefore: null });
  const wrongSecret = await runScript(['verify'], { platform, env: deployEnv({ CF_ACCESS_CLIENT_SECRET: 'wrong-secret-value-0005' }) });
  assert.equal(wrongSecret.code, 1);
  assert.match(wrongSecret.stderr, /\[fail\] GET \/api\/health with the service token: HTTP 302 redirect to radar-team\.cloudflareaccess\.com \(the service token was not accepted\)/);
  assert.equal(wrongSecret.output.includes('wrong-secret-value-0005'), false);

  const unmarked = await runScript(['verify'], { platform });
  assert.match(unmarked.stderr, /\[fail\] GET \/api\/channels\/telegram-main\/status with the service token: paused=false, cutoverRequired=true, notBefore not set/);
  // No Dokploy application yet: reported, not thrown.
  assert.match(unmarked.stderr, /\[fail\] Dokploy application: application "content-radar" not found/);
});

test('verify accepts a channel resumed after the cutover', async () => {
  const platform = channelStatusPlatform({ paused: false, cutoverRequired: true, notBefore: '2026-10-03T14:03:41.986Z' });
  const result = await runScript(['verify'], { platform });
  assert.match(result.stdout, /\[ok\] GET \/api\/channels\/telegram-main\/status with the service token: active, posting only articles published after notBefore 2026-10-03T14:03:41\.986Z/);
});

test('--redeploy-check confirms the data survives and a single instance runs', async () => {
  const platform = await deployed();
  const result = await runScript(['verify', '--redeploy-check'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = mainApp(platform).applicationId;
  assert.deepEqual(result.calls.filter(call => call.method !== 'GET').map(call => [call.target, call.body.applicationId]), [['application.redeploy', mainId]]);
  assert.match(result.stdout, /\[ok\] app back after redeploy: a new instance answers and holds the runtime lease/);
  assert.match(result.stdout, /\[ok\] telegram-main kept across the redeploy: same createdAt 2026-10-03T08:00:00\.000Z/);
  assert.match(result.stdout, /\[ok\] a single running instance: 5 health answers from the lease holder, replicas 1/);
  assert.match(result.stdout, /13 passed, 0 failed/);
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

test('--origin-ip replaces ORIGIN_IP for the origin and DNS checks; a Cloudflare edge address fails', async () => {
  const platform = await deployed();
  const edge = '198.51.100.20';
  const probes = [];
  const result = await runScript(['verify', '--origin-ip', edge], {
    platform,
    env: deployEnv({ ORIGIN_IP: undefined }),
    probeOrigin: async options => {
      probes.push(options.address);
      return { status: 403, headers: { server: 'cloudflare', 'cf-ray': '1' }, body: '' };
    },
  });
  assert.deepEqual(probes, [edge, edge]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[fail\] GET https:\/\/<origin-ip>\/healthz with SNI and Host radar\.example\.test: a Cloudflare edge answered, not the VPS: set ORIGIN_IP \(or pass --origin-ip\) to the server address/);
  // The record points to the ORIGIN_IP of the deploy, not to the address given here.
  assert.match(result.stderr, /\[fail\] radar\.example\.test is a proxied A record to <origin-ip>: A <other address> \(proxied\)/);
  assert.equal(showsAddress(result.output, edge), false, 'the --origin-ip address is not printed either');
  assertNoSecrets(result.output);
});

test('verify needs ORIGIN_IP or an IPv4 --origin-ip, and the Cloudflare token for the DNS check', async () => {
  const platform = createFakePlatform();
  const missing = await runScript(['verify'], { platform, env: deployEnv({ ORIGIN_IP: '', CF_API_TOKEN: undefined, CF_ZONE_ID: undefined }) });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /\[blocker\] Missing environment variables: CF_API_TOKEN, CF_ZONE_ID, ORIGIN_IP\./);
  const invalid = await runScript(['verify', '--origin-ip', '2001:db8::1'], { platform });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /\[blocker\] --origin-ip must be the IPv4 address of the VPS\./);
  assert.equal(invalid.output.includes('2001:db8::1'), false);
  assert.deepEqual([...missing.calls, ...invalid.calls], []);
});

test('probeOriginHttps sends SNI and Host for the hostname and accepts a certificate no public CA signed', async t => {
  const tls = await untrustedCertificate(t);
  if (!tls) {
    t.skip('openssl is not installed, so no test certificate can be made');
    return;
  }
  const seen = [];
  const server = createHttpsServer(tls, (req, res) => {
    seen.push({ servername: req.socket.servername, host: req.headers.host, path: req.url });
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(APP_401_JSON);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const probe = path => probeOriginHttps({ address: '127.0.0.1', port, hostname: FAKE.hostname, path, timeoutMs: 5_000 });

  const healthz = await probe('/healthz');
  const api = await probe('/api/health');
  assert.deepEqual(seen, [
    { servername: FAKE.hostname, host: FAKE.hostname, path: '/healthz' },
    { servername: FAKE.hostname, host: FAKE.hostname, path: '/api/health' },
  ]);
  assert.deepEqual([healthz.status, healthz.body], [200, 'ok']);
  assert.equal(classifyOriginProbe('/healthz', healthz).kind, 'healthz');
  assert.equal(classifyOriginProbe('/api/health', api).kind, 'jwt_required');
});

test('probeOriginHttps reports a refused connection and a silent server as errors', async t => {
  const closed = await new Promise(resolve => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: freePort } = probe.address();
      probe.close(() => resolve(freePort));
    });
  });
  const refused = await probeOriginHttps({ address: '127.0.0.1', port: closed, hostname: FAKE.hostname, path: '/healthz', timeoutMs: 5_000 });
  assert.equal(refused.error, 'ECONNREFUSED');

  // Accepts the connection but never answers the TLS handshake.
  const sockets = new Set();
  const silent = createNetServer(socket => sockets.add(socket));
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    silent.close(resolve);
  }));
  const timedOut = await probeOriginHttps({ address: '127.0.0.1', port: silent.address().port, hostname: FAKE.hostname, path: '/healthz', timeoutMs: 200 });
  assert.equal(timedOut.error, 'ETIMEDOUT');
  assert.equal(classifyOriginProbe('/healthz', timedOut).kind, 'probe_failed');
});
