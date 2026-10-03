#!/usr/bin/env node
/**
 * E2E test server: the real app (`startServer`) on 127.0.0.1:4310 with the
 * real built dashboard (`web/dist`), fully offline.
 *
 * - A fresh temp directory per start holds `DATA_DIR`, the Access signing keys,
 *   the harness description for the specs, and the JSONL files of sends and
 *   blocked network attempts; it is removed on shutdown.
 * - Cloudflare Access is simulated with a real RSA key pair: the app verifies
 *   tokens against `ACCESS_JWKS_FILE` (accepted because `NODE_ENV=test`); the
 *   operator, viewer, and an unmapped identity each get a signed token.
 * - Sources, AI, and Telegram are fakes injected as `channelFactories`;
 *   schedules never fire (`INERT_CRON`). Production code has no test flag.
 * - Every non-loopback connection is refused (`network-guard.js`).
 *
 * Normally started by `global-setup.js`, which waits for the ready line on
 * stdout and stops it after the run. On SIGTERM/SIGINT, or when its stdin pipe
 * closes while `E2E_HARNESS_STDIN_LIFELINE=1` (the runner went away), it closes
 * the server, deletes the temp directory, and exits.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
  E2E_HOST,
  E2E_ORIGIN,
  E2E_PORT,
  HARNESS_LIFELINE_ENV,
  HARNESS_READY_PREFIX,
  HARNESS_TEMP_PREFIX,
  IDENTITIES,
  TOKEN_TTL_SECONDS,
  buildFixture,
} from './fixtures/constants.js';
import { installNetworkGuard } from './fixtures/network-guard.js';

// Before the app and plugin modules load, so none of them can capture the unguarded fetch.
const guard = installNetworkGuard();
await guard.selfTest();

const { ensureDevKeys, signDevAccessToken } = await import('../../scripts/dev-access-token.mjs');
const { describeStartupError, startServer } = await import('../../src/app/server.js');
const { createE2eChannelFactories, INERT_CRON } = await import('./fixtures/fake-plugins.js');

const WEB_BUILD_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

const log = message => process.stdout.write(`[E2E harness] ${message}\n`);

let tempRoot = null;
let server = null;
let stopping = null;

function shutdown(reason, { failed = false } = {}) {
  stopping ??= (async () => {
    log(`Stopping (${reason})`);
    let exitCode = failed ? 1 : 0;
    try {
      await server?.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`[E2E harness] Server shutdown failed: ${describeStartupError(error)}\n`);
    }
    try {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`[E2E harness] Could not remove ${tempRoot}: ${error?.code ?? error}\n`);
    }
    log(exitCode === 0 ? 'Stopped' : 'Stopped with errors');
    process.exit(exitCode);
  })();
  return stopping;
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
// Once the runner reading this output is gone, writes fail with EPIPE; that must
// not crash the process before the shutdown below has cleaned up.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
if (process.env[HARNESS_LIFELINE_ENV] === '1') {
  process.stdin.on('end', () => void shutdown('the parent process closed stdin'));
  process.stdin.on('error', () => void shutdown('stdin failed'));
  process.stdin.resume();
}

try {
  if (!existsSync(join(WEB_BUILD_DIR, 'index.html'))) {
    throw new Error('The dashboard is not built (web/dist/index.html is missing); run `npm run web:build` first');
  }

  tempRoot = await mkdtemp(join(tmpdir(), HARNESS_TEMP_PREFIX));
  const dataDir = join(tempRoot, 'data');
  await mkdir(dataDir);
  const sentFile = join(dataDir, 'e2e-sent-messages.jsonl');
  const blockedFile = join(tempRoot, 'blocked-network.jsonl');
  guard.onBlocked(entry => appendFileSync(blockedFile, `${JSON.stringify(entry)}\n`));

  // Throwaway Access signing key, deleted with the temp directory.
  const { privateJwk, jwksPath } = await ensureDevKeys(join(tempRoot, 'access-keys'));
  const tokens = {};
  for (const [role, email] of Object.entries(IDENTITIES)) {
    ({ token: tokens[role] } = await signDevAccessToken({
      privateJwk,
      email,
      issuer: ACCESS_TEAM_DOMAIN,
      audience: ACCESS_AUD,
      ttlSeconds: TOKEN_TTL_SECONDS,
    }));
  }

  const startedAt = new Date();
  const fixture = buildFixture(startedAt);
  // An explicit environment: nothing from the developer's shell or `.env` reaches the app.
  const env = {
    NODE_ENV: 'test',
    HOST: E2E_HOST,
    PORT: String(E2E_PORT),
    DATA_DIR: dataDir,
    APP_MASTER_KEY: randomBytes(32).toString('base64'),
    ACCESS_JWKS_FILE: jwksPath,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    APP_OPERATOR_EMAILS: IDENTITIES.operator,
    APP_VIEWER_EMAILS: IDENTITIES.viewer,
    PUBLIC_ORIGIN: E2E_ORIGIN,
    SHUTDOWN_WAIT_SECONDS: '10',
  };

  server = await startServer(env, {
    channelFactories: createE2eChannelFactories({ articles: fixture.articles, sentFile }),
    cron: INERT_CRON,
    webDir: WEB_BUILD_DIR,
    ownerId: 'e2e-harness',
    serverCloseGraceMs: 1_000,
    process: null,
  });

  const infoFile = join(tempRoot, 'harness.json');
  await writeFile(infoFile, `${JSON.stringify({
    baseURL: E2E_ORIGIN,
    startedAt: startedAt.toISOString(),
    dataDir,
    sentFile,
    blockedFile,
    tokens,
    fixture,
  }, null, 2)}\n`, { mode: 0o600 });

  process.stdout.write(`${HARNESS_READY_PREFIX}${JSON.stringify({ infoFile, tempRoot, url: server.url })}\n`);
} catch (error) {
  process.stderr.write(`[E2E harness] Startup failed: ${error?.code === 'EADDRINUSE'
    ? `port ${E2E_PORT} is already in use`
    : describeStartupError(error)}\n`);
  await shutdown('startup failed', { failed: true });
}
