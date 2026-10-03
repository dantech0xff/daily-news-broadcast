/**
 * HTTP clients of the cutover script, and readers that validate the parts of
 * each response the script relies on.
 *
 * - Worker: `GET /status?channel=telegram-main` authenticated with
 *   TRIGGER_SECRET; `POST /control/<action>` authenticated with
 *   OPERATOR_SECRET, with a JSON body `{ channelId, expectedVersion, reason }`
 *   and an `Idempotency-Key` header.
 * - App: every request carries the Access service token headers and goes
 *   only to https://APP_HOSTNAME; mutations add `Origin` (the app's
 *   PUBLIC_ORIGIN) and `Content-Type: application/json`.
 *
 * Redirects are never followed: a credential must not travel to another
 * origin, and a redirect from Access means the service token was refused.
 * Errors carry the HTTP status and the API's machine code; their text passes
 * through the redactor and never contains request headers.
 */

import { ApiError, describeFetchError } from './api-clients.mjs';
import { CHANNEL_ID } from './cutover-config.mjs';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** App API paths of the channel. */
export const APP_PATHS = Object.freeze({
  health: '/api/health',
  channel: `/api/channels/${CHANNEL_ID}`,
  status: `/api/channels/${CHANNEL_ID}/status`,
  preview: `/api/channels/${CHANNEL_ID}/preview`,
  run: `/api/channels/${CHANNEL_ID}/run`,
  runs: `/api/channels/${CHANNEL_ID}/runs`,
  content: '/api/content',
  /** @param {'pause'|'resume'} action */
  control: action => `/api/channels/${CHANNEL_ID}/control/${action}`,
});

const WORKER_CONTROL_ACTIONS = Object.freeze(['pause', 'resume']);
const MAX_DETAIL_CHARS = 600;
const ACCESS_REFUSED = 'Cloudflare Access did not accept the service token (check CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, and the Access service-token policy)';
// What to do about the app's error codes (src/app/api/errors.js).
const APP_HINTS = Object.freeze({
  unauthenticated: 'the request reached the app without a valid Access token for the service token',
  forbidden: 'the service token is not mapped to the operator role (APP_SERVICE_TOKEN_ROLES on the app)',
  same_origin_required: "the app's PUBLIC_ORIGIN must be https://APP_HOSTNAME",
  missing_credential: 'assign the channel credentials in the dashboard first',
  credential_unavailable: 'the stored credentials cannot be read; enter them again in the dashboard',
  cutover_required: 'notBefore is not set on the channel',
  version_conflict: 'the state changed concurrently; read it again',
  runtime_not_leased: 'the app instance does not hold the runtime lease yet; retry in a minute',
  runtime_stopped: 'the app is shutting down; retry after it restarts',
  channel_busy: 'the channel is already running or queued',
});

/** A Worker or app request failed. The message never contains secrets. */
export class RequestError extends ApiError {
  /**
   * @param {{ service: string, method: string, target: string, status?: number|null, code?: string|null, detail?: string }} options
   */
  constructor({ service, method, target, status = null, code = null, detail = '' }) {
    super({ service, method, target, status, detail });
    this.name = 'RequestError';
    /** The API's machine code (`error` field of the response), when it sent one. */
    this.code = code;
  }
}

/**
 * @typedef {object} WorkerView The Worker's view of the channel (`GET /status`).
 * @property {string} runtimeMode
 * @property {boolean} paused
 * @property {number} version Channel delivery-state version (`expectedVersion` of pause/resume).
 * @property {string|null} mutationState
 * @property {string|null} updatedAt
 * @property {Record<string, number>} counts
 * @property {{ publishingDay?: string|null, total?: number, remaining?: number, blocked?: number }|null} queue
 * @property {{ state?: string, outcome?: string, triggerType?: string, updatedAt?: string }|null} lastRequest
 */

/**
 * @param {{
 *   url: string,
 *   triggerSecret: string,
 *   operatorSecret: string|null,
 *   fetch: typeof fetch,
 *   redactor: import('./redaction.mjs').Redactor,
 *   timeoutMs?: number,
 * }} options
 */
export function createWorkerClient({ url, triggerSecret, operatorSecret, fetch, redactor, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const hint = secretName => (status, code) => {
    if (status === 401) return `check ${secretName}`;
    if (status !== null && status >= 300 && status < 400) return 'check WORKER_URL';
    return code === 'request_conflict' ? 'the channel version or the idempotency key conflicts' : '';
  };
  return {
    url,

    /** @returns {Promise<WorkerView>} */
    async status() {
      const data = await requestJson({
        fetch,
        redactor,
        service: 'Worker',
        method: 'GET',
        url: `${url}/status?channel=${encodeURIComponent(CHANNEL_ID)}&limit=1`,
        target: '/status',
        headers: { accept: 'application/json', authorization: `Bearer ${triggerSecret}` },
        timeoutMs,
        hint: hint('TRIGGER_SECRET'),
      });
      return readWorkerStatus(data);
    },

    /**
     * @param {'pause'|'resume'} action
     * @param {{ expectedVersion: number, idempotencyKey: string, reason: string }} params
     * @returns {Promise<Record<string, unknown>>} The Worker's control result.
     */
    async control(action, params) {
      if (!WORKER_CONTROL_ACTIONS.includes(action)) throw new TypeError(`Unsupported Worker control: ${String(action)}`);
      if (!operatorSecret) throw new Error('OPERATOR_SECRET is required for Worker controls.');
      return requestJson({
        fetch,
        redactor,
        service: 'Worker',
        method: 'POST',
        url: `${url}/control/${action}`,
        target: `/control/${action}`,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${operatorSecret}`,
          'content-type': 'application/json',
          'idempotency-key': params.idempotencyKey,
        },
        body: workerControlBody(params),
        timeoutMs,
        hint: hint('OPERATOR_SECRET'),
      });
    },

    /**
     * The control request as a plan line, secrets named but never included.
     * @param {'pause'|'resume'} action
     * @param {{ expectedVersion: number, idempotencyKey: string, reason: string }} params
     * @returns {string}
     */
    describeControl(action, params) {
      return `POST ${url}/control/${action} authenticated with OPERATOR_SECRET; Content-Type: application/json; `
        + `Idempotency-Key: ${params.idempotencyKey}; body ${JSON.stringify(workerControlBody(params))}`;
    },
  };
}

/**
 * @param {{
 *   hostname: string,
 *   clientId: string,
 *   clientSecret: string,
 *   fetch: typeof fetch,
 *   redactor: import('./redaction.mjs').Redactor,
 *   timeoutMs?: number,
 * }} options
 */
export function createAppClient({ hostname, clientId, clientSecret, fetch, redactor, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const origin = `https://${hostname}`;

  async function send(method, path, { query, body, timeout } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new TypeError('App requests stay on APP_HOSTNAME');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = {
      accept: 'application/json',
      'cf-access-client-id': clientId,
      'cf-access-client-secret': clientSecret,
    };
    if (method !== 'GET') {
      headers.origin = origin;
      headers['content-type'] = 'application/json';
    }
    return requestJson({
      fetch,
      redactor,
      service: 'App',
      method,
      url: url.href,
      target: url.pathname,
      headers,
      body: method === 'GET' ? undefined : (body ?? {}),
      timeoutMs: timeout ?? timeoutMs,
      hint: appHint,
    });
  }

  // Responses are untrusted JSON objects (`any` on purpose): callers check the
  // fields they rely on through the readers below or with explicit guards.
  return {
    origin,
    /**
     * @param {string} path
     * @param {Record<string, unknown>} [query]
     * @returns {Promise<Record<string, any>>}
     */
    get: (path, query) => send('GET', path, { query }),
    /**
     * @param {string} path
     * @param {Record<string, unknown>} body
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    post: (path, body, options = {}) => send('POST', path, { body, timeout: options.timeoutMs }),
    /**
     * @param {string} path
     * @param {Record<string, unknown>} body
     * @returns {Promise<Record<string, any>>}
     */
    put: (path, body) => send('PUT', path, { body }),
    /**
     * A mutation as a plan line, secrets named but never included.
     * @param {'POST'|'PUT'} method
     * @param {string} path
     * @param {Record<string, unknown>} body
     * @returns {string}
     */
    describe(method, path, body) {
      return `${method} ${origin}${path} with the service token (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET); `
        + `Origin: ${origin}; Content-Type: application/json; body ${JSON.stringify(body ?? {})}`;
    },
  };
}

// The readers cast untrusted JSON to `any` and then check every field they return.

/**
 * @param {unknown} data `GET /status` response of the Worker.
 * @returns {WorkerView}
 */
export function readWorkerStatus(data) {
  const channel = /** @type {any} */ (data)?.channel;
  if (!channel || typeof channel !== 'object') {
    throw new Error(`The Worker /status response has no channel state for ${CHANNEL_ID}; inspect the Worker before continuing.`);
  }
  if ((channel.channelId !== undefined && channel.channelId !== CHANNEL_ID)
    || typeof channel.paused !== 'boolean' || !Number.isSafeInteger(channel.version)) {
    throw new Error('The Worker /status response does not have the expected channel fields (channelId, paused, version).');
  }
  const value = /** @type {any} */ (data);
  return {
    runtimeMode: typeof value.runtimeMode === 'string' ? value.runtimeMode : 'unknown',
    paused: channel.paused,
    version: channel.version,
    mutationState: typeof channel.mutationState === 'string' ? channel.mutationState : null,
    updatedAt: typeof channel.updatedAt === 'string' ? channel.updatedAt : null,
    counts: numericFields(value.counts),
    queue: value.queue && typeof value.queue === 'object' ? value.queue : null,
    lastRequest: value.lastRequest && typeof value.lastRequest === 'object' ? value.lastRequest : null,
  };
}

/**
 * @typedef {object} AppStatusView The app's view of the channel (`GET /api/channels/:id/status`).
 * @property {boolean|null} paused `null` when the channel has no delivery state.
 * @property {number|null} version Delivery-state version (`expectedVersion` of pause/resume).
 * @property {number|null} configVersion Config version (the `version` of a channel update).
 * @property {boolean} enabled
 * @property {boolean} cutoverRequired
 * @property {string|null} notBefore
 * @property {string|null} mutationState
 * @property {number|null} unresolvedCount
 * @property {Record<string, unknown>|null} queue
 * @property {Record<string, any>|null} lastRun
 */

/**
 * @param {unknown} data
 * @returns {AppStatusView}
 */
export function readAppStatus(data) {
  const value = /** @type {any} */ (data);
  if (value?.channelId !== CHANNEL_ID) {
    throw new Error(`The app status response is not about ${CHANNEL_ID}.`);
  }
  return {
    paused: typeof value.paused === 'boolean' ? value.paused : null,
    version: Number.isSafeInteger(value.version) ? value.version : null,
    configVersion: Number.isSafeInteger(value.configVersion) ? value.configVersion : null,
    enabled: value.enabled !== false,
    cutoverRequired: value.cutoverRequired === true,
    notBefore: typeof value.notBefore === 'string' && value.notBefore !== '' ? value.notBefore : null,
    mutationState: typeof value.mutationState === 'string' ? value.mutationState : null,
    unresolvedCount: Number.isSafeInteger(value.unresolvedCount) ? value.unresolvedCount : null,
    queue: value.queue && typeof value.queue === 'object' ? value.queue : null,
    lastRun: value.lastRun && typeof value.lastRun === 'object' ? value.lastRun : null,
  };
}

/**
 * @param {unknown} data `GET` or `PUT /api/channels/:id` response.
 * @returns {{ version: number, notBefore: string|null, cutoverRequired: boolean }}
 */
export function readChannelRecord(data) {
  const value = /** @type {any} */ (data);
  if (value?.id !== CHANNEL_ID || !Number.isSafeInteger(value.version)) {
    throw new Error(`The app channel response is not the ${CHANNEL_ID} record (id, version).`);
  }
  return {
    version: value.version,
    notBefore: typeof value.notBefore === 'string' && value.notBefore !== '' ? value.notBefore : null,
    cutoverRequired: value.cutoverRequired === true,
  };
}

/**
 * A paginated app listing: `{ <key>: [...], page: { total } }`.
 * @param {unknown} data
 * @param {'items'|'runs'} key
 * @returns {{ entries: any[], total: number }}
 */
export function readPage(data, key) {
  const value = /** @type {any} */ (data);
  if (!Array.isArray(value?.[key]) || !Number.isSafeInteger(value?.page?.total)) {
    throw new Error(`The app listing response has no "${key}" page.`);
  }
  return { entries: value[key], total: value.page.total };
}

function workerControlBody({ expectedVersion, reason }) {
  return { channelId: CHANNEL_ID, expectedVersion, reason };
}

function appHint(status, code) {
  if (code && APP_HINTS[code]) return APP_HINTS[code];
  if (status !== null && status >= 300 && status < 400) return ACCESS_REFUSED;
  if ((status === 401 || status === 403) && !code) return ACCESS_REFUSED;
  if (status === 524) return 'Cloudflare stopped waiting for the app after about 100 s; the request may still finish on the app';
  return '';
}

async function requestJson({ fetch, redactor, service, method, url, target, headers, body, timeoutMs, hint }) {
  const fail = (status, code, detail) => {
    const extra = hint(status, code);
    return new RequestError({
      service,
      method,
      target,
      status,
      code,
      detail: redactor.redact(truncate(extra ? `${detail} (${extra})` : detail)),
    });
  };
  let response = null;
  let text;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw fail(response?.status ?? null, null, describeFetchError(error, timeoutMs));
  }
  if (response.status >= 300 && response.status < 400) {
    throw fail(response.status, null, `redirected to ${redirectHost(response.headers.get('location'), url)}`);
  }
  const data = parseJson(text);
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : null;
    throw fail(response.status, code, describeErrorBody(data));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw fail(response.status, null, 'the response is not a JSON object');
  }
  return data;
}

function describeErrorBody(data) {
  if (!data || typeof data !== 'object') return 'non-JSON response';
  const parts = [typeof data.error === 'string' ? data.error : JSON.stringify(data)];
  if (Array.isArray(data.issues)) {
    parts.push(`issues: ${data.issues.slice(0, 10).map(issue => `${issue?.field || '(body)'} ${issue?.code ?? ''}`.trim()).join(', ')}`);
  }
  const details = data.details && typeof data.details === 'object' ? data.details : {};
  if (Array.isArray(details.fields)) parts.push(`fields: ${details.fields.slice(0, 20).join(', ')}`);
  if (typeof details.reason === 'string') parts.push(`reason: ${details.reason}`);
  if (Number.isSafeInteger(details.currentVersion)) parts.push(`current version ${details.currentVersion}`);
  if (Number.isSafeInteger(details.unresolved)) parts.push(`${details.unresolved} unresolved`);
  if (typeof data.runtimeMode === 'string') parts.push(`runtimeMode ${data.runtimeMode}`);
  return parts.join('; ');
}

function numericFields(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => Number.isSafeInteger(entry)));
}

function redirectHost(location, base) {
  try {
    return location ? new URL(location, base).hostname : '(no location)';
  } catch {
    return '(unreadable location)';
  }
}

function parseJson(text) {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(text) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value;
}
