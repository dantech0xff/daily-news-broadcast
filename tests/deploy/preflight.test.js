import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAKE,
  FAKE_SECRETS,
  createFakePlatform,
  deployEnv,
  dokployOpenApi,
  isMutating,
  runScript,
  seedApplication,
  seedProject,
} from './helpers/fake-platform.js';

function assertNoSecrets(text) {
  for (const secret of FAKE_SECRETS) assert.equal(text.includes(secret), false, 'a secret value was printed');
}

test('preflight passes on a ready account with read-only calls only', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.match(result.stdout, /Dokploy v0\.30\.8/);
  assert.match(result.stdout, /every procedure and field the deploy uses/);
  assert.match(result.stdout, /Swarm stop grace period field, "stopGracePeriodSwarm" \(integer\)/);
  assert.match(result.stdout, /team domain radar-team\.cloudflareaccess\.com/);
  assert.match(result.stdout, /Service token "content-radar-agent" \(id 5b0e4c3a-0000-4000-8000-000000000001\) exists/);
  assert.match(result.stdout, /No blockers/);
  // Every API call is authenticated, and redirects are never followed.
  for (const call of result.calls) assert.equal(call.redirect, 'error');
  assert.ok(result.calls.every(call => call.service !== 'dokploy' || call.headers['x-api-key'] === FAKE.dokployApiKey));
  assertNoSecrets(result.output);
});

test('preflight reports Dokploy API drift precisely as blockers', async () => {
  const platform = createFakePlatform({
    openApi: dokployOpenApi({
      omit: ['mounts.create'],
      require: { 'application.saveEnvironment': ['buildPath'] },
      removeFields: { 'application.update': ['args'] },
    }),
  });
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] Dokploy API drift: mounts\.create is missing \(the deploy calls POST \/api\/mounts\.create\)/);
  assert.match(result.stderr, /\[blocker\] Dokploy API drift: application\.saveEnvironment requires "buildPath", which the deploy does not send/);
  assert.match(result.stderr, /\[blocker\] Dokploy API drift: application\.update has no field "args"/);
  assert.match(result.stdout, /3 blockers/);
  assert.deepEqual(result.calls.filter(isMutating), []);
});

test('a method change and a newly required nested Swarm field are drift too', async () => {
  const openApi = dokployOpenApi();
  openApi.paths['/deployment.all'] = { post: openApi.paths['/deployment.all'].get };
  const update = openApi.paths['/application.update'].post.requestBody.content['application/json'].schema;
  update.properties.updateConfigSwarm.properties.FailureAction = { type: 'string' };
  update.properties.updateConfigSwarm.required.push('FailureAction');
  const result = await runScript(['preflight'], { platform: createFakePlatform({ openApi }) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /deployment\.all is served with POST, but the deploy calls it with GET/);
  assert.match(result.stderr, /application\.update requires "updateConfigSwarm\.FailureAction"/);
});

test('a missing Zero Trust organization is a human-action blocker', async () => {
  const result = await runScript(['preflight'], { platform: createFakePlatform({ organization: null }) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] Human action needed: no usable Zero Trust organization/);
  assert.match(result.stderr, /payment details are required even for the Free plan/);
  assertNoSecrets(result.output);
});

test('preflight blocks an old Dokploy, a missing service token, and a hostname outside the zone', async () => {
  const platform = createFakePlatform({ dokployVersion: 'v0.29.4', serviceTokens: [] });
  const result = await runScript(['preflight'], { platform, env: deployEnv({ APP_HOSTNAME: 'radar.other.test' }) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Dokploy is v0\.29\.4; the deploy needs v0\.29\.5 or later/);
  assert.match(result.stderr, /No Access service token has CF_ACCESS_CLIENT_ID as its client ID/);
  assert.match(result.stderr, /APP_HOSTNAME radar\.other\.test is not in zone example\.test/);
});

test('an expired service token and an existing Traefik domain are blockers', async () => {
  const platform = createFakePlatform({
    serviceTokens: [{ id: FAKE.serviceTokenId, name: 'old-agent', client_id: FAKE.clientId, expires_at: '2026-09-01T00:00:00Z' }],
  });
  const environmentId = seedProject(platform);
  seedApplication(platform, {
    name: 'content-radar', appName: 'content-radar', environmentId, domains: [{ domainId: 'd1', host: 'radar.example.test' }],
  });
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Service token "old-agent" .* expired at 2026-09-01T00:00:00\.000Z/);
  assert.match(result.stderr, /has Traefik domain radar\.example\.test, which would expose it without Access/);
});

test('an existing DNS record that is not the tunnel is a blocker', async () => {
  const platform = createFakePlatform({
    dnsRecords: [{ id: 'dns-1', type: 'CNAME', name: FAKE.hostname, content: 'old-host.example.net', proxied: true }],
  });
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DNS already has CNAME old-host\.example\.net \(proxied\) for radar\.example\.test/);
});

test('a token that cannot read zone details only skips the zone check', async () => {
  const result = await runScript(['preflight'], { platform: createFakePlatform({ zoneReadable: false }) });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stderr, /\[warn\] CF_API_TOKEN cannot read the details of zone CF_ZONE_ID \(add "Zone: Read" to enable this check\)/);
  assert.match(result.stdout, /No DNS record for radar\.example\.test yet/);
});

test('a locally managed tunnel with the same name is a blocker', async () => {
  const platform = createFakePlatform();
  platform.cloudflare.tunnels.push({ id: 'local-tunnel', name: 'content-radar', config_src: 'local', remote_config: false, deleted_at: null });
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Tunnel "content-radar" is managed by a local config file/);
});

test('an unreachable Dokploy API is reported without its key', async () => {
  const platform = createFakePlatform();
  const fetch = platform.fetch;
  platform.fetch = async (input, init) => {
    if (String(input).startsWith(FAKE.dokployUrl)) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return fetch(input, init);
  };
  const result = await runScript(['preflight'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot use the Dokploy API at DOKPLOY_URL: Dokploy GET settings\.getDokployVersion failed: request failed \(ECONNREFUSED\)/);
  assertNoSecrets(result.output);
});

test('a rejected Cloudflare token stops the Cloudflare checks', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['preflight'], { platform, env: deployEnv({ CF_API_TOKEN: 'wrong-token-value-123' }) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cloudflare rejected CF_API_TOKEN: Cloudflare GET \/user\/tokens\/verify failed with HTTP 401: 10000 Authentication error/);
  assert.equal(result.output.includes('wrong-token-value-123'), false);
  assert.equal(result.calls.filter(call => call.service === 'cloudflare').length, 2, 'no further Cloudflare calls after the token is rejected');
});

test('configuration problems name variables only', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['preflight'], {
    platform,
    env: deployEnv({ APP_HOSTNAME: 'https://radar.example.test/path', CF_ZONE_ID: 'not-hex', APP_OPERATOR_EMAILS: 'ops@example.test,not an email' }),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /APP_HOSTNAME must be a fully qualified hostname/);
  assert.match(result.stderr, /CF_ZONE_ID must be a 32-character hexadecimal Cloudflare ID/);
  assert.match(result.stderr, /APP_OPERATOR_EMAILS entry #2 is not a plain email address/);
  assert.equal(result.stderr.includes('not an email'), false);
  assert.deepEqual(result.calls, []);
});

test('flags are checked per command', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['preflight', '--dry-run'], { platform });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--dry-run is not an option of the preflight command/);
  const unpinned = await runScript(['deploy', '--cloudflared-image', 'cloudflare/cloudflared:latest'], { platform });
  assert.equal(unpinned.code, 2);
  assert.match(unpinned.stderr, /--cloudflared-image must be a pinned image reference/);
  assert.deepEqual([...result.calls, ...unpinned.calls], []);
});
