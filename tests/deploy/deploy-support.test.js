import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAMES,
  SHUTDOWN_WAIT_SECONDS,
  STOP_GRACE_MARGIN_SECONDS,
  compareVersions,
  managedAppEnv,
  parseVersion,
  readDeployConfig,
} from '../../scripts/deploy/config.mjs';
import { analyzeDokployContract } from '../../scripts/deploy/dokploy-contract.mjs';
import { EnvTextError, generateMasterKey, mergeEnvText, parseEnvText } from '../../scripts/deploy/env-text.mjs';
import { REDACTED, Redactor, redactBody } from '../../scripts/deploy/redaction.mjs';
import { DEFAULT_SHUTDOWN_WAIT_SECONDS, STOP_GRACE_MARGIN_SECONDS as APP_STOP_GRACE_MARGIN, loadAppConfig } from '../../src/app/config/env.js';
import { parseMasterKey } from '../../src/app/secrets/vault.js';
import { FAKE, deployEnv } from './helpers/fake-platform.js';

test('the redactor masks registered secrets in every encoding and secret-looking patterns', () => {
  const redactor = new Redactor();
  const key = 'ab+cd/ef==ghij0123456789';
  redactor.add(key);
  redactor.add('short');
  redactor.add(undefined);
  const text = [
    `plain ${key}`,
    `url ${encodeURIComponent(key)}`,
    'header x-api-key: dokploy-unregistered-123',
    'Authorization: Bearer some.bearer.token',
    'secret cfast_0123456789abcdef',
    'jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
    'tunnel eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=',
    'env APP_MASTER_KEY=unregistered-key-value',
    'json {"TUNNEL_TOKEN": "unregistered-token"}',
    'prose CF_API_TOKEN: Cloudflare rejected it; the word short stays',
  ].join('\n');
  const output = redactor.redact(text);
  for (const leaked of [key, encodeURIComponent(key), 'dokploy-unregistered-123', 'some.bearer.token', 'cfast_0123456789abcdef',
    'eyJhbGciOiJSUzI1NiJ9', 'eyJhIjoiYWNjb3VudCIs', 'unregistered-key-value', 'unregistered-token']) {
    assert.equal(output.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.match(output, /prose CF_API_TOKEN: Cloudflare rejected it; the word short stays/);
  assert.equal(redactor.containsSecret(`x${key}y`), true);
  assert.equal(redactor.containsSecret('nothing here'), false);
});

test('request bodies print env keys, public values, and identifiers, never secrets', () => {
  const body = redactBody({
    applicationId: 'app-1',
    environmentId: 'env-1',
    env: 'NODE_ENV=production\nAPP_MASTER_KEY=secret-value\n# comment\nAPP_OPERATOR_EMAILS=ops@example.test\nTUNNEL_TOKEN=abc',
    password: 'hunter2-password',
    username: null,
    include: [{ service_token: { token_id: 'token-uuid' } }],
    nested: { apiKey: 'nested-key', createEnvFile: false },
  });
  assert.deepEqual(body, {
    applicationId: 'app-1',
    environmentId: 'env-1',
    env: ['NODE_ENV=production', `APP_MASTER_KEY=${REDACTED}`, 'APP_OPERATOR_EMAILS=ops@example.test', `TUNNEL_TOKEN=${REDACTED}`],
    password: REDACTED,
    username: null,
    include: [{ service_token: { token_id: 'token-uuid' } }],
    nested: { apiKey: REDACTED, createEnvFile: false },
  });
});

test('env text: managed keys are rewritten, other lines are kept verbatim', () => {
  const current = 'export NODE_ENV=development\nKEEP_ME="quoted # value"\n# a comment\nAPP_MASTER_KEY=old\nEXTRA=1 # trailing\nEXTRA=2';
  const parsed = parseEnvText(current);
  assert.equal(parsed.values.get('NODE_ENV'), 'development');
  assert.equal(parsed.values.get('KEEP_ME'), 'quoted # value');
  assert.equal(parsed.values.get('EXTRA'), '2');

  const merged = mergeEnvText(current, { NODE_ENV: 'production', APP_MASTER_KEY: 'old' });
  assert.equal(merged.text, 'NODE_ENV=production\nAPP_MASTER_KEY=old\nKEEP_ME="quoted # value"\nEXTRA=1 # trailing\nEXTRA=2');
  assert.deepEqual(merged.kept, ['KEEP_ME', 'EXTRA']);
  assert.equal(merged.changed, true);
  assert.equal(mergeEnvText(merged.text, { NODE_ENV: 'production', APP_MASTER_KEY: 'old' }).changed, false);
  assert.equal(mergeEnvText(null, { A: '1' }).changed, true);
  assert.equal(mergeEnvText('', {}).changed, false);
});

test('env text refuses values it cannot write or keep safely, naming keys only', () => {
  assert.throws(() => mergeEnvText('PEM="-----BEGIN\nabc"', { A: '1' }), error => error instanceof EnvTextError && /PEM/.test(error.message));
  assert.throws(() => mergeEnvText('', { APP_OPERATOR_EMAILS: 'a@b.test #x' }), error => {
    assert.ok(error instanceof EnvTextError);
    assert.match(error.message, /APP_OPERATOR_EMAILS/);
    assert.equal(error.message.includes('a@b.test'), false);
    return true;
  });
  assert.throws(() => mergeEnvText('', { KEY: ' padded' }), EnvTextError);
});

test('a generated master key is what the app vault accepts', () => {
  const key = generateMasterKey();
  assert.equal(parseMasterKey(key).length, 32);
  assert.notEqual(generateMasterKey(), key);
  assert.throws(() => generateMasterKey(() => Buffer.alloc(16)), /wrong number of bytes/);
});

test('the managed environment is accepted by the app configuration', () => {
  const env = managedAppEnv({
    masterKey: generateMasterKey(),
    authDomain: FAKE.authDomain,
    aud: 'a'.repeat(64),
    operatorEmails: [FAKE.operatorEmail],
    viewerEmails: [],
    serviceClientId: FAKE.clientId,
    hostname: FAKE.hostname,
  });
  const config = loadAppConfig(env);
  assert.equal(config.production, true);
  assert.equal(config.dataDir, '/data');
  assert.equal(config.publicOrigin, `https://${FAKE.hostname}`);
  assert.equal(config.access.issuer, `https://${FAKE.authDomain}`);
  assert.deepEqual(config.roles.serviceTokens, [{ clientId: FAKE.clientId, role: 'operator' }]);
  assert.equal(config.shutdownWaitMs, SHUTDOWN_WAIT_SECONDS * 1_000);
  // The stop grace period the deploy sets is derived from the app's own shutdown contract.
  assert.equal(SHUTDOWN_WAIT_SECONDS, DEFAULT_SHUTDOWN_WAIT_SECONDS);
  assert.equal(STOP_GRACE_MARGIN_SECONDS, APP_STOP_GRACE_MARGIN);
});

test('config: secrets stay off the serializable surface and URLs are normalized', () => {
  const { config, problems, warnings } = readDeployConfig(
    deployEnv({ DOKPLOY_URL: 'http://203.0.113.10:3000/api/', APP_HOSTNAME: 'Radar.Example.Test.', APP_OPERATOR_EMAILS: ' Ops@Example.test , ops@example.test ' }),
    { command: 'deploy', flags: {} },
  );
  assert.deepEqual(problems, []);
  assert.equal(config.dokploy.url, 'http://203.0.113.10:3000');
  assert.equal(config.hostname, 'radar.example.test');
  assert.deepEqual(config.operatorEmails, ['ops@example.test']);
  assert.match(warnings.join(' '), /plain http/);
  const serialized = JSON.stringify(config);
  for (const secret of [FAKE.dokployApiKey, FAKE.cfApiToken, FAKE.clientSecret]) assert.equal(serialized.includes(secret), false);
  assert.equal(config.dokploy.apiKey, FAKE.dokployApiKey);
  assert.equal(config.waitMs, 30 * 60_000);
});

test('config: per-command requirements and flag validation never echo values', () => {
  const verify = readDeployConfig(deployEnv({ CF_ACCESS_CLIENT_SECRET: '' }), { command: 'verify', flags: {} });
  assert.match(verify.problems.join(' '), /Missing environment variables: CF_ACCESS_CLIENT_SECRET/);
  const verifyWithoutCloudflare = readDeployConfig(deployEnv({ CF_API_TOKEN: undefined, CF_ZONE_ID: undefined }), { command: 'verify', flags: {} });
  assert.deepEqual(verifyWithoutCloudflare.problems, []);

  const flags = readDeployConfig(deployEnv(), {
    command: 'deploy',
    flags: { 'git-url': 'https://user:token-in-url@github.com/x/y.git', 'git-branch': '../escape', 'wait-minutes': '0', 'origin-ip': '1.2.3.4' },
  });
  const text = flags.problems.join(' ');
  assert.match(text, /--git-url must be a public https Git URL without credentials/);
  assert.match(text, /--git-branch must be a branch name/);
  assert.match(text, /--wait-minutes must be a whole number of minutes between 1 and 240/);
  assert.match(text, /--origin-ip is not an option of the deploy command/);
  assert.equal(text.includes('token-in-url'), false);

  const pinned = readDeployConfig(deployEnv(), { command: 'deploy', flags: { 'cloudflared-image': `cloudflare/cloudflared@sha256:${'a'.repeat(64)}` } });
  assert.deepEqual(pinned.problems, []);
  assert.equal(readDeployConfig(deployEnv(), { command: 'nope', flags: {} }).config, null);
});

test('versions compare numerically', () => {
  assert.deepEqual(parseVersion('v0.30.8'), [0, 30, 8]);
  assert.deepEqual(parseVersion('0.31.0-canary.2'), [0, 31, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.ok(compareVersions([0, 29, 10], [0, 29, 5]) > 0);
  assert.ok(compareVersions([0, 29, 4], [0, 29, 5]) < 0);
  assert.equal(compareVersions([0, 29, 5], [0, 29, 5]), 0);
});

test('the contract resolves $ref, allOf, and nullable unions, and fits payloads to the instance', () => {
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const doc = {
    components: {
      schemas: {
        Base: { type: 'object', properties: { applicationId: { type: 'string' } }, required: ['applicationId'] },
        Swarm: { type: 'object', properties: { Parallelism: { type: 'number' }, Order: { type: 'string' } }, required: ['Parallelism', 'Order'] },
      },
    },
    paths: {},
  };
  const post = schema => ({ post: { requestBody: { content: { 'application/json': { schema } } } } });
  const get = names => ({ get: { parameters: names.map(name => ({ name, in: 'query', required: true, schema: { type: 'string' } })) } });
  for (const procedure of ['project.all']) doc.paths[`/${procedure}`] = get([]);
  for (const procedure of ['application.one', 'deployment.all']) doc.paths[`/${procedure}`] = get(['applicationId']);
  doc.paths['/deployment.readLogs'] = get(['deploymentId']);
  doc.paths['/project.create'] = post({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  doc.paths['/application.create'] = post({ type: 'object', properties: { name: { type: 'string' }, environmentId: { type: 'string' } }, required: ['name', 'environmentId'] });
  doc.paths['/application.saveGitProvider'] = post({
    allOf: [{ $ref: '#/components/schemas/Base' }, {
      type: 'object',
      properties: { customGitUrl: { type: 'string' }, customGitBranch: { type: 'string' }, customGitBuildPath: { type: 'string' }, watchPaths: { type: 'array' }, customGitSSHKeyId: nullableString },
      required: ['customGitUrl', 'customGitBranch', 'customGitBuildPath', 'watchPaths', 'customGitSSHKeyId'],
    }],
  });
  doc.paths['/application.saveBuildType'] = post({
    type: 'object',
    properties: { applicationId: { type: 'string' }, buildType: { type: 'string' }, dockerfile: { type: 'string' }, dockerContextPath: { type: 'string' }, dockerBuildStage: { type: 'string' } },
    required: ['applicationId', 'buildType', 'dockerfile', 'dockerContextPath', 'dockerBuildStage'],
  });
  doc.paths['/application.saveDockerProvider'] = post({ type: 'object', properties: { applicationId: { type: 'string' }, dockerImage: { type: 'string' } }, required: ['applicationId'] });
  doc.paths['/application.saveEnvironment'] = post({ type: 'object', properties: { applicationId: { type: 'string' }, env: nullableString }, required: ['applicationId'] });
  doc.paths['/mounts.create'] = post({ type: 'object', properties: { type: { type: 'string' }, volumeName: { type: 'string' }, mountPath: { type: 'string' }, serviceId: { type: 'string' } }, required: ['type', 'mountPath', 'serviceId'] });
  doc.paths['/application.update'] = post({
    type: 'object',
    properties: {
      applicationId: { type: 'string' },
      replicas: { type: 'number' },
      args: { type: 'array' },
      updateConfigSwarm: { oneOf: [{ $ref: '#/components/schemas/Swarm' }, { type: 'null' }] },
      healthCheckSwarm: { type: 'object', properties: { Test: { type: 'array' }, Interval: { type: 'number' }, Timeout: { type: 'number' }, Retries: { type: 'number' } } },
      stopGracePeriod: { type: 'string' },
    },
    required: ['applicationId'],
  });
  doc.paths['/application.deploy'] = post({ type: 'object', properties: { applicationId: { type: 'string' } }, required: ['applicationId'] });
  doc.paths['/application.redeploy'] = doc.paths['/application.deploy'];

  const contract = analyzeDokployContract(doc);
  assert.deepEqual(contract.problems, []);
  assert.deepEqual(contract.stopGrace, { field: 'stopGracePeriod', types: ['string'] });
  assert.ok(contract.notes.some(note => /healthCheckSwarm\.StartPeriod/.test(note)));
  assert.ok(contract.notes.some(note => /deployment\.readLogs has no optional field "tail"/.test(note)));

  // Required but not nullable → empty string; nullable → null; unknown optional → left out.
  assert.deepEqual(contract.fit('application.saveGitProvider', {
    applicationId: 'a', customGitUrl: 'u', customGitBranch: 'b', customGitBuildPath: '/', customGitSSHKeyId: null, watchPaths: null, enableSubmodules: false,
  }), { applicationId: 'a', customGitUrl: 'u', customGitBranch: 'b', customGitBuildPath: '/', customGitSSHKeyId: null, watchPaths: null });
  assert.deepEqual(contract.fit('application.saveBuildType', {
    applicationId: 'a', buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '.', dockerBuildStage: null, herokuVersion: null,
  }), { applicationId: 'a', buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '.', dockerBuildStage: '' });
  assert.deepEqual(contract.fit('application.update', {
    applicationId: 'a', updateConfigSwarm: { Parallelism: 1, Order: 'stop-first' }, healthCheckSwarm: { Test: ['CMD'], Interval: 1, StartPeriod: 2 },
  }), { applicationId: 'a', updateConfigSwarm: { Parallelism: 1, Order: 'stop-first' }, healthCheckSwarm: { Test: ['CMD'], Interval: 1 } });
  assert.deepEqual(contract.fit('deployment.readLogs', { deploymentId: 'd', tail: 10 }), { deploymentId: 'd' });
});

test('an OpenAPI document without paths or input schemas is a blocker, not a guess', () => {
  assert.match(analyzeDokployContract({}).problems.join(' '), /no paths/);
  const empty = analyzeDokployContract({ paths: { '/project.create': { post: {} } } });
  assert.ok(empty.problems.includes('project.create has no JSON input schema in the instance OpenAPI document, so its fields cannot be verified.'));
  assert.ok(empty.problems.includes('application.create is missing (the deploy calls POST /api/application.create).'));
  assert.equal(NAMES.environment, 'production');
});
