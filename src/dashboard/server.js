#!/usr/bin/env node
/** Dashboard runtime composition. Importing this module does not listen or acquire state. */

import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { pathToFileURL } from 'node:url';

import { FileCache, LocalFileDeliveryStore, RedisCache } from '../core/index.js';
import { sanitizeRuntimeError } from '../channels/runner.js';
import { createDashboardApp } from './create-dashboard-app.js';
import { loadConfig as defaultLoadConfig } from './config-loader.js';
import { createDashboardAuth, validateDashboardRuntime } from './operator-auth.js';
import { createScheduler } from './scheduler.js';
import { validateStreamConfig } from './stream-runner.js';

export function createDashboardCache(env = process.env) {
  const type = envValue(env, 'CACHE_TYPE', 'file').toLowerCase();
  if (type === 'memory') throw new Error('CACHE_TYPE=memory is not allowed for the output-capable dashboard');
  if (type === 'redis') return new RedisCache(envValue(env, 'REDIS_URL', 'redis://localhost:6379'));
  if (type === 'file') return new FileCache(envValue(env, 'CACHE_PATH', '.cache/news.json'));
  throw new Error(`Unsupported CACHE_TYPE: ${type}`);
}

export function createDashboardDeliveryStore(env = process.env) {
  const type = envValue(env, 'DELIVERY_STORE_TYPE', 'file').toLowerCase();
  if (type !== 'file') throw new Error(`DELIVERY_STORE_TYPE=${type} is unsupported; use file`);
  return new LocalFileDeliveryStore(envValue(env, 'DELIVERY_STORE_PATH', '.cache/delivery-state.json'));
}

export async function startDashboard(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const processLike = dependencies.process ?? process;
  await (dependencies.loadEnvironment ?? loadEnvironment)();

  const runtime = validateDashboardRuntime(env, dependencies.runtimeOptions);
  const auth = createDashboardAuth(env);
  const loadConfig = dependencies.loadConfig ?? defaultLoadConfig;
  const { streams, configPath } = loadConfig(argv[0]);
  for (const stream of streams.filter(item => item.enabled)) validateStreamConfig(stream, env);

  let cache;
  let deliveryStore;
  let scheduler;
  let server;
  let closing;
  try {
    cache = (dependencies.createCache ?? createDashboardCache)(env);
    deliveryStore = (dependencies.createDeliveryStore ?? createDashboardDeliveryStore)(env);
    if (typeof cache.peek === 'function') await cache.peek('__news_dashboard_preflight__');
    if (cache.capabilities?.persistent !== true) throw new Error('Dashboard requires a persistent cache');
    scheduler = (dependencies.createScheduler ?? createScheduler)({
      cache,
      deliveryStore,
      clock: dependencies.clock,
      cron: dependencies.cron,
      env,
      logger,
      executeStream: dependencies.executeStream,
      executeStreamControl: dependencies.executeStreamControl,
      buildEngine: dependencies.buildEngine,
      machineFactory: dependencies.machineFactory,
    });
    await scheduler.init(streams);
    const app = (dependencies.createApp ?? createDashboardApp)({
      scheduler,
      auth,
      runtime,
      version: env.NEWS_BUILD_VERSION || '2.0.0',
      logger,
    });
    server = await createListeningServer(app, runtime, env, dependencies);
    logger.log(`[Config] Loaded from ${configPath}`);
    logger.log(`Dashboard: ${runtime.externalOrigin}`);

    const close = async () => {
      if (closing) return closing;
      closing = (async () => {
        await scheduler.shutdown();
        await closeServer(server);
        await closeResources(cache, deliveryStore, logger);
      })();
      return closing;
    };
    processLike.once?.('SIGINT', close);
    processLike.once?.('SIGTERM', close);
    return { app, server, scheduler, cache, deliveryStore, runtime, close };
  } catch (error) {
    await scheduler?.shutdown({ quiet: true });
    await closeServer(server);
    await closeResources(cache, deliveryStore, logger);
    throw error;
  }
}

async function createListeningServer(app, runtime, env, dependencies) {
  if (dependencies.listen) return dependencies.listen(app, runtime);
  let server;
  if (runtime.appTls) {
    const [cert, key] = await Promise.all([
      readFile(env.DASHBOARD_TLS_CERT_PATH),
      readFile(env.DASHBOARD_TLS_KEY_PATH),
    ]);
    server = createHttpsServer({ cert, key }, app);
  } else {
    server = createHttpServer(app);
  }
  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(runtime.port, runtime.host);
  });
  return server;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function closeResources(cache, deliveryStore, logger) {
  const failures = [];
  try { await deliveryStore?.close?.(); } catch (error) { failures.push(error); }
  try { await cache?.disconnect?.(); } catch (error) { failures.push(error); }
  if (failures.length) logger.error(`Dashboard shutdown failed: ${failures.map(sanitizeRuntimeError).join('; ')}`);
}

async function loadEnvironment() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional.
  }
}

function envValue(env, key, fallback) {
  return env[key] === undefined || env[key] === '' ? fallback : String(env[key]);
}

const isExecutable = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutable) {
  try {
    await startDashboard();
  } catch (error) {
    console.error(`Dashboard startup failed: ${sanitizeRuntimeError(error)}`);
    process.exitCode = 1;
  }
}
