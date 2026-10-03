import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignJWT, calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import { startServer } from '../../../src/app/server.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../../helpers/fakes.js';
import { FakeCron, FakeTimers, MASTER_KEY, channelInput, mutableClock } from './runtime-fixture.js';

export const ACCESS_ISSUER = 'https://test-team.cloudflareaccess.com';
export const ACCESS_AUD = 'test-app-aud-tag';
export const PUBLIC_ORIGIN = 'https://radar.example.test';
export const OPERATOR_EMAIL = 'ops@example.test';
export const VIEWER_EMAIL = 'viewer@example.test';
export const SERVICE_OPERATOR_ID = 'svc-operator.access';
export const SERVICE_VIEWER_ID = 'svc-viewer.access';

/** Claims of each test identity; `unmapped*` are valid Access identities without a role. */
export const IDENTITIES = Object.freeze({
  operator: Object.freeze({ email: OPERATOR_EMAIL }),
  viewer: Object.freeze({ email: VIEWER_EMAIL }),
  unmapped: Object.freeze({ email: 'stranger@example.test' }),
  serviceOperator: Object.freeze({ common_name: SERVICE_OPERATOR_ID }),
  serviceViewer: Object.freeze({ common_name: SERVICE_VIEWER_ID }),
  serviceUnmapped: Object.freeze({ common_name: 'svc-unknown.access' }),
});

/** Credential values used through the API; they must never come back out. */
export const SECRET_VALUES = Object.freeze({
  botToken: '123456:API-test-bot-token-secret',
  chatId: '-1009876543210',
  aiKey: 'sk-api-test-ai-key-secret',
});

/**
 * An RSA signing key with its public JWKS and a local key resolver, like the
 * Access team keys (`kid`-selected, RS256).
 */
export async function createAccessSigner() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };
  return {
    jwks,
    kid,
    privateKey,
    keySet: createLocalJWKSet(jwks),
    sign: (claims, options = {}) => signAccessToken(privateKey, { kid, ...options }, claims),
  };
}

let sharedSigner;
/** One signing key per test file: RSA key generation is slow. */
export function sharedAccessSigner() {
  sharedSigner ??= createAccessSigner();
  return sharedSigner;
}

/**
 * Sign an Access-style token.
 * @param {CryptoKey|Uint8Array} key
 * @param {{ kid?: string, alg?: string, issuer?: string, audience?: string|string[], now?: Date, ttlSeconds?: number, omitExp?: boolean }} options
 * @param {Record<string, unknown>} claims
 */
export async function signAccessToken(key, {
  kid,
  alg = 'RS256',
  issuer = ACCESS_ISSUER,
  audience = [ACCESS_AUD],
  now = new Date(),
  ttlSeconds = 3_600,
  omitExp = false,
} = {}, claims = {}) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const jwt = new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader({ alg, typ: 'JWT', ...(kid ? { kid } : {}) })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt);
  if (!omitExp) jwt.setExpirationTime(issuedAt + ttlSeconds);
  return jwt.sign(key);
}

/** Valid app environment for tests (ephemeral port, test Access issuer/AUD). */
export function appEnv(dataDir, overrides = {}) {
  return {
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: dataDir,
    APP_MASTER_KEY: MASTER_KEY,
    ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
    ACCESS_AUD,
    APP_OPERATOR_EMAILS: OPERATOR_EMAIL,
    APP_VIEWER_EMAILS: VIEWER_EMAIL,
    APP_SERVICE_TOKEN_ROLES: `${SERVICE_OPERATOR_ID}:operator,${SERVICE_VIEWER_ID}:viewer`,
    PUBLIC_ORIGIN,
    ...overrides,
  };
}

/** Logger that keeps every line for leak assertions. */
export function capturingLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  return { lines, logger: { log: push, warn: push, error: push } };
}

/**
 * Start the real app (`startServer`) on 127.0.0.1 with a temp data directory,
 * the shared test signing key, fake cron/timers, and recording plugins.
 */
export async function startTestApp(t, {
  articles = [],
  aiText = 'Bản tin công nghệ đã tóm tắt',
  outputResults = [],
  env = {},
  dependencies = {},
  clock = mutableClock(),
  webDir,
  prepare,
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-radar-api-'));
  let handle = null;
  t.after(async () => {
    await handle?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  if (prepare) await prepare(dataDir, clock);

  const signer = await sharedAccessSigner();
  const { lines: logs, logger } = capturingLogger();
  const plugins = {
    source: new RecordingSource(articles),
    ai: new RecordingAI(aiText),
    output: new RecordingOutput({ results: outputResults }),
  };
  const cron = new FakeCron();
  handle = await startServer(appEnv(dataDir, env), {
    keySet: signer.keySet,
    clock,
    logger,
    cron,
    timers: new FakeTimers(),
    process: null,
    ownerId: 'api-test-owner',
    webDir: webDir ?? join(dataDir, 'missing-web-build'),
    channelFactories: {
      createSources: () => [plugins.source],
      createAI: () => plugins.ai,
      createOutput: () => plugins.output,
    },
    serverCloseGraceMs: 200,
    ...dependencies,
  });

  const tokens = {};
  for (const [name, claims] of Object.entries(IDENTITIES)) tokens[name] = await signer.sign(claims, { now: clock() });
  const responses = [];
  const api = createApiClient(handle.url, tokens, responses);
  return { handle, url: handle.url, dataDir, signer, tokens, logs, plugins, cron, clock, api, responses };
}

/**
 * Request helper bound to a server. `as` selects a test identity token (or
 * is used as a raw token); mutations default to the public origin, a JSON
 * content type, and an empty `{}` body (`origin: null`, `contentType: null`,
 * `body: null` omit them). Every response is recorded.
 */
export function createApiClient(baseUrl, tokens = {}, responses = []) {
  return async function api(path, { as, method = 'GET', body, rawBody, headers = {}, origin, contentType } = {}) {
    const mutation = method !== 'GET' && method !== 'HEAD';
    const finalHeaders = { ...headers };
    if (as) finalHeaders['cf-access-jwt-assertion'] = tokens[as] ?? as;
    if (mutation && origin !== null) finalHeaders.origin = origin ?? PUBLIC_ORIGIN;
    if (mutation && contentType !== null) finalHeaders['content-type'] = contentType ?? 'application/json';
    let payload = rawBody;
    if (payload === undefined && body !== null) payload = body === undefined ? (mutation ? {} : undefined) : body;
    const response = await httpRequest(baseUrl, path, { method, headers: finalHeaders, body: payload });
    responses.push(response);
    return response;
  };
}

/**
 * Plain `node:http` request (global fetch is blocked in tests).
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string, body: any }>}
 */
export function httpRequest(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, baseUrl), {
      method,
      agent: false,
      headers: { ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (String(response.headers['content-type'] ?? '').includes('application/json') && text) parsed = JSON.parse(text);
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/**
 * Open `/api/events` and collect frames. `next(predicate)` resolves with the
 * first frame (already received or future) that matches.
 */
export function openEventStream(baseUrl, token, { path = '/api/events' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(path, baseUrl), {
      agent: false,
      headers: token ? { 'cf-access-jwt-assertion': token } : {},
    }, response => {
      request.removeListener('error', reject);
      request.on('error', () => {});
      response.setEncoding('utf8');
      const frames = [];
      const waiters = new Set();
      let buffer = '';
      let raw = '';
      const ended = new Promise(settle => {
        response.on('end', settle);
        response.on('close', settle);
      });
      response.on('data', chunk => {
        raw += chunk;
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = parseFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          frames.push(frame);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(frame)) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              waiter.resolve(frame);
            }
          }
        }
      });
      resolve({
        status: response.statusCode,
        headers: response.headers,
        frames,
        ended,
        get raw() { return raw; },
        next(predicate, timeoutMs = 2_000) {
          const found = frames.find(predicate);
          if (found) return Promise.resolve(found);
          return new Promise((settle, fail) => {
            const waiter = { predicate, resolve: settle };
            waiter.timer = setTimeout(() => {
              waiters.delete(waiter);
              fail(new Error(`No matching event within ${timeoutMs} ms; received: ${raw.slice(0, 2_000)}`));
            }, timeoutMs);
            waiters.add(waiter);
          });
        },
        close() {
          request.destroy();
        },
      });
    });
    request.on('error', reject);
  });
}

function parseFrame(text) {
  const frame = { comments: [], data: null, retry: null };
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) frame.comments.push(line.slice(1).trim());
    else if (line.startsWith('data:')) frame.data = JSON.parse(line.slice(5).trim());
    else if (line.startsWith('retry:')) frame.retry = Number(line.slice(6).trim());
  }
  return frame;
}

/** Create the three channel credentials through the API; returns their ids. */
export async function createCredentialsViaApi(api, as = 'operator') {
  const create = async (label, kind, value) => {
    const response = await api('/api/credentials', { as, method: 'POST', body: { label, kind, value } });
    if (response.status !== 201) throw new Error(`Credential create failed: ${response.status} ${response.text}`);
    return response.body.id;
  };
  return {
    botToken: await create('Bot', 'telegram_bot_token', SECRET_VALUES.botToken),
    chatId: await create('Chat', 'telegram_chat_id', SECRET_VALUES.chatId),
    aiKey: await create('Claude', 'ai_api_key', SECRET_VALUES.aiKey),
  };
}

/** Create a channel (paused) through the API with stored credentials. */
export async function createChannelViaApi(api, credentialIds, overrides = {}) {
  const response = await api('/api/channels', { as: 'operator', method: 'POST', body: channelInput(credentialIds, overrides) });
  if (response.status !== 201) throw new Error(`Channel create failed: ${response.status} ${response.text}`);
  return response.body;
}

/** Resume a channel through the control API using its current delivery-state version. */
export async function resumeViaApi(api, channelId, as = 'operator') {
  const status = await api(`/api/channels/${channelId}/status`, { as });
  return api(`/api/channels/${channelId}/control/resume`, {
    as,
    method: 'POST',
    body: { idempotencyKey: `resume-${channelId}-${status.body.version}`, expectedVersion: status.body.version, reason: 'Ready to deliver' },
  });
}

/** Poll until `GET /api/runs/:id` reports a finished run. */
export async function waitForRun(api, runId, { as = 'viewer', timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(`/api/runs/${runId}`, { as });
    if (response.status === 200 && response.body.status !== 'running') return response.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs} ms`);
}
