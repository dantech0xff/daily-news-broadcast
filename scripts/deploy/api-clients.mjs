/**
 * HTTP clients for the Dokploy and Cloudflare APIs.
 *
 * - Every mutating call goes through the planner. In a dry run the call is
 *   printed (redacted) and never sent, and the client returns `DRY_RUN`.
 * - Redirects are refused: an auth header must never follow a redirect to
 *   another origin, and a redirecting API URL is a configuration mistake.
 * - Errors carry the HTTP status and provider error codes; their text always
 *   passes through the redactor.
 */

import { CLOUDFLARE_API_BASE } from './config.mjs';
import { redactBody } from './redaction.mjs';

/** Returned by mutating calls in a dry run instead of a provider response. */
export const DRY_RUN = Object.freeze({ dryRun: true });

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDryRun(value) {
  return value === DRY_RUN;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_TEXT = 600;
const MAX_PAGES = 50;

/** A provider call failed. The message never contains secrets. */
export class ApiError extends Error {
  /**
   * @param {{ service: string, method: string, target: string, status?: number|null, codes?: number[], detail?: string }} options
   */
  constructor({ service, method, target, status = null, codes = [], detail = '' }) {
    super(`${service} ${method} ${target} failed${status ? ` with HTTP ${status}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
    this.service = service;
    this.method = method;
    this.target = target;
    this.status = status;
    this.codes = codes;
  }
}

/**
 * @typedef {object} PlannedCall
 * @property {'dokploy'|'cloudflare'} service
 * @property {string} method
 * @property {string} target Procedure (Dokploy) or path (Cloudflare).
 * @property {unknown} [body]
 */

/**
 * Records every mutating call in order; prints it (redacted) in a dry run.
 * @param {{ dryRun: boolean, report: { plan: (line: string) => void } }} options
 * @returns {{ dryRun: boolean, calls: PlannedCall[], record: (call: PlannedCall) => void }}
 */
export function createPlanner({ dryRun, report }) {
  const calls = [];
  return {
    dryRun,
    calls,
    record(call) {
      calls.push(call);
      if (dryRun) {
        const body = call.body === undefined ? '' : ` ${JSON.stringify(redactBody(call.body))}`;
        report.plan(`#${calls.length} ${call.method} ${call.service} ${call.target}${body}`);
      }
    },
  };
}

/**
 * Dokploy REST API: `GET /api/<router>.<procedure>?…` for queries and
 * `POST /api/<router>.<procedure>` with a JSON body for mutations,
 * authenticated with `x-api-key`.
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   fetch: typeof fetch,
 *   planner: ReturnType<typeof createPlanner>,
 *   redactor: import('./redaction.mjs').Redactor,
 *   timeoutMs?: number,
 * }} options
 */
export function createDokployClient({ baseUrl, apiKey, fetch, planner, redactor, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiBase = `${baseUrl}/api`;

  async function send(method, procedure, { query, body } = {}) {
    const url = new URL(`${apiBase}/${procedure}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { 'x-api-key': apiKey, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const fail = (status, detail) => new ApiError({ service: 'Dokploy', method, target: procedure, status, detail: redactor.redact(detail) });
    let response;
    try {
      response = await fetch(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw fail(null, describeFetchError(error, timeoutMs));
    }
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) throw fail(response.status, dokployErrorText(data, text));
    if (data === undefined) throw fail(response.status, 'the response is not JSON (check DOKPLOY_URL)');
    return data;
  }

  return {
    /**
     * @param {string} procedure
     * @param {Record<string, unknown>} [params]
     * @returns {Promise<any>}
     */
    query(procedure, params) {
      return send('GET', procedure, { query: params });
    },
    /**
     * @param {string} procedure
     * @param {Record<string, unknown>} body
     * @returns {Promise<any>} `DRY_RUN` in a dry run.
     */
    async mutate(procedure, body) {
      planner.record({ service: 'dokploy', method: 'POST', target: procedure, body });
      if (planner.dryRun) return DRY_RUN;
      return send('POST', procedure, { body });
    },
  };
}

/**
 * Cloudflare API v4 (bearer token). Results are unwrapped from the
 * `{ success, errors, result }` envelope.
 * @param {{
 *   apiToken: string,
 *   fetch: typeof fetch,
 *   planner: ReturnType<typeof createPlanner>,
 *   redactor: import('./redaction.mjs').Redactor,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 * }} options
 */
export function createCloudflareClient({ apiToken, fetch, planner, redactor, baseUrl = CLOUDFLARE_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  async function send(method, path, { query, body } = {}) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { authorization: `Bearer ${apiToken}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const fail = (status, detail, codes = []) => new ApiError({ service: 'Cloudflare', method, target: path, status, codes, detail: redactor.redact(detail) });
    let response;
    try {
      response = await fetch(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw fail(null, describeFetchError(error, timeoutMs));
    }
    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok || !payload || typeof payload !== 'object' || payload.success === false) {
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const codes = errors.map(error => error?.code).filter(Number.isInteger);
      const detail = errors.length > 0
        ? errors.map(error => `${error?.code ?? '?'} ${error?.message ?? ''}`.trim()).join('; ')
        : truncate(text || 'empty response');
      throw fail(response.status, truncate(detail), codes);
    }
    return payload;
  }

  async function mutate(method, path, body) {
    planner.record({ service: 'cloudflare', method, target: path, body });
    if (planner.dryRun) return DRY_RUN;
    return (await send(method, path, { body })).result;
  }

  return {
    /**
     * @param {string} path
     * @param {Record<string, unknown>} [query]
     * @returns {Promise<any>} The `result` field.
     */
    async get(path, query) {
      return (await send('GET', path, { query })).result;
    },
    /**
     * Every page of a list endpoint.
     * @param {string} path
     * @param {Record<string, unknown>} [query]
     * @returns {Promise<any[]>}
     */
    async list(path, query = {}) {
      const items = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await send('GET', path, { query: page === 1 ? query : { ...query, page } });
        const result = Array.isArray(payload.result) ? payload.result : [];
        items.push(...result);
        const info = payload.result_info ?? {};
        const totalPages = Number.isInteger(info.total_pages)
          ? info.total_pages
          : (Number.isInteger(info.total_count) && Number.isInteger(info.per_page) && info.per_page > 0
            ? Math.ceil(info.total_count / info.per_page)
            : 1);
        if (result.length === 0 || page >= totalPages) return items;
      }
      throw new ApiError({ service: 'Cloudflare', method: 'GET', target: path, detail: `more than ${MAX_PAGES} pages` });
    },
    post: (path, body) => mutate('POST', path, body),
    put: (path, body) => mutate('PUT', path, body),
    patch: (path, body) => mutate('PATCH', path, body),
  };
}

/**
 * @param {unknown} error
 * @param {number} timeoutMs
 * @returns {string}
 */
export function describeFetchError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `no response within ${Math.round(timeoutMs / 1000)} s`;
  const cause = error?.cause;
  const reason = cause?.code ?? cause?.message ?? error?.message ?? String(error);
  return `request failed (${truncate(String(reason))})`;
}

function parseJson(text) {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function dokployErrorText(data, text) {
  if (data && typeof data === 'object') {
    const issues = Array.isArray(data.issues)
      ? data.issues.slice(0, 10).map(issue => `${Array.isArray(issue?.path) ? issue.path.join('.') : '?'}: ${issue?.message ?? ''}`).join('; ')
      : '';
    const message = [data.code, data.message].filter(value => typeof value === 'string' && value).join(': ');
    return truncate([message, issues].filter(Boolean).join(' — ') || JSON.stringify(data));
  }
  return truncate(text || 'empty response');
}

function truncate(text) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > MAX_ERROR_TEXT ? `${value.slice(0, MAX_ERROR_TEXT)}…` : value;
}
