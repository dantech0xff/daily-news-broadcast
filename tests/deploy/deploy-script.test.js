import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvText } from '../../scripts/deploy/env-text.mjs';
import { parseMasterKey } from '../../src/app/secrets/vault.js';
import {
  FAKE,
  FAKE_SECRETS,
  createFakePlatform,
  deployEnv,
  dokployOpenApi,
  isCreate,
  isMutating,
  runScript,
  seedApplication,
  seedProject,
} from './helpers/fake-platform.js';

const indexOf = (calls, predicate) => calls.findIndex(predicate);
const appIdByName = (platform, name) => [...platform.dokploy.applications.values()].find(app => app.name === name)?.applicationId;
const dokployCalls = (calls, target) => calls.filter(call => call.service === 'dokploy' && call.target === target);

function assertNoSecrets(text, extra = []) {
  for (const secret of [...FAKE_SECRETS, ...extra]) {
    assert.equal(text.includes(secret), false, 'a secret value was printed or written');
  }
}

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('deploy creates everything in a safe order, and a second run creates nothing', async () => {
  const platform = createFakePlatform();
  const first = await runScript(['deploy'], { platform });
  assert.equal(first.code, 0, first.output);

  const { calls } = first;
  const mainId = appIdByName(platform, 'content-radar');
  const connectorId = appIdByName(platform, 'content-radar-cloudflared');
  const accessApp = indexOf(calls, call => call.service === 'cloudflare' && call.method === 'POST' && call.target.endsWith('/access/apps'));
  const policies = calls.filter(call => call.method === 'POST' && call.target.endsWith('/access/policies'));
  const appCreate = indexOf(calls, call => call.target === 'application.create' && call.body.name === 'content-radar');
  const appDeploy = indexOf(calls, call => call.target === 'application.deploy' && call.body.applicationId === mainId);
  const ingress = indexOf(calls, call => call.method === 'PUT' && call.target.endsWith('/configurations'));
  const connectorDeploy = indexOf(calls, call => call.target === 'application.deploy' && call.body.applicationId === connectorId);
  const dns = indexOf(calls, call => call.method === 'POST' && call.target.endsWith('/dns_records'));

  // (a) Access before (b) the app; the app is deployed before (c) the tunnel points at it; (d) DNS last.
  assert.equal(policies.length, 2);
  assert.ok(accessApp > -1 && accessApp < appCreate, 'the Access application exists before the Dokploy app');
  assert.ok(appDeploy > -1 && appDeploy < ingress, 'the app is deployed before the tunnel ingress points at it');
  assert.ok(ingress < connectorDeploy, 'ingress is set before cloudflared starts');
  assert.ok(accessApp < dns && connectorDeploy < dns, 'DNS comes after Access and the tunnel');
  assert.equal(calls.findLastIndex(isMutating), dns, 'the DNS record is the last change');

  // Access: the email policy, the service token policy, both attached to the app.
  const [allow, service] = platform.cloudflare.policies;
  assert.deepEqual(allow.include, [{ email: { email: FAKE.operatorEmail } }, { email: { email: FAKE.viewerEmail } }]);
  assert.equal(allow.decision, 'allow');
  assert.deepEqual(service.include, [{ service_token: { token_id: FAKE.serviceTokenId } }]);
  assert.equal(service.decision, 'non_identity');
  const [app] = platform.cloudflare.accessApps;
  assert.equal(app.type, 'self_hosted');
  assert.deepEqual(app.destinations, [{ type: 'public', uri: FAKE.hostname }]);
  assert.deepEqual(app.policies.map(policy => policy.id), [allow.id, service.id]);
  assert.equal(platform.cloudflare.identityProviders[0].type, 'onetimepin');

  // Dokploy: source, build, volume; the tunnel goes straight to the service, with Access enforced by cloudflared.
  const main = platform.dokploy.applications.get(mainId);
  assert.equal(main.customGitUrl, 'https://github.com/dantech0xff/daily-news-broadcast.git');
  assert.equal(main.customGitBranch, 'feat/dokploy-dashboard');
  assert.equal(main.buildType, 'dockerfile');
  assert.equal(main.dockerfile, 'Dockerfile');
  assert.equal(main.dockerContextPath, '.');
  assert.equal(main.createEnvFile, false);
  assert.deepEqual(main.mounts.map(({ type, volumeName, mountPath }) => ({ type, volumeName, mountPath })),
    [{ type: 'volume', volumeName: 'content-radar-data', mountPath: '/data' }]);
  const tunnel = platform.cloudflare.tunnels[0];
  assert.equal(tunnel.config_src, 'cloudflare');
  assert.deepEqual(platform.cloudflare.tunnelConfigs.get(tunnel.id).ingress, [
    {
      hostname: FAKE.hostname,
      service: `http://${main.appName}:3000`,
      originRequest: { access: { required: true, teamName: 'radar-team', audTag: [app.aud] } },
    },
    { service: 'http_status:404' },
  ]);
  const connector = platform.dokploy.applications.get(connectorId);
  assert.equal(connector.dockerImage, 'cloudflare/cloudflared:2026.9.3');
  assert.deepEqual(connector.args, ['tunnel', 'run']);
  assert.deepEqual(platform.cloudflare.dnsRecords.map(({ type, name, content, proxied }) => ({ type, name, content, proxied })),
    [{ type: 'CNAME', name: FAKE.hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true }]);
  // Never a Traefik domain or a published port.
  assert.equal(calls.some(call => /^(domain|port)\./.test(call.target)), false);
  assertNoSecrets(first.output);

  const second = await runScript(['deploy'], { platform });
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(second.calls.filter(isCreate), [], 'a second run creates nothing');
  // Only the app itself is redeployed (to pick up new commits); nothing else changes.
  assert.deepEqual(second.calls.filter(isMutating).map(call => call.target), ['application.deploy']);
  assert.equal(second.calls.find(isMutating).body.applicationId, mainId);
  assert.equal(platform.dokploy.applications.size, 2);
  assert.equal(platform.cloudflare.tunnels.length, 1);
  assert.equal(platform.cloudflare.dnsRecords.length, 1);
  assertNoSecrets(second.output);
});

test('APP_MASTER_KEY is generated once, reused afterwards, and never printed or written', async t => {
  const platform = createFakePlatform();
  const stateDir = await tempDir(t);
  const generatedBytes = Buffer.alloc(32, 7);
  const expectedKey = generatedBytes.toString('base64');
  let randomCalls = 0;
  const first = await runScript(['deploy'], {
    platform,
    stateDir,
    randomBytes: size => {
      randomCalls += 1;
      assert.equal(size, 32);
      return Buffer.from(generatedBytes);
    },
  });
  assert.equal(first.code, 0, first.output);
  assert.equal(randomCalls, 1);
  const mainId = appIdByName(platform, 'content-radar');
  const [save] = dokployCalls(first.calls, 'application.saveEnvironment').filter(call => call.body.applicationId === mainId);
  const env = parseEnvText(save.body.env).values;
  assert.equal(env.get('APP_MASTER_KEY'), expectedKey);
  assert.equal(parseMasterKey(expectedKey).length, 32);
  assert.equal(save.body.createEnvFile, false, 'the environment never lands in the build context');
  assert.deepEqual(Object.fromEntries([...env].filter(([key]) => key !== 'APP_MASTER_KEY')), {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    DATA_DIR: '/data',
    CACHE_PATH: '/data/news.json',
    ACCESS_TEAM_DOMAIN: `https://${FAKE.authDomain}`,
    ACCESS_AUD: platform.cloudflare.accessApps[0].aud,
    APP_OPERATOR_EMAILS: FAKE.operatorEmail,
    APP_VIEWER_EMAILS: FAKE.viewerEmail,
    APP_SERVICE_TOKEN_ROLES: `${FAKE.clientId}:operator`,
    PUBLIC_ORIGIN: `https://${FAKE.hostname}`,
    SHUTDOWN_WAIT_SECONDS: '120',
  });
  // The tunnel token goes straight from the Cloudflare API into Dokploy.
  const connectorId = appIdByName(platform, 'content-radar-cloudflared');
  const [connectorSave] = dokployCalls(first.calls, 'application.saveEnvironment').filter(call => call.body.applicationId === connectorId);
  assert.equal(parseEnvText(connectorSave.body.env).values.get('TUNNEL_TOKEN'), FAKE.tunnelToken);

  assert.match(first.stderr, /new APP_MASTER_KEY was generated.*password manager/);
  assertNoSecrets(first.output, [expectedKey]);
  const state = await readFile(join(stateDir, 'state.json'), 'utf8');
  assertNoSecrets(state, [expectedKey]);
  assert.equal(JSON.parse(state).dokploy.app.applicationId, mainId);
  assert.equal((await stat(join(stateDir, 'state.json'))).mode & 0o777, 0o600);

  // A later run with a changed viewer list rewrites the environment with the same key.
  const second = await runScript(['deploy'], {
    platform,
    stateDir,
    env: deployEnv({ APP_VIEWER_EMAILS: 'viewer@example.test,lead@example.test' }),
    randomBytes: () => assert.fail('an existing APP_MASTER_KEY must be reused'),
  });
  assert.equal(second.code, 0, second.output);
  const [resave] = dokployCalls(second.calls, 'application.saveEnvironment');
  const resaved = parseEnvText(resave.body.env).values;
  assert.equal(resaved.get('APP_MASTER_KEY'), expectedKey);
  assert.equal(resaved.get('APP_VIEWER_EMAILS'), 'viewer@example.test,lead@example.test');
  assert.match(second.stdout, /APP_MASTER_KEY is already set on the application and is reused/);
  assertNoSecrets(second.output, [expectedKey]);
});

test('an existing app keeps its master key and unmanaged variables', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  const existingKey = Buffer.alloc(32, 42).toString('base64');
  seedApplication(platform, {
    name: 'content-radar',
    appName: 'content-radar',
    environmentId,
    env: `APP_MASTER_KEY=${existingKey}\nCONTENT_SCAN_RETENTION_DAYS=60\n# comment\nNODE_ENV=development`,
  });
  const result = await runScript(['deploy'], { platform, randomBytes: () => assert.fail('must not generate a key') });
  assert.equal(result.code, 0, result.output);
  const [save] = dokployCalls(result.calls, 'application.saveEnvironment');
  const env = parseEnvText(save.body.env).values;
  assert.equal(env.get('APP_MASTER_KEY'), existingKey);
  assert.equal(env.get('CONTENT_SCAN_RETENTION_DAYS'), '60');
  assert.equal(env.get('NODE_ENV'), 'production');
  assert.match(result.stdout, /Keeping variables the deploy does not manage: CONTENT_SCAN_RETENTION_DAYS/);
  assert.deepEqual(result.calls.filter(call => call.target === 'application.create').map(call => call.body.name), ['content-radar-cloudflared']);
  assertNoSecrets(result.output, [existingKey]);
});

test('an invalid existing master key stops the deploy instead of being replaced', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  seedApplication(platform, { name: 'content-radar', appName: 'content-radar', environmentId, env: 'APP_MASTER_KEY=not-a-valid-key-0123456789' });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /APP_MASTER_KEY set on the application is invalid/);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.equal(result.output.includes('not-a-valid-key-0123456789'), false);
});

test('the app is set to stop-first with a /healthz health check and a stop grace period before it deploys', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const update = indexOf(result.calls, call => call.target === 'application.update' && call.body.applicationId === mainId);
  const deploy = indexOf(result.calls, call => call.target === 'application.deploy' && call.body.applicationId === mainId);
  assert.ok(update > -1 && update < deploy);
  const { body } = result.calls[update];
  assert.equal(body.replicas, 1);
  assert.deepEqual(body.updateConfigSwarm, { Parallelism: 1, Order: 'stop-first' });
  assert.deepEqual(body.healthCheckSwarm, {
    Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"],
    Interval: 30_000_000_000,
    Timeout: 5_000_000_000,
    StartPeriod: 30_000_000_000,
    Retries: 3,
  });
  assert.equal(body.stopGracePeriodSwarm, 135_000_000_000);
  // The settings are read back before the deploy.
  const readBack = indexOf(result.calls, (call, index) => index > update && call.target === 'application.one' && call.query.applicationId === mainId);
  assert.ok(readBack > update && readBack < deploy);
  const connectorId = appIdByName(platform, 'content-radar-cloudflared');
  const connectorUpdate = result.calls.find(call => call.target === 'application.update' && call.body.applicationId === connectorId);
  assert.deepEqual(connectorUpdate.body, { applicationId: connectorId, args: ['tunnel', 'run'] });
});

test('without a stop grace field or StartPeriod the deploy leaves them out and warns loudly', async () => {
  const platform = createFakePlatform({ openApi: dokployOpenApi({ stopGrace: false, startPeriod: false }) });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const { body } = result.calls.find(call => call.target === 'application.update' && call.body.applicationId === mainId);
  assert.equal('stopGracePeriodSwarm' in body, false);
  assert.equal('StartPeriod' in body.healthCheckSwarm, false);
  assert.match(result.stderr, /!!! This Dokploy instance has no Swarm stop grace period setting/);
  assert.match(result.stderr, /application\.update has no Swarm stop grace period field/);
});

test('a stop grace value the instance rejects is dropped with a loud warning, keeping stop-first', async () => {
  const platform = createFakePlatform({ rejectStopGrace: true });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const updates = result.calls.filter(call => call.target === 'application.update' && call.body.applicationId === mainId);
  assert.equal(updates.length, 2);
  assert.equal('stopGracePeriodSwarm' in updates[1].body, false);
  assert.deepEqual(updates[1].body.updateConfigSwarm, { Parallelism: 1, Order: 'stop-first' });
  assert.match(result.stderr, /!!! Dokploy rejected stopGracePeriodSwarm \(.*Expected bigint, received number\)/);
  assert.equal(platform.dokploy.applications.get(mainId).updateConfigSwarm.Order, 'stop-first');
  assert.equal(result.stderr.includes('did not keep stopGracePeriodSwarm'), false, 'warned once');
});

test('a start-first setting that does not stick stops the deploy before anything is deployed', async () => {
  const platform = createFakePlatform({
    onRequest(call, fake) {
      // Simulate an instance that silently drops updateConfigSwarm.
      if (call.target === 'application.update' && call.body?.updateConfigSwarm) delete call.body.updateConfigSwarm;
      void fake;
    },
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not keep updateConfigSwarm/);
  assert.equal(result.calls.some(call => call.target === 'application.deploy'), false);
});

test('a DNS record that points elsewhere blocks the deploy before any change', async () => {
  const conflict = { id: 'dns-existing', type: 'A', name: FAKE.hostname, content: '198.51.100.7', proxied: true };
  const platform = createFakePlatform({ dnsRecords: [{ ...conflict }] });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DNS already has A 198\.51\.100\.7 \(proxied\) for radar\.example\.test/);
  assert.match(result.stderr, /The deploy did not start/);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.deepEqual(platform.cloudflare.dnsRecords, [conflict]);
});

test('a DNS record that appears during the deploy is never overwritten', async () => {
  const conflict = { id: 'dns-late', type: 'CNAME', name: FAKE.hostname, content: 'elsewhere.example.net', proxied: false };
  const platform = createFakePlatform({
    onRequest(call, fake) {
      if (call.method === 'POST' && call.target.endsWith('/cfd_tunnel') && fake.cloudflare.dnsRecords.length === 0) {
        fake.cloudflare.dnsRecords.push({ ...conflict });
      }
    },
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The deploy stopped: DNS already has CNAME elsewhere\.example\.net for radar\.example\.test/);
  assert.deepEqual(result.calls.filter(call => call.target.includes('/dns_records') && isMutating(call)), []);
  assert.deepEqual(platform.cloudflare.dnsRecords, [conflict]);
});

test('a tunnel CNAME that is not proxied yet is switched to proxied', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  platform.cloudflare.dnsRecords[0].proxied = false;
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const patch = result.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { proxied: true });
  assert.equal(platform.cloudflare.dnsRecords[0].proxied, true);
});

test('extra policies on the Access application are kept and reported', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  platform.cloudflare.policies.push({ id: 'policy-bypass', name: 'everyone', decision: 'bypass', include: [{ everyone: {} }] });
  platform.cloudflare.accessApps[0].policies.push({ id: 'policy-bypass', name: 'everyone', decision: 'bypass', precedence: 3 });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stderr, /also has 1 other policy: "everyone" \(bypass\)\. The deploy keeps them; review them/);
  assert.equal(result.calls.some(call => call.method === 'PUT' && call.target.includes('/access/apps/')), false);
  assert.equal(platform.cloudflare.accessApps[0].policies.length, 3);
});

test('an Access application for the hostname that is not ours is never modified', async () => {
  const platform = createFakePlatform();
  platform.cloudflare.accessApps.push({
    id: 'foreign-app', aud: 'foreign-aud', name: 'Someone else', type: 'self_hosted', domain: FAKE.hostname,
    destinations: [{ type: 'public', uri: FAKE.hostname }], policies: [],
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] The Access application "Someone else" covers radar\.example\.test without the content-radar policies/);
  assert.deepEqual(result.calls.filter(isMutating), [], 'preflight stops before any change');

  // Attached by hand under another name, it is used as is.
  platform.cloudflare.policies.push(
    { id: 'p-users', name: 'content-radar-users', decision: 'allow', include: [{ email: { email: FAKE.operatorEmail } }, { email: { email: FAKE.viewerEmail } }] },
    { id: 'p-token', name: 'content-radar-agent-service-token', decision: 'non_identity', include: [{ service_token: { token_id: FAKE.serviceTokenId } }] },
  );
  platform.cloudflare.accessApps[0].policies = [
    { id: 'p-users', name: 'content-radar-users', precedence: 1 },
    { id: 'p-token', name: 'content-radar-agent-service-token', precedence: 2 },
  ];
  const attached = await runScript(['deploy'], { platform });
  assert.equal(attached.code, 0, attached.output);
  assert.equal(attached.calls.some(call => call.target.includes('/access/') && isMutating(call) && !call.target.endsWith('/identity_providers')), false);
  const mainId = appIdByName(platform, 'content-radar');
  assert.equal(parseEnvText(platform.dokploy.applications.get(mainId).env).values.get('ACCESS_AUD'), 'foreign-aud');
});

test('dry run lists the planned changes in order and sends none of them', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutating), [], 'no mutating call is sent');
  assert.equal(result.calls.some(call => call.target.endsWith('/token')), false, 'no secret is fetched in a dry run');
  const planned = [...result.stdout.matchAll(/^ {4}#(\d+) (POST|PUT|PATCH) (dokploy|cloudflare) (\S+)/gm)]
    .map(([, number, method, service, target]) => ({ number: Number(number), method, service, target }));
  assert.deepEqual(planned.map(entry => entry.number), planned.map((_, index) => index + 1));
  const targets = planned.map(entry => entry.target.replace(/^\/accounts\/[0-9a-f]+/, '').replace(/^\/zones\/[0-9a-f]+/, ''));
  assert.deepEqual(targets, [
    '/access/identity_providers',
    '/access/policies',
    '/access/policies',
    '/access/apps',
    'project.create',
    'application.create',
    'application.saveGitProvider',
    'application.saveBuildType',
    'application.saveEnvironment',
    'mounts.create',
    'application.update',
    'application.deploy',
    '/cfd_tunnel',
    '/cfd_tunnel/<new-tunnel-id>/configurations',
    'application.create',
    'application.saveDockerProvider',
    'application.saveEnvironment',
    'application.update',
    'application.deploy',
    '/dns_records',
  ]);
  assert.match(result.stdout, /APP_MASTER_KEY=\[REDACTED\]/);
  assert.match(result.stdout, /TUNNEL_TOKEN=\[REDACTED\]/);
  assert.match(result.stdout, /20 change\(s\) planned; nothing was sent/);
  assertNoSecrets(result.output);
  assert.equal(platform.dokploy.applications.size, 0);
  assert.equal(platform.cloudflare.policies.length, 0);
});

test('dry run against a finished deployment plans only the app deploy', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  const result = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.match(result.stdout, /#1 POST dokploy application\.deploy/);
  assert.match(result.stdout, /1 change\(s\) planned; nothing was sent/);
});

test('a failed build prints the redacted deployment log and stops before the tunnel', async () => {
  const leakedKey = Buffer.alloc(32, 9).toString('base64');
  const platform = createFakePlatform({
    failDeploymentOf: 'content-radar',
    deploymentLog: [
      'Cloning https://github.com/dantech0xff/daily-news-broadcast.git',
      `curl -H "x-api-key: ${FAKE.dokployApiKey}" http://localhost:3000`,
      `APP_MASTER_KEY=${leakedKey}`,
      `Authorization: Bearer ${FAKE.cfApiToken}`,
      'Error: vite build ran out of memory',
    ].join('\n'),
  });
  const result = await runScript(['deploy'], { platform, randomBytes: () => Buffer.alloc(32, 9) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Last 5 log lines of the content-radar deployment \(redacted\)/);
  assert.match(result.stderr, /vite build ran out of memory/);
  assert.match(result.stderr, /ended with status "error"/);
  assertNoSecrets(result.output, [leakedKey]);
  const failedDeploy = result.calls.findIndex(call => call.target === 'application.deploy');
  assert.ok(failedDeploy > -1);
  assert.deepEqual(result.calls.slice(failedDeploy + 1).filter(call => call.service === 'cloudflare'), [], 'nothing touches the tunnel or DNS after a failed build');
  assert.equal(result.calls.some(call => call.service === 'cloudflare' && isMutating(call) && /cfd_tunnel|dns_records/.test(call.target)), false);
});

test('an unknown deployment status stops the wait at once instead of timing out', async () => {
  const platform = createFakePlatform({ deploymentStatus: app => (app?.name === 'content-radar' ? 'success' : undefined) });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The content-radar deployment ended with status "success"/);
  const polls = result.calls.filter(call => call.target === 'deployment.all').length;
  assert.ok(polls <= 3, `stopped after ${polls} polls`);
});

test('a deployment that never finishes times out with a clear message', async () => {
  const platform = createFakePlatform({ deploymentStatus: app => (app?.name === 'content-radar' ? 'running' : undefined) });
  const result = await runScript(['deploy', '--wait-minutes', '2'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The content-radar deployment is still "running" after 2 min; check it in Dokploy, then re-run/);
  assert.equal(result.calls.some(call => call.target.includes('cfd_tunnel') && isMutating(call)), false);
});

test('missing variables are named, values are never printed, and the deploy does not start', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform, env: deployEnv({ CF_API_TOKEN: '', APP_OPERATOR_EMAILS: undefined }) });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing environment variables: CF_API_TOKEN, APP_OPERATOR_EMAILS/);
  assert.deepEqual(result.calls, []);
  assertNoSecrets(result.output);
});
