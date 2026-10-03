import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppConfigError } from '../../src/app/config/env.js';
import { APP_MIGRATIONS } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { closeDatabase, openDatabase } from '../../src/app/db/open-database.js';
import { startServer } from '../../src/app/server.js';
import { VaultKeyError } from '../../src/app/secrets/vault.js';
import { MemoryCache } from '../../src/core/caches.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { SQLiteDeliveryStore } from '../../src/core/sqlite-delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import {
  appEnv,
  capturingLogger,
  createApiClient,
  createChannelViaApi,
  createCredentialsViaApi,
  httpRequest,
  openEventStream,
  resumeViaApi,
  sharedAccessSigner,
  startTestApp,
} from './helpers/app-server.js';
import { FakeCron, FakeTimers, MASTER_KEY, mutableClock, techArticle } from './helpers/runtime-fixture.js';

const SERVER_PATH = fileURLToPath(new URL('../../src/app/server.js', import.meta.url));
const OTHER_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function start(dataDir, { env = {}, dependencies = {} } = {}) {
  const signer = await sharedAccessSigner();
  const { lines, logger } = capturingLogger();
  const server = await startServer(appEnv(dataDir, env), {
    keySet: signer.keySet,
    clock: mutableClock(),
    logger,
    cron: new FakeCron(),
    timers: new FakeTimers(),
    process: null,
    serverCloseGraceMs: 200,
    ...dependencies,
  });
  return { server, logs: lines, signer };
}

function readLeaseRows(dataDir) {
  const db = openDatabase({ dataDir });
  try {
    return db.prepare('SELECT owner_id FROM app_runtime_lease').all();
  } finally {
    closeDatabase(db);
  }
}

async function waitUntil(condition, { timeoutMs = 5_000, message = 'condition was not met' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('ACCESS_JWKS_FILE is refused unless NODE_ENV is development or test, before the data directory is touched', async t => {
  const directory = await tempDir(t);
  const dataDir = join(directory, 'data');
  for (const nodeEnv of ['production', 'prod', undefined]) {
    await assert.rejects(
      startServer(appEnv(dataDir, { NODE_ENV: nodeEnv, ACCESS_JWKS_FILE: join(directory, 'jwks.json') }), { process: null }),
      error => error instanceof AppConfigError && /ACCESS_JWKS_FILE/.test(error.message),
      `NODE_ENV=${nodeEnv}`,
    );
  }
  assert.equal(existsSync(dataDir), false);
});

test('the server executable exits 1 with a value-free message on invalid configuration', async t => {
  const directory = await tempDir(t);
  const secretLookingKey = 'clearly-not-base64-master-key-value';
  const child = spawn(process.execPath, ['--no-warnings', SERVER_PATH], {
    cwd: directory,
    env: { PATH: process.env.PATH, ...appEnv(join(directory, 'data'), { NODE_ENV: 'production', ACCESS_JWKS_FILE: 'jwks.json', APP_MASTER_KEY: secretLookingKey }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /Startup failed: Invalid app configuration/);
  assert.match(output, /ACCESS_JWKS_FILE/);
  assert.equal(output.includes(secretLookingKey), false);
  assert.equal(existsSync(join(directory, 'data')), false);
});

test('a master key that does not match the database refuses to start and never listens', async t => {
  const dataDir = await tempDir(t);
  const first = await start(dataDir);
  const api = createApiClient(first.server.url, { operator: await first.signer.sign({ email: 'ops@example.test' }, { now: new Date('2026-10-03T08:00:00.000Z') }) });
  assert.equal((await api('/api/credentials', { as: 'operator', method: 'POST', body: { label: 'Key', kind: 'ai_api_key', value: 'sealed-with-first-key' } })).status, 201);
  await first.server.close();

  const { lines, logger } = capturingLogger();
  const error = await startServer(appEnv(dataDir, { APP_MASTER_KEY: OTHER_MASTER_KEY }), {
    keySet: first.signer.keySet, logger, cron: new FakeCron(), timers: new FakeTimers(), process: null,
  }).then(() => null, value => value);
  assert.ok(error instanceof VaultKeyError);
  assert.equal(error.code, 'vault_key_mismatch');
  for (const key of [MASTER_KEY, OTHER_MASTER_KEY]) assert.equal(`${error.message}\n${lines.join('\n')}`.includes(key), false);
  assert.equal(lines.some(line => line.includes('Listening')), false);
  assert.deepEqual(readLeaseRows(dataDir), []);
});

test('an in-memory cache is refused for the output path and startup cleans up', async t => {
  const dataDir = await tempDir(t);
  await assert.rejects(start(dataDir, { dependencies: { createCache: () => new MemoryCache() } }), /persistent/);
  const retry = await start(dataDir);
  assert.equal(retry.server.runtime.getHealth().active, true, 'the failed start left no lease or open state behind');
  await retry.server.close();
});

test('a restart keeps data and repeats neither migrations nor the seed', async t => {
  const dataDir = await tempDir(t);
  const first = await start(dataDir);
  assert.ok(first.logs.some(line => line.includes(`Applied app schema migrations v0 → v${APP_MIGRATIONS.length}`)));
  assert.ok(first.logs.some(line => /Seeded telegram-main/.test(line)));
  const token = await first.signer.sign({ email: 'ops@example.test' }, { now: new Date('2026-10-03T08:00:00.000Z') });
  const api = createApiClient(first.server.url, { operator: token });
  await api('/api/credentials', { as: 'operator', method: 'POST', body: { label: 'Kept', kind: 'ai_api_key', value: 'kept-across-restarts' } });
  await first.server.close();

  const second = await start(dataDir);
  t.after(() => second.server.close());
  assert.equal(second.logs.some(line => /Applied app schema migrations|Seeded/.test(line)), false);
  const again = createApiClient(second.server.url, { operator: token });
  assert.deepEqual((await again('/api/credentials', { as: 'operator' })).body.credentials.map(entry => entry.label), ['Kept']);
  assert.deepEqual((await again('/api/channels', { as: 'operator' })).body.channels.map(entry => entry.id), ['telegram-main']);
});

test('SIGTERM stops the runtime, ends event streams, closes the server, releases the lease, and closes the database', async t => {
  const dataDir = await tempDir(t);
  const signals = new EventEmitter();
  const { server, logs, signer } = await start(dataDir, { dependencies: { process: signals } });
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.deepEqual(readLeaseRows(dataDir).map(row => row.owner_id).length, 1);
  const stream = await openEventStream(server.url, await signer.sign({ email: 'viewer@example.test' }, { now: new Date('2026-10-03T08:00:00.000Z') }));
  await stream.next(frame => frame.data?.type === 'connected');

  signals.emit('SIGTERM', 'SIGTERM');
  await server.close();
  await stream.ended;
  assert.equal(server.server.listening, false);
  assert.deepEqual(readLeaseRows(dataDir), [], 'the lease was released');
  assert.throws(() => server.runtime.listChannels(), /not open/i, 'the database was closed');
  assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0);
  assert.ok(logs.some(line => /SIGTERM received/.test(line)));
  await assert.rejects(httpRequest(server.url, '/healthz'), /ECONNREFUSED/);
  await server.close();
});

test('shutdown waits for the run in flight to commit before closing the database', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fetchStarted;
  const fetching = new Promise(resolve => { fetchStarted = resolve; });
  class GatedSource extends RecordingSource {
    async fetch() {
      fetchStarted();
      await gate;
      return super.fetch();
    }
  }
  const output = new RecordingOutput();
  const app = await startTestApp(t, {
    dependencies: {
      channelFactories: {
        createSources: () => [new GatedSource([techArticle('rust-2', 'Rust 2.0 compiler ships async closures')])],
        createAI: () => new RecordingAI('Tóm tắt'),
        createOutput: () => output,
      },
    },
  });
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  assert.equal((await resumeViaApi(app.api, 'telegram-ops')).status, 200);
  const queued = await app.api('/api/channels/telegram-ops/run', { as: 'operator', method: 'POST' });
  assert.equal(queued.status, 202);
  await fetching;

  const closing = app.handle.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotThrow(() => app.handle.runtime.listChannels(), 'the database stays open while the run is in flight');
  release();
  await closing;

  assert.equal(output.calls.length, 1);
  const db = openDatabase({ dataDir: app.dataDir });
  try {
    assert.equal(db.prepare('SELECT status FROM app_runs WHERE id = ?').get(queued.body.runId).status, 'success');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_runtime_lease').get().count, 0);
  } finally {
    closeDatabase(db);
  }
});

test('a send that outlives the shutdown wait is committed as delivered, never left ambiguous', async t => {
  // A slow Telegram send is in flight when SIGTERM arrives and outlasts the shutdown wait.
  let releaseSend;
  const sendGate = new Promise(resolve => { releaseSend = resolve; });
  let sendStarted;
  const sending = new Promise(resolve => { sendStarted = resolve; });
  class SlowTelegramOutput extends RecordingOutput {
    async send(content, options) {
      sendStarted();
      await sendGate;
      return super.send(content, options);
    }
  }
  const output = new SlowTelegramOutput();
  const signals = new EventEmitter();
  const app = await startTestApp(t, {
    dependencies: {
      process: signals,
      timers: { setInterval, clearInterval, setTimeout, clearTimeout },
      shutdownTimeoutMs: 100,
      channelFactories: {
        createSources: () => [new RecordingSource([techArticle('rust-2', 'Rust 2.0 compiler ships async closures')])],
        createAI: () => new RecordingAI('Tóm tắt'),
        createOutput: () => output,
      },
    },
  });
  const ids = await createCredentialsViaApi(app.api);
  await createChannelViaApi(app.api, ids);
  assert.equal((await resumeViaApi(app.api, 'telegram-ops')).status, 200);
  const queued = await app.api('/api/channels/telegram-ops/run', { as: 'operator', method: 'POST' });
  assert.equal(queued.status, 202);
  await sending;

  signals.emit('SIGTERM', 'SIGTERM');
  const closing = app.handle.close();
  await waitUntil(() => app.logs.some(line => /still in flight after the .* shutdown wait/.test(line)), { message: 'the overrun was not logged' });
  await waitUntil(() => !app.handle.server.listening, { message: 'the HTTP server was not closed' });
  assert.doesNotThrow(() => app.handle.runtime.listChannels(), 'the database stays open while the send is in flight');
  assert.equal(readLeaseRows(app.dataDir).length, 1, 'the lease is kept while the send is in flight');
  let closed = false;
  closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, false, 'shutdown waits for the send past the shutdown wait');

  releaseSend();
  await closing;
  assert.ok(app.logs.some(line => /run in flight has finished; closing the database/.test(line)));
  assert.throws(() => app.handle.runtime.listChannels(), /not open/i, 'the database is closed after the run');
  assert.equal(output.calls.length, 1);

  // What the next process finds: the send is committed and the channel is free.
  const db = openDatabase({ dataDir: app.dataDir });
  try {
    const store = new SQLiteDeliveryStore(createNodeSqlStorage(db));
    await store.initialize();
    const attempts = (await store.list('attempts')).filter(attempt => attempt.kind !== 'generation');
    assert.deepEqual(attempts.map(attempt => attempt.state === 'attempting'), [false], 'the output attempt was committed');
    const machine = new DeliveryStateMachine({
      store,
      channelId: 'telegram-ops',
      clock: () => new Date(Date.parse(attempts[0].deadlineAt) + 1_000),
    });
    assert.equal((await machine.recoverStaleAttempts()).outputAmbiguous, 0);
    assert.equal((await store.get('channel_state', 'telegram-ops')).mutationState, 'free');
    assert.deepEqual((await machine.queryDeliveries({})).map(delivery => delivery.state), ['succeeded']);
    assert.equal(db.prepare('SELECT status FROM app_runs WHERE id = ?').get(queued.body.runId).status, 'success');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_runtime_lease').get().count, 0, 'the lease was released after the run');
  } finally {
    closeDatabase(db);
  }
});

test('startup logs the shutdown wait and the stop grace period it needs', async t => {
  const dataDir = await tempDir(t);
  const { server, logs } = await start(dataDir, { env: { SHUTDOWN_WAIT_SECONDS: '90' } });
  t.after(() => server.close());
  assert.ok(logs.some(line => /shutdown wait 90 s, SHUTDOWN_WAIT_SECONDS.*stop grace period of at least 105 s/.test(line)), logs.join('\n'));
});

test('production verifies against the team JWKS; an unreachable JWKS is a logged 503, never a bypass', async t => {
  const app = await startTestApp(t, { env: { NODE_ENV: 'production' }, dependencies: { keySet: undefined } });
  const response = await app.api('/api/health', { as: 'operator' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'access_keys_unavailable');
  assert.equal((await httpRequest(app.url, '/api/health')).status, 401);
  assert.equal((await httpRequest(app.url, '/healthz')).text, 'ok');
  const authLog = app.logs.filter(line => line.startsWith('[Auth]')).join('\n');
  assert.match(authLog, /Cloudflare Access signing keys are unavailable/);
  assert.equal(authLog.includes('cloudflareaccess.com'), false, 'URLs are redacted from the error log');
  assert.equal(app.logs.join('\n').includes(app.tokens.operator), false);
});
