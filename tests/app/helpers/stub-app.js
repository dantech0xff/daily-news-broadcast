import http from 'node:http';

import { createAccessVerifier } from '../../../src/app/auth/access-jwt.js';
import { createRoleResolver } from '../../../src/app/auth/roles.js';
import { createApp } from '../../../src/app/create-app.js';
import {
  ACCESS_AUD,
  ACCESS_ISSUER,
  IDENTITIES,
  OPERATOR_EMAIL,
  PUBLIC_ORIGIN,
  VIEWER_EMAIL,
  capturingLogger,
  createApiClient,
  sharedAccessSigner,
} from './app-server.js';

/** Fixed time of the stub app's verifier and event streams. */
export const STUB_NOW = new Date('2026-10-03T08:00:00.000Z');

/** Minimal runtime double: an event bus plus whatever methods a test overrides. */
export function stubRuntime(overrides = {}) {
  const listeners = new Set();
  return {
    listeners,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    getHealth: () => ({ ownerId: 'stub', active: true, leased: true, leaseHolder: null, running: null, queued: 0, scheduledChannels: 0 }),
    listChannels: () => [],
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
}

/** `createApp()` over a stub runtime, listening on an ephemeral 127.0.0.1 port. */
export async function startStubApp(t, { runtime = stubRuntime(), sseHeartbeatMs = 60_000, webDir = '/nonexistent-web-build' } = {}) {
  const signer = await sharedAccessSigner();
  const { lines: logs, logger } = capturingLogger();
  const { app, closeEventStreams } = createApp({
    runtime,
    verifier: createAccessVerifier({ issuer: ACCESS_ISSUER, audience: [ACCESS_AUD], keySet: signer.keySet, clock: () => STUB_NOW }),
    roles: createRoleResolver({ operatorEmails: [OPERATOR_EMAIL], viewerEmails: [VIEWER_EMAIL], serviceTokens: [] }),
    publicOrigin: PUBLIC_ORIGIN,
    version: 'test',
    webDir,
    logger,
    clock: () => STUB_NOW,
    sseHeartbeatMs,
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    closeEventStreams();
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const [name, claims] of Object.entries(IDENTITIES)) tokens[name] = await signer.sign(claims, { now: STUB_NOW });
  return { runtime, url, logs, tokens, closeEventStreams, api: createApiClient(url, tokens) };
}

/** Resolve once `condition()` is true, polling on the event loop. */
export async function eventually(condition, { timeoutMs = 2_000, message = 'condition was not met' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
