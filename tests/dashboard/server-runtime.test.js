import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { createDashboardCache, startDashboard } from '../../src/dashboard/server.js';

const env = {
  DASHBOARD_TRIGGER_USERNAME: 'trigger',
  DASHBOARD_TRIGGER_PASSWORD: 'trigger-password',
  DASHBOARD_OPERATOR_USERNAME: 'operator',
  DASHBOARD_OPERATOR_PASSWORD: 'operator-password',
  DASHBOARD_EXTERNAL_ORIGIN: 'http://127.0.0.1:3000',
  CACHE_TYPE: 'file',
};

test('dashboard runtime creates and initializes one process-owned store', async () => {
  class CountingStore extends MemoryDeliveryStore {
    constructor() { super({ durable: true }); this.initializations = 0; this.closes = 0; }
    async initialize() { this.initializations += 1; }
    async close() { this.closes += 1; }
  }
  const store = new CountingStore();
  let storeCreations = 0;
  const cache = {
    capabilities: { persistent: true },
    async peek() { return null; },
    async disconnect() { this.disconnected = true; },
  };
  const runtime = await startDashboard([], env, {
    loadEnvironment: async () => {},
    loadConfig: () => ({ streams: [], configPath: '/tmp/streams.json' }),
    createCache: () => cache,
    createDeliveryStore: () => { storeCreations += 1; return store; },
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    listen: async () => ({ listening: false }),
    process: { once() {} },
    logger: { log() {}, error() {} },
  });
  assert.equal(storeCreations, 1);
  assert.equal(store.initializations, 1);
  await runtime.close();
  assert.equal(store.closes, 1);
  assert.equal(cache.disconnected, true);
});

test('dashboard fails unresolved env before cache/store construction', async () => {
  let constructions = 0;
  await assert.rejects(startDashboard([], env, {
    loadEnvironment: async () => {},
    loadConfig: () => ({
      configPath: '/tmp/streams.json',
      streams: [{
        id: 'news', name: 'News', enabled: true, mode: 'digest', cron: '0 7 * * *', timezone: 'UTC',
        sources: [], ai: null, outputs: [{ type: 'telegram', config: { botToken: '$MISSING_TOKEN' } }], options: {},
      }],
    }),
    createCache: () => { constructions += 1; },
    createDeliveryStore: () => { constructions += 1; },
    logger: { log() {}, error() {} },
  }), /MISSING_TOKEN/);
  assert.equal(constructions, 0);
});

test('dashboard production cache factory refuses memory', () => {
  assert.throws(() => createDashboardCache({ CACHE_TYPE: 'memory' }), /not allowed/i);
});

test('dashboard shutdown waits for active execution to commit before closing store', async () => {
  class ClosingStore extends MemoryDeliveryStore {
    constructor() { super({ durable: true }); this.closed = false; }
    async transact(callback) {
      if (this.closed) throw new Error('store closed before commit');
      return super.transact(callback);
    }
    async close() { this.closed = true; }
  }
  const store = new ClosingStore();
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const stream = {
    id: 'news', name: 'News', enabled: true, mode: 'digest', cron: '0 7 * * *', timezone: 'UTC',
    sources: [], ai: null, outputs: [], options: {},
  };
  const runtime = await startDashboard([], env, {
    loadEnvironment: async () => {},
    loadConfig: () => ({ streams: [stream], configPath: '/tmp/streams.json' }),
    createCache: () => ({ capabilities: { persistent: true }, async peek() {}, async disconnect() {} }),
    createDeliveryStore: () => store,
    cron: { validate: () => true, schedule: () => ({ stop() {} }) },
    executeStream: async () => { started(); await gate; return { status: 'success', outputs: [] }; },
    listen: async () => ({ listening: false }),
    process: { once() {} },
    logger: { log() {}, error() {} },
  });
  const run = runtime.scheduler.runStream('news', { triggerType: 'manual' });
  await startedPromise;
  const shutdown = runtime.close();
  await Promise.resolve();
  assert.equal(store.closed, false);
  release();
  const [result] = await Promise.all([run, shutdown]);
  assert.equal(result.status, 'success');
  assert.equal(store.closed, true);
});
