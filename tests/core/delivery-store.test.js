import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LocalFileDeliveryStore,
  MemoryDeliveryStore,
  assertDeliveryStore,
  isOwnerProcessLive,
  isUnsupportedDirectorySyncError,
} from '../../src/core/delivery-store.js';

function createBoundaryFailingFs(targetPath) {
  let failurePoint = null;
  const fail = message => Object.assign(new Error(message), { code: 'EIO' });
  return {
    fs: {
      ...fsPromises,
      async rename(from, to) {
        if (failurePoint === 'before-rename' && to === targetPath) {
          failurePoint = null;
          throw fail('injected failure before rename');
        }
        return fsPromises.rename(from, to);
      },
      async open(path, flags, mode) {
        const handle = await fsPromises.open(path, flags, mode);
        if (flags !== 'r' || !['after-rename', 'after-rename-reload'].includes(failurePoint)) {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                failurePoint = failurePoint === 'after-rename-reload' ? 'recovery-read' : null;
                throw fail('injected failure after rename');
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      async readFile(path, ...args) {
        if (failurePoint === 'recovery-read' && path === targetPath) {
          failurePoint = null;
          throw fail('injected recovery read failure');
        }
        return fsPromises.readFile(path, ...args);
      },
    },
    failOnceAt(point) {
      failurePoint = point;
    },
  };
}

function createOwnerElectionRaceFs(lockPath) {
  let arrivals = 0;
  let releaseElection;
  const electionReady = new Promise(resolve => { releaseElection = resolve; });
  return {
    fs: {
      ...fsPromises,
      async rename(from, to) {
        await fsPromises.rename(from, to);
        if (!to.startsWith(`${lockPath}.owner.`)) return;
        arrivals += 1;
        if (arrivals === 2) releaseElection();
        await electionReady;
      },
    },
  };
}

async function ownerLockPaths(path) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.lock.owner.`;
  return (await readdir(directory))
    .filter(name => name.startsWith(prefix))
    .map(name => join(directory, name));
}

async function spawnReadyNode(t, script, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const onData = chunk => {
      output += chunk;
      if (!output.includes('ready\n')) return;
      cleanup();
      resolve();
    };
    const onErrorData = chunk => { errors += chunk; };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => {
      cleanup();
      reject(new Error(`subprocess exited before ready (${code}): ${errors}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onErrorData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onErrorData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return child;
}

test('memory store exposes transaction/CAS but is explicitly ephemeral', async () => {
  const store = new MemoryDeliveryStore();
  assert.equal(store.capabilities.durable, false);
  assert.equal(store.capabilities.transactional, true);
  assert.throws(() => assertDeliveryStore(store), /durable/i);
  assert.doesNotThrow(() => assertDeliveryStore(store, { allowEphemeral: true }));

  await store.transact(tx => tx.put('deliveries', 'd1', { state: 'pending' }, { expectedVersion: 0 }));
  assert.deepEqual(await store.get('deliveries', 'd1'), { state: 'pending', version: 1 });
  await assert.rejects(
    store.transact(tx => tx.put('deliveries', 'd1', { state: 'wrong' }, { expectedVersion: 0 })),
    /version conflict/i,
  );
});

test('transaction rejection leaves state unchanged and queue tail usable', async () => {
  const store = new MemoryDeliveryStore();
  await assert.rejects(store.transact(tx => {
    tx.put('requests', 'bad', { state: 'accepted' }, { expectedVersion: 0 });
    throw new Error('stop');
  }), /stop/);
  assert.equal(await store.get('requests', 'bad'), null);

  await store.transact(tx => tx.put('requests', 'good', { state: 'accepted' }, { expectedVersion: 0 }));
  assert.equal((await store.get('requests', 'good')).state, 'accepted');
});

test('local store persists atomically and enforces one live process owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');

  const first = new LocalFileDeliveryStore(path);
  await first.initialize();
  await first.transact(tx => tx.put('deliveries', 'd1', { state: 'ready' }, { expectedVersion: 0 }));

  const second = new LocalFileDeliveryStore(path);
  await assert.rejects(second.initialize(), /owned by another live process|owner lock/i);
  await first.close();

  await second.initialize();
  assert.deepEqual(await second.get('deliveries', 'd1'), { state: 'ready', version: 1 });
  await second.close();

  const durable = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(durable.schemaVersion, 2);
  assert.equal(durable.tables.deliveries.d1.state, 'ready');
});

test('concurrent local initialization acquires one durable owner lock without releasing it early', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-concurrent-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const store = new LocalFileDeliveryStore(path);

  await Promise.all([store.initialize(), store.initialize()]);
  assert.equal((await ownerLockPaths(path)).length, 1);
  await store.transact(tx => tx.put('deliveries', 'd1', { state: 'ready' }, { expectedVersion: 0 }));
  assert.equal((await store.get('deliveries', 'd1')).state, 'ready');
  await store.close();
  assert.equal((await ownerLockPaths(path)).length, 0);
});

test('concurrent stale-lock recovery cannot admit two process owners', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-stale-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    ownerToken: 'stale-owner-token',
    processStartedAt: '2000-01-01T00:00:00.000Z',
    processStartIdentity: 'fixture:stale-process',
  }), { mode: 0o600 });
  const injected = createOwnerElectionRaceFs(lockPath);
  const first = new LocalFileDeliveryStore(path, {
    fs: injected.fs,
    ownerToken: 'first-contender',
    processIdentityReader: async () => null,
  });
  const second = new LocalFileDeliveryStore(path, {
    fs: injected.fs,
    ownerToken: 'second-contender',
    processIdentityReader: async () => null,
  });

  const results = await Promise.allSettled([first.initialize(), second.initialize()]);
  const fulfilled = results
    .map((result, index) => ({ result, store: index === 0 ? first : second }))
    .filter(({ result }) => result.status === 'fulfilled');
  assert.ok(fulfilled.length <= 1, 'owner election must never admit two contenders');
  const ownerStore = fulfilled[0]?.store ?? new LocalFileDeliveryStore(path);
  if (fulfilled.length === 0) await ownerStore.initialize();
  assert.equal((await ownerLockPaths(path)).length, 1);
  await ownerStore.transact(tx => tx.put('requests', 'winning-write', {
    state: 'committed',
  }, { expectedVersion: 0 }));
  await ownerStore.close();
  assert.equal((await ownerLockPaths(path)).length, 0);

  const reopened = new LocalFileDeliveryStore(path);
  await reopened.initialize();
  assert.equal((await reopened.get('requests', 'winning-write')).state, 'committed');
  await reopened.close();
});

test('a crashed unique owner file is reclaimed without manual deletion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-stale-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const stalePath = `${path}.lock.owner.crashed-fixture`;
  await writeFile(stalePath, JSON.stringify({
    pid: 2_147_483_647,
    ownerToken: 'crashed-owner',
    processStartedAt: '2000-01-01T00:00:00.000Z',
    processStartIdentity: 'fixture:crashed-process',
  }), { mode: 0o600 });

  const store = new LocalFileDeliveryStore(path, { processIdentityReader: async () => null });
  await store.initialize();
  const locks = await ownerLockPaths(path);
  assert.equal(locks.length, 1);
  assert.notEqual(locks[0], stalePath);
  await assert.rejects(access(stalePath), error => error.code === 'ENOENT');
  await store.close();
});

test('a partial pre-publication owner candidate is ignored after a crash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-partial-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const partialCandidate = `${path}.lock.candidate.crashed-fixture`;
  await writeFile(partialCandidate, '{partial-owner-record', { mode: 0o600 });

  const store = new LocalFileDeliveryStore(path);
  await store.initialize();
  assert.equal((await ownerLockPaths(path)).length, 1);
  await store.transact(tx => tx.put('requests', 'after-partial-owner', {
    state: 'committed',
  }, { expectedVersion: 0 }));
  await store.close();

  const reopened = new LocalFileDeliveryStore(path);
  await reopened.initialize();
  assert.equal((await reopened.get('requests', 'after-partial-owner')).state, 'committed');
  await reopened.close();
});

test('directory sync ignores only explicitly unsupported platform errors', () => {
  assert.equal(isUnsupportedDirectorySyncError({ code: 'ENOTSUP' }), true);
  assert.equal(isUnsupportedDirectorySyncError({ code: 'EINVAL' }), true);
  assert.equal(isUnsupportedDirectorySyncError({ code: 'EIO' }), false);
  assert.equal(isUnsupportedDirectorySyncError({ code: 'ENOSPC' }), false);
});

test('local store reloads disk after failures before and after rename without losing committed state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const injected = createBoundaryFailingFs(path);
  const store = new LocalFileDeliveryStore(path, { fs: injected.fs });
  await store.initialize();
  await store.transact(tx => tx.put('requests', 'base', { state: 'base' }, { expectedVersion: 0 }));

  injected.failOnceAt('before-rename');
  await assert.rejects(
    store.transact(tx => tx.put('requests', 'not-committed', { state: 'bad' }, { expectedVersion: 0 })),
    /before rename/i,
  );
  assert.equal(await store.get('requests', 'not-committed'), null);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  await store.transact(tx => tx.put('requests', 'after-pre-failure', { state: 'safe' }, { expectedVersion: 0 }));

  injected.failOnceAt('after-rename');
  await assert.rejects(
    store.transact(tx => tx.put('requests', 'committed', { state: 'committed' }, { expectedVersion: 0 })),
    /after rename/i,
  );
  assert.equal((await store.get('requests', 'committed')).state, 'committed');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  await store.transact(tx => tx.put('requests', 'after-post-failure', { state: 'safe' }, { expectedVersion: 0 }));

  const durable = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(durable.tables.requests.base.state, 'base');
  assert.equal(durable.tables.requests['after-pre-failure'].state, 'safe');
  assert.equal(durable.tables.requests.committed.state, 'committed');
  assert.equal(durable.tables.requests['after-post-failure'].state, 'safe');
  assert.equal(durable.tables.requests['not-committed'], undefined);
  await store.close();
});

test('local store quarantines itself when a failed commit cannot reload the durable snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const injected = createBoundaryFailingFs(path);
  const store = new LocalFileDeliveryStore(path, { fs: injected.fs });
  await store.initialize();

  injected.failOnceAt('after-rename-reload');
  const failedCommit = store.transact(
    tx => tx.put('requests', 'committed', { state: 'committed' }, { expectedVersion: 0 }),
  );
  const queuedCommit = store.transact(
    tx => tx.put('requests', 'overwrite', { state: 'unsafe' }, { expectedVersion: 0 }),
  );
  await assert.rejects(failedCommit, /quarantined/i);
  await assert.rejects(queuedCommit, /quarantined/i);
  await assert.rejects(store.get('requests', 'committed'), /quarantined/i);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).tables.requests.committed.state, 'committed');
  await store.close();

  const reopened = new LocalFileDeliveryStore(path);
  await reopened.initialize();
  assert.equal((await reopened.get('requests', 'committed')).state, 'committed');
  await reopened.close();
});

test('owner lock rejects a live peer but recovers a stale reused current PID', () => {
  const currentStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
  assert.equal(isOwnerProcessLive({ pid: process.pid, processStartedAt: currentStartedAt }, currentStartedAt), true);
  assert.equal(isOwnerProcessLive({
    pid: process.pid,
    processStartedAt: '2000-01-01T00:00:00.000Z',
  }, currentStartedAt), false);
});

test('owner lock validates a live subprocess start identity and detects PID reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-process-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const moduleUrl = new URL('../../src/core/delivery-store.js', import.meta.url).href;
  const child = await spawnReadyNode(t, `
    import { LocalFileDeliveryStore } from ${JSON.stringify(moduleUrl)};
    const store = new LocalFileDeliveryStore(process.argv[1]);
    await store.initialize();
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1_000);
  `, [path]);

  const contender = new LocalFileDeliveryStore(path);
  await assert.rejects(contender.initialize(), /owned by another live process/i);
  const [ownerPath] = await ownerLockPaths(path);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  assert.equal(owner.pid, child.pid);
  if (process.platform === 'linux') assert.match(owner.processStartIdentity, /^linux:/);

  if (owner.processStartIdentity) {
    await writeFile(ownerPath, JSON.stringify({
      ...owner,
      processStartIdentity: `${owner.processStartIdentity}:stale`,
    }), { mode: 0o600 });
    const replacement = new LocalFileDeliveryStore(path);
    await replacement.initialize();
    const [replacementOwnerPath] = await ownerLockPaths(path);
    assert.equal(JSON.parse(await readFile(replacementOwnerPath, 'utf8')).pid, process.pid);
    await replacement.close();
  }
});

test('owner lock detects PID reuse for a live foreign PID through the identity reader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-reused-pid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const child = await spawnReadyNode(t, `
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1_000);
  `);
  await writeFile(`${path}.lock`, JSON.stringify({
    pid: child.pid,
    ownerToken: 'stale-owner',
    processStartedAt: '2000-01-01T00:00:00.000Z',
    processStartIdentity: 'fixture:old-process',
  }), { mode: 0o600 });

  const store = new LocalFileDeliveryStore(path, {
    processIdentityReader: async pid => ({
      identity: pid === child.pid ? 'fixture:live-process' : 'fixture:current-process',
      startedAt: new Date().toISOString(),
    }),
  });
  await store.initialize();
  const [ownerPath] = await ownerLockPaths(path);
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).pid, process.pid);
  await store.close();
});

test('owner lock fails closed for a live foreign PID when start identity cannot be proven', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-unproven-pid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const child = await spawnReadyNode(t, `
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1_000);
  `);
  await writeFile(`${path}.lock`, JSON.stringify({
    pid: child.pid,
    ownerToken: 'unproven-owner',
    processStartedAt: '2000-01-01T00:00:00.000Z',
    processStartIdentity: 'fixture:unknown-process',
  }), { mode: 0o600 });

  const store = new LocalFileDeliveryStore(path, { processIdentityReader: async () => null });
  await assert.rejects(store.initialize(), /owned by another live process/i);
  assert.equal(JSON.parse(await readFile(`${path}.lock`, 'utf8')).ownerToken, 'unproven-owner');
});

test('local read-only initialization performs no filesystem mutation and can upgrade safely', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-readonly-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'missing');
  const path = join(nested, 'state.json');
  const store = new LocalFileDeliveryStore(path);

  await store.initialize({ readOnly: true });
  assert.deepEqual(await store.list('deliveries'), []);
  await assert.rejects(access(nested), error => error.code === 'ENOENT');
  await assert.rejects(
    store.transact(() => null),
    /read-only/i,
  );

  await store.initialize();
  await store.transact(tx => tx.put('deliveries', 'd1', { state: 'ready' }, { expectedVersion: 0 }));
  await store.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).tables.deliveries.d1.state, 'ready');
});

test('local store fails closed on corrupt durable state and does not overwrite it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  await writeFile(path, '{not valid json', { mode: 0o600 });

  const store = new LocalFileDeliveryStore(path);
  await assert.rejects(store.initialize(), /corrupt|invalid/i);
  assert.equal(await readFile(path, 'utf8'), '{not valid json');
});

test('list returns snapshots and cannot mutate store internals', async () => {
  const store = new MemoryDeliveryStore();
  await store.transact(tx => {
    tx.put('outputs', 'a', { deliveryId: 'd1', state: 'pending' }, { expectedVersion: 0 });
    tx.put('outputs', 'b', { deliveryId: 'd2', state: 'succeeded' }, { expectedVersion: 0 });
  });
  const pending = await store.list('outputs', record => record.state === 'pending');
  assert.equal(pending.length, 1);
  pending[0].state = 'tampered';
  assert.equal((await store.get('outputs', 'a')).state, 'pending');
});

test('local store never writes a snapshot that its own startup validator rejects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-large-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const store = new LocalFileDeliveryStore(path);
  await store.initialize();
  const payload = 'x'.repeat(480_000);
  await store.transact(tx => {
    for (let index = 0; index < 23; index++) {
      tx.put('requests', `request-${index}`, {
        requestId: `request-${index}`,
        state: 'accepted',
        payload,
      }, { expectedVersion: 0 });
    }
  });
  await store.close();

  const reopened = new LocalFileDeliveryStore(path);
  await reopened.initialize();
  assert.equal((await reopened.list('requests')).length, 23);
  await reopened.close();
});

test('local retention prunes old terminal detail but preserves unresolved work and article tombstones', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-delivery-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const store = new LocalFileDeliveryStore(path);
  await store.initialize();
  const old = '2020-01-01T00:00:00.000Z';
  await store.transact(tx => {
    tx.put('deliveries', 'terminal', {
      deliveryId: 'terminal', state: 'succeeded', forceKind: null, updatedAt: old,
    }, { expectedVersion: 0 });
    tx.put('deliveries', 'unresolved', {
      deliveryId: 'unresolved', state: 'needs_reconciliation', forceKind: null, updatedAt: old,
    }, { expectedVersion: 0 });
    tx.put('delivery_outputs', 'terminal:out', {
      deliveryId: 'terminal', state: 'succeeded', updatedAt: old,
    }, { expectedVersion: 0 });
    tx.put('delivery_outputs', 'unresolved:out', {
      deliveryId: 'unresolved', state: 'needs_reconciliation', updatedAt: old,
    }, { expectedVersion: 0 });
    tx.put('articles', 'tombstone', {
      articleHash: 'tombstone', activeDeliveryId: null, terminalState: 'succeeded', updatedAt: old,
    }, { expectedVersion: 0 });
  });

  assert.equal(await store.get('deliveries', 'terminal'), null);
  assert.equal((await store.get('deliveries', 'unresolved')).state, 'needs_reconciliation');
  assert.equal(await store.get('delivery_outputs', 'terminal:out'), null);
  assert.equal((await store.get('delivery_outputs', 'unresolved:out')).state, 'needs_reconciliation');
  assert.equal((await store.get('articles', 'tombstone')).terminalState, 'succeeded');
  await store.close();
});

test('local retention bounds dashboard history and compacts force idempotency tombstones', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-adapter-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalFileDeliveryStore(join(directory, 'state.json'));
  await store.initialize();
  const old = '2020-01-01T00:00:00.000Z';
  await store.transact(tx => {
    tx.put('dashboard_runs', 'old-run', {
      id: 'old-run', status: 'success', finished_at: old, privateDetail: 'remove-me',
    }, { expectedVersion: 0 });
    tx.put('dashboard_force_actions', 'dashboard-force', {
      kind: 'dashboard_force_action', stream_id: 'drip', target_channel_id: 'drip',
      target_request_id: 'request-hash', engine_idempotency_id: 'engine-hash',
      actor_key_id: 'ops', reason_hash: 'reason-hash', key_hash: 'key-hash',
      payload_hash: 'payload-hash', run_id: 'old-run', status: 'completed',
      result: { id: 'old-run', status: 'success', privateDetail: 'remove-me' },
      requested_at: old, completed_at: old,
    }, { expectedVersion: 0 });
    tx.put('local_force_actions', 'local-force', {
      kind: 'local_force_action', action_id: 'local-force', target_channel_id: 'drip',
      target_request_id: 'request-hash', engine_idempotency_id: 'engine-hash',
      actor_key_id: 'ops', reason_hash: 'reason-hash', payload_fingerprint: 'payload-hash',
      status: 'completed', result: [{ status: 'success', privateDetail: 'remove-me' }],
      requested_at: old, completed_at: old,
    }, { expectedVersion: 0 });
    tx.put('deliveries', 'old-force-delivery', {
      deliveryId: 'old-force-delivery', channelId: 'drip', requestId: 'request-hash',
      mode: 'drip', publishingDay: '2020-01-01', forceKind: 'force', state: 'succeeded',
      topologyFingerprint: 'topology', articleHashes: ['article-hash'],
      articleSnapshot: [{ content: 'remove-me' }], generatedContent: 'remove-me',
      createdAt: old, updatedAt: old,
    }, { expectedVersion: 0 });
  });

  assert.equal(await store.get('dashboard_runs', 'old-run'), null);
  const dashboardForce = await store.get('dashboard_force_actions', 'dashboard-force');
  assert.equal(dashboardForce.compacted, true);
  assert.equal(JSON.stringify(dashboardForce).includes('remove-me'), false);
  const localForce = await store.get('local_force_actions', 'local-force');
  assert.equal(localForce.compacted, true);
  assert.equal(JSON.stringify(localForce).includes('remove-me'), false);
  const delivery = await store.get('deliveries', 'old-force-delivery');
  assert.equal(delivery.compacted, true);
  assert.equal(delivery.generatedContent, undefined);
  assert.equal(delivery.articleSnapshot, undefined);
  await store.close();
});
