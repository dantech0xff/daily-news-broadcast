import test from 'node:test';
import assert from 'node:assert/strict';

import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { DEFAULT_RUNTIME_LEASE_NAME, RuntimeLease } from '../../src/app/db/runtime-lease.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const TTL_MS = 30_000;
const START = '2026-10-03T00:00:00.000Z';

async function setup(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: new Date(START) });
  let now = new Date(START);
  const clock = () => new Date(now);
  const storage = createNodeSqlStorage(db);
  return {
    workspace,
    storage,
    clock,
    lease: new RuntimeLease({ storage, clock }),
    advance(ms) { now = new Date(now.getTime() + ms); },
    leaseRows: () => storage.sql.exec('SELECT * FROM app_runtime_lease ORDER BY name').toArray(),
  };
}

function at(offsetMs) {
  return new Date(Date.parse(START) + offsetMs).toISOString();
}

test('acquires a free lease and persists it', async t => {
  const { lease, leaseRows } = await setup(t);

  const result = lease.acquire('owner-a', TTL_MS);
  const expected = {
    name: DEFAULT_RUNTIME_LEASE_NAME,
    ownerId: 'owner-a',
    acquiredAt: START,
    heartbeatAt: START,
    expiresAt: at(TTL_MS),
  };
  assert.deepEqual(result, { acquired: true, lease: expected });
  assert.deepEqual(lease.current(), expected);
  assert.deepEqual(leaseRows(), [{
    name: 'runtime',
    owner_id: 'owner-a',
    acquired_at: START,
    heartbeat_at: START,
    expires_at: at(TTL_MS),
  }]);
});

test('a second owner cannot acquire an unexpired lease', async t => {
  const { lease, leaseRows, advance } = await setup(t);
  const held = lease.acquire('owner-a', TTL_MS).lease;
  const before = leaseRows();

  advance(TTL_MS - 1);
  assert.deepEqual(lease.acquire('owner-b', TTL_MS), { acquired: false, lease: held });
  assert.deepEqual(leaseRows(), before);
  assert.equal(lease.renew('owner-b', TTL_MS), null);
  assert.equal(lease.release('owner-b'), false);
  assert.deepEqual(leaseRows(), before);
});

test('the holder extends its lease and keeps its tenure when re-acquiring or renewing', async t => {
  const { lease, advance } = await setup(t);
  lease.acquire('owner-a', TTL_MS);

  advance(10_000);
  assert.deepEqual(lease.acquire('owner-a', TTL_MS), {
    acquired: true,
    lease: {
      name: 'runtime',
      ownerId: 'owner-a',
      acquiredAt: START,
      heartbeatAt: at(10_000),
      expiresAt: at(10_000 + TTL_MS),
    },
  });

  advance(10_000);
  assert.deepEqual(lease.renew('owner-a', 5_000), {
    name: 'runtime',
    ownerId: 'owner-a',
    acquiredAt: START,
    heartbeatAt: at(20_000),
    expiresAt: at(25_000),
  });
});

test('another owner takes over only once the lease has expired', async t => {
  const { lease, advance } = await setup(t);
  lease.acquire('owner-a', TTL_MS);

  advance(TTL_MS - 1);
  assert.equal(lease.acquire('owner-b', TTL_MS).acquired, false);
  advance(1);
  assert.equal(lease.current(), null);

  const takeover = lease.acquire('owner-b', TTL_MS);
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.lease.ownerId, 'owner-b');
  assert.equal(takeover.lease.acquiredAt, at(TTL_MS));
  assert.equal(lease.renew('owner-a', TTL_MS), null);
  assert.deepEqual(lease.acquire('owner-a', TTL_MS), { acquired: false, lease: takeover.lease });
  assert.deepEqual(lease.current(), takeover.lease);
});

test('an expired lease that nobody took over can still be renewed by its owner', async t => {
  const { lease, advance } = await setup(t);
  lease.acquire('owner-a', TTL_MS);

  advance(TTL_MS * 2);
  const renewed = lease.renew('owner-a', TTL_MS);
  assert.equal(renewed.acquiredAt, START);
  assert.equal(renewed.expiresAt, at(TTL_MS * 3));
});

test('release frees the lease for another owner immediately', async t => {
  const { lease, leaseRows } = await setup(t);
  lease.acquire('owner-a', TTL_MS);

  assert.equal(lease.release('owner-a'), true);
  assert.deepEqual(leaseRows(), []);
  assert.equal(lease.current(), null);
  assert.equal(lease.renew('owner-a', TTL_MS), null);
  assert.equal(lease.release('owner-a'), false);
  assert.equal(lease.acquire('owner-b', TTL_MS).acquired, true);
});

test('leases with different names are independent', async t => {
  const { lease, storage, clock } = await setup(t);
  const scheduler = new RuntimeLease({ storage, clock, name: 'scheduler' });

  assert.equal(lease.acquire('owner-a', TTL_MS).acquired, true);
  assert.equal(scheduler.acquire('owner-b', TTL_MS).acquired, true);
  assert.equal(lease.current().ownerId, 'owner-a');
  assert.equal(scheduler.current().ownerId, 'owner-b');
  assert.equal(scheduler.release('owner-b'), true);
  assert.equal(lease.current().ownerId, 'owner-a');
});

test('connections sharing the database file serialize lease decisions', async t => {
  const { workspace, lease, storage, clock, advance } = await setup(t);
  const otherConnection = workspace.open({ busyTimeoutMs: 0 });
  const otherProcessLease = new RuntimeLease({ storage: createNodeSqlStorage(otherConnection), clock });

  assert.equal(lease.acquire('owner-a', TTL_MS).acquired, true);
  assert.deepEqual(otherProcessLease.acquire('owner-b', TTL_MS), { acquired: false, lease: lease.current() });

  storage.transactionSync(() => {
    assert.equal(lease.release('owner-a'), true);
    assert.throws(() => otherProcessLease.acquire('owner-b', TTL_MS), /database is locked/);
    lease.acquire('owner-a', TTL_MS);
  });
  assert.equal(otherProcessLease.current().ownerId, 'owner-a');

  advance(TTL_MS);
  assert.equal(otherProcessLease.acquire('owner-b', TTL_MS).acquired, true);
  assert.equal(lease.renew('owner-a', TTL_MS), null);
  assert.equal(lease.current().ownerId, 'owner-b');
});

test('an unreadable expiry counts as expired so the lease can be recovered', async t => {
  const { lease, storage } = await setup(t);
  lease.acquire('owner-a', TTL_MS);
  storage.sql.exec('UPDATE app_runtime_lease SET expires_at = ? WHERE name = ?', 'not-a-timestamp', 'runtime');

  assert.equal(lease.current(), null);
  assert.equal(lease.acquire('owner-b', TTL_MS).acquired, true);
});

test('validates options and arguments without writing anything', async t => {
  const { lease, storage, leaseRows } = await setup(t);

  assert.throws(() => new RuntimeLease(), TypeError);
  assert.throws(() => new RuntimeLease({ storage: { sql: {} } }), TypeError);
  assert.throws(() => new RuntimeLease({ storage, clock: 'now' }), TypeError);
  assert.throws(() => new RuntimeLease({ storage, name: '' }), TypeError);
  assert.throws(() => new RuntimeLease({ storage, name: 'x'.repeat(201) }), TypeError);

  for (const ownerId of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
    assert.throws(() => lease.acquire(ownerId, TTL_MS), TypeError);
    assert.throws(() => lease.renew(ownerId, TTL_MS), TypeError);
    assert.throws(() => lease.release(ownerId), TypeError);
  }
  for (const ttlMs of [undefined, 0, -1, 1.5, '30000', 24 * 60 * 60 * 1_000 + 1]) {
    assert.throws(() => lease.acquire('owner-a', ttlMs), TypeError);
    assert.throws(() => lease.renew('owner-a', ttlMs), TypeError);
  }

  const broken = new RuntimeLease({ storage, clock: () => new Date('invalid') });
  assert.throws(() => broken.acquire('owner-a', TTL_MS), /valid Date/);
  assert.deepEqual(leaseRows(), []);
});
