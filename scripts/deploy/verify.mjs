/**
 * Checks of the live deployment (acceptance A3):
 * 1. Anonymous requests never get app content: Cloudflare Access answers
 *    first (a redirect to the team domain, or 401/403).
 * 2. With the agent's service token, `/api/health` is 200 with the runtime
 *    lease held and a channel count, and `telegram-main` is either paused or
 *    active with its cutover mark (`notBefore`) set.
 * 3. The origin, asked the way Cloudflare's proxy asks it (HTTPS to the VPS
 *    address, SNI and Host APP_HOSTNAME): Traefik routes `/healthz` to the
 *    app, and `/api/health` gets the app's own 401, so without an Access JWT
 *    the origin serves no app data.
 * 4. DNS: APP_HOSTNAME is one proxied A record to the origin address.
 * 5. Dokploy: the app has the expected Traefik domain, no published port, one
 *    replica, and stop-first updates.
 * 6. With `--redeploy-check`: a redeploy keeps the data (same channel
 *    `createdAt`) and only one instance runs afterwards.
 * The service token secret is sent only to https://APP_HOSTNAME, and
 * redirects are never followed with it. The origin address is never printed.
 */

import { request as httpsRequest } from 'node:https';

import { describeDnsRecords, findDnsRecords, isOriginRecord } from './cloudflare-steps.mjs';
import { NAMES, SWARM_UPDATE_CONFIG } from './config.mjs';
import {
  deployAndWait, describeTraefikDomain, domainDifferences, locateDokployResources, otherDomainsWarning, partitionDomains,
  publishedPortsOf, readApplication, readDomains, POLL_INTERVAL_MS,
} from './dokploy-steps.mjs';
import { describeFetchError } from './api-clients.mjs';
import { ORIGIN_MASK } from './redaction.mjs';
import { errorMessage } from './run-context.mjs';

const CHANNEL_ID = 'telegram-main';
const REQUEST_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;
const HTTPS_PORT = 443;
const HEALTHZ_PATH = '/healthz';
const ORIGIN_PATHS = Object.freeze([HEALTHZ_PATH, '/api/health']);
const MAX_BODY_CHARS = 256 * 1024;
const APP_RESTART_WAIT_MS = 5 * 60_000;
const INSTANCE_SAMPLES = 5;
const ACCESS_TEAM_SUFFIX = '.cloudflareaccess.com';
const APP_ERROR_CODES = new Set(['unauthenticated', 'forbidden', 'access_keys_unavailable']);
const APP_CONTENT_MARKERS = ['<div id="root">', '<title>Content Radar</title>'];
// Texts of the app's own HTML error pages (src/app/api/errors.js).
const APP_ERROR_MARKERS = ['Cần đăng nhập qua Cloudflare Access', 'Chưa xác thực', 'Không có quyền truy cập'];
// Traefik's answer for a host it has no route for.
const TRAEFIK_404 = /^404 page not found$/i;

/**
 * @typedef {object} Classification
 * @property {'pass'|'fail'} verdict
 * @property {string} kind
 * @property {string} detail
 */

/**
 * @typedef {object} OriginProbeResult
 * @property {number} [status]
 * @property {Record<string, unknown>} [headers]
 * @property {string} [body] At most `MAX_BODY_CHARS` characters.
 * @property {string} [error] Error code when no HTTP answer arrived.
 */

/**
 * Is a response from the app itself? `content`: dashboard or API data;
 * `error`: the app's own authentication error.
 * @param {unknown} body
 * @param {unknown} contentType
 * @returns {'content'|'error'|null}
 */
export function appResponseKind(body, contentType) {
  const text = typeof body === 'string' ? body : '';
  if (/json/i.test(String(contentType ?? '')) || /^\s*[{[]/.test(text)) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === 'object') {
        if (typeof json.error === 'string' && APP_ERROR_CODES.has(json.error) && typeof json.message === 'string') return 'error';
        if ('channelCount' in json || (json.status === 'ok' && json.runtime) || Array.isArray(json.channels)) return 'content';
      }
    } catch {
      // Not JSON: fall through to the HTML markers.
    }
  }
  if (APP_CONTENT_MARKERS.some(marker => text.includes(marker))) return 'content';
  if (APP_ERROR_MARKERS.some(marker => text.includes(marker))) return 'error';
  return null;
}

/**
 * Classify the answer to an anonymous request for APP_HOSTNAME.
 * @param {{ url: string, status?: number, location?: string|null, contentType?: string, body?: string, error?: string }} response
 * @returns {Classification}
 */
export function classifyAnonymousResponse(response) {
  if (response.error) return fail('request_failed', `request failed: ${response.error}`);
  const { status } = response;
  if (status >= 300 && status < 400) {
    let target = null;
    try {
      target = response.location ? new URL(response.location, response.url) : null;
    } catch {
      target = null;
    }
    if (!target) return fail('unexpected_redirect', `HTTP ${status} without a usable Location`);
    if (target.hostname.endsWith(ACCESS_TEAM_SUFFIX) || target.pathname.startsWith('/cdn-cgi/access/')) {
      return pass('access_redirect', `HTTP ${status} to the Access login (${target.hostname}${target.pathname.split('/').slice(0, 4).join('/')})`);
    }
    return fail('unexpected_redirect', `HTTP ${status} to ${target.origin}, not the Access login`);
  }
  const kind = appResponseKind(response.body, response.contentType);
  if (status === 401 || status === 403) {
    if (kind) return fail('reached_app', `HTTP ${status} from the app itself: the request reached the app without passing Access`);
    return pass('access_denied', `HTTP ${status} from Cloudflare Access`);
  }
  if (status >= 200 && status < 300) {
    return fail('app_content', kind === 'content' ? `HTTP ${status} with app content, served without Access` : `HTTP ${status}, served without an Access check`);
  }
  return fail('unexpected_status', `HTTP ${status}${kind ? ' from the app' : ''}`);
}

/**
 * Classify the origin's answer to `GET https://<origin><path>` with SNI and
 * Host APP_HOSTNAME. `/healthz` must be the app's own "ok", which shows that
 * Traefik routes the hostname to the app; `/api/health` must be the app's own
 * 401, which shows that the app requires an Access JWT there. App data
 * without a JWT fails.
 * @param {string} path One of `ORIGIN_PATHS`.
 * @param {OriginProbeResult} result
 * @returns {Classification}
 */
export function classifyOriginProbe(path, result) {
  if (result.error) return fail('probe_failed', `no HTTPS answer (${result.error})`);
  const headers = result.headers ?? {};
  if (String(headers.server ?? '').toLowerCase() === 'cloudflare' || headers['cf-ray']) {
    return fail('cloudflare_edge', 'a Cloudflare edge answered, not the VPS: set ORIGIN_IP (or pass --origin-ip) to the server address');
  }
  const { status } = result;
  const body = String(result.body ?? '');
  if (status === 404 && TRAEFIK_404.test(body.trim())) {
    return fail('no_route', 'Traefik\'s "404 page not found": Traefik has no route for the hostname');
  }
  const kind = appResponseKind(body, headers['content-type']);
  if (path === HEALTHZ_PATH) {
    return status === 200 && body.trim() === 'ok'
      ? pass('healthz', 'HTTP 200 "ok" from the app')
      : fail('unexpected', `HTTP ${status}, not the app's 200 "ok"`);
  }
  if (kind === 'content' || (status >= 200 && status < 300)) {
    return fail('app_data', `HTTP ${status} with app data, served without an Access JWT`);
  }
  if (status === 401 && kind === 'error') return pass('jwt_required', 'HTTP 401 from the app\'s own Access JWT check');
  return fail('unexpected', `HTTP ${status}${kind ? ' from the app' : ''}, not the app's 401`);
}

/**
 * `GET https://<address>:<port><path>` with SNI and `Host` set to `hostname`,
 * as Cloudflare's proxy connects to the origin. The certificate is not
 * verified: the origin presents a Cloudflare Origin CA certificate, which
 * only Cloudflare trusts, and the probe checks routing and the app's guard,
 * not TLS.
 * @param {{ address: string, port: number, hostname: string, path: string, timeoutMs: number }} options
 * @returns {Promise<OriginProbeResult>} Never rejects.
 */
export function probeOriginHttps({ address, port, hostname, path, timeoutMs }) {
  return new Promise(resolve => {
    const req = httpsRequest({
      host: address,
      port,
      path,
      method: 'GET',
      servername: hostname,
      headers: { Host: hostname, Accept: '*/*' },
      rejectUnauthorized: false,
      agent: false,
      timeout: timeoutMs,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        if (body.length < MAX_BODY_CHARS) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', error => resolve({ error: error?.code ?? 'response_error' }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', error => resolve({ error: error?.code ?? 'request_error' }));
    req.end();
  });
}

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runVerify(ctx) {
  const results = { passed: 0, failed: 0 };
  const record = (name, classification) => {
    if (classification.verdict === 'pass') {
      results.passed += 1;
      ctx.report.ok(`${name}: ${classification.detail}`);
    } else {
      results.failed += 1;
      ctx.report.fail(`${name}: ${classification.detail}`);
    }
  };
  const token = {
    'CF-Access-Client-Id': ctx.config.serviceToken.clientId,
    'CF-Access-Client-Secret': ctx.config.serviceToken.clientSecret,
  };

  ctx.report.section('Anonymous access');
  for (const path of ['/', '/api/health']) {
    record(`anonymous GET ${path}`, classifyAnonymousResponse(await requestApp(ctx, path)));
  }

  ctx.report.section('Service token');
  record('GET /api/health with the service token', evaluateHealth(await requestApp(ctx, '/api/health', token)));
  record(`GET /api/channels/${CHANNEL_ID}/status with the service token`, evaluateChannelStatus(await requestApp(ctx, `/api/channels/${CHANNEL_ID}/status`, token)));

  const { hostname, originIp } = ctx.config;
  ctx.report.section('Origin');
  for (const path of ORIGIN_PATHS) {
    const probe = await ctx.probeOrigin({ address: originIp, port: HTTPS_PORT, hostname, path, timeoutMs: PROBE_TIMEOUT_MS });
    record(`GET https://${ORIGIN_MASK}${path} with SNI and Host ${hostname}`, classifyOriginProbe(path, probe));
  }

  ctx.report.section('DNS');
  try {
    const records = await findDnsRecords(ctx);
    record(`${hostname} is a proxied A record to ${ORIGIN_MASK}`, records.length === 1 && isOriginRecord(records[0], originIp)
      ? pass('dns', describeDnsRecords(records, originIp))
      : fail('dns', records.length === 0 ? 'no DNS record' : describeDnsRecords(records, originIp)));
  } catch (error) {
    record('DNS record', fail('dns_failed', errorMessage(error)));
  }

  ctx.report.section('Dokploy application');
  let app = null;
  try {
    const location = await locateDokployResources(ctx);
    if (!location.app) {
      record('Dokploy application', fail('missing', `application "${NAMES.app}" not found in project "${NAMES.project}"`));
    } else {
      app = await readApplication(ctx, location.app.applicationId, NAMES.app);
      const { matching, others } = partitionDomains(await readDomains(ctx, app.applicationId), hostname);
      record(`Traefik domain for ${hostname}`, evaluateDomain(matching, hostname));
      const warning = otherDomainsWarning(others);
      if (warning) ctx.report.warn(warning);
      const ports = publishedPortsOf(app);
      record('no published port', ports.length === 0 ? pass('closed', 'none') : fail('exposed', ports.join(', ')));
      const order = app.updateConfigSwarm?.Order;
      record('one replica, stop-first updates', Number(app.replicas) === 1 && order === SWARM_UPDATE_CONFIG.Order
        ? pass('swarm', `replicas 1, Order ${order}`)
        : fail('swarm', `replicas ${app.replicas ?? '?'}, Order ${order ?? 'default (start-first)'}`));
    }
  } catch (error) {
    record('Dokploy application', fail('dokploy_failed', errorMessage(error)));
  }

  if (ctx.config.redeployCheck) {
    ctx.report.section('Redeploy keeps the data');
    if (app) await checkRedeploy(ctx, app, token, record);
    else record('redeploy check', fail('skipped', 'the Dokploy application was not found'));
  }

  ctx.report.section('Result');
  ctx.report.line(`${results.passed} passed, ${results.failed} failed.`);
  return results;
}

async function checkRedeploy(ctx, app, token, record) {
  const channelPath = `/api/channels/${CHANNEL_ID}`;
  const before = await requestApp(ctx, channelPath, token);
  const createdAt = before.json?.createdAt;
  if (before.status !== 200 || typeof createdAt !== 'string') {
    record('channel before redeploy', fail('unreadable', describeResponse(before)));
    return;
  }
  // The lease holder id changes with every process start, so it tells the restarted instance apart.
  const previousHolder = (await requestApp(ctx, '/api/health', token)).json?.runtime?.leaseHolder?.id ?? null;
  try {
    await deployAndWait(ctx, app, { label: NAMES.app, procedure: 'application.redeploy', timeoutMs: ctx.config.waitMs });
  } catch (error) {
    record('redeploy', fail('redeploy_failed', errorMessage(error)));
    return;
  }

  // Swarm may still be replacing the task when Dokploy reports the deployment done.
  const started = ctx.now();
  for (;;) {
    const health = await requestApp(ctx, '/api/health', token);
    const runtime = health.json?.runtime;
    if (health.status === 200 && runtime?.leased === true && runtime.leaseHolder?.self === true
      && (previousHolder === null || runtime.leaseHolder.id !== previousHolder)) {
      record('app back after redeploy', pass('restarted', 'a new instance answers and holds the runtime lease'));
      break;
    }
    if (ctx.now() - started >= APP_RESTART_WAIT_MS) {
      record('app back after redeploy', fail('not_ready', `no new instance holding the lease after ${APP_RESTART_WAIT_MS / 60_000} min (${describeResponse(health)})`));
      return;
    }
    await ctx.sleep(POLL_INTERVAL_MS);
  }

  const after = await requestApp(ctx, channelPath, token);
  record(`${CHANNEL_ID} kept across the redeploy`, after.status === 200 && after.json?.createdAt === createdAt
    ? pass('persisted', `same createdAt ${createdAt}`)
    : fail('not_persisted', after.status === 200 ? `createdAt changed to ${after.json?.createdAt ?? '?'} (re-seeded)` : describeResponse(after)));

  const holders = new Set();
  let everyAnswerHoldsLease = true;
  for (let sample = 0; sample < INSTANCE_SAMPLES; sample += 1) {
    const view = (await requestApp(ctx, '/api/health', token)).json?.runtime;
    everyAnswerHoldsLease &&= view?.leased === true && view?.leaseHolder?.self === true;
    holders.add(view?.leaseHolder?.id ?? '?');
    if (sample < INSTANCE_SAMPLES - 1) await ctx.sleep(1_000);
  }
  const current = await readApplication(ctx, app.applicationId, NAMES.app);
  record('a single running instance', everyAnswerHoldsLease && holders.size === 1 && Number(current.replicas) === 1
    ? pass('single', `${INSTANCE_SAMPLES} health answers from the lease holder, replicas 1`)
    : fail('multiple', `answers from ${holders.size} lease holder(s)${everyAnswerHoldsLease ? '' : ', some from an instance without the lease'}, replicas ${current.replicas ?? '?'}`));
}

function evaluateDomain(matching, hostname) {
  if (matching.length === 0) return fail('missing', 'none');
  if (matching.length > 1) return fail('duplicate', `${matching.length} domains for the hostname`);
  const differing = domainDifferences(matching[0]);
  return differing.length === 0
    ? pass('domain', describeTraefikDomain(hostname))
    : fail('differs', `differs in ${differing.join(', ')} from ${describeTraefikDomain(hostname)}`);
}

function evaluateHealth(response) {
  if (response.status !== 200 || !response.json) return fail('health', describeResponse(response));
  const { channelCount, runtime } = response.json;
  if (typeof channelCount !== 'number') return fail('health', 'HTTP 200 without channelCount (not the app?)');
  if (runtime?.leased !== true) return fail('health', `HTTP 200, but the runtime lease is not held (channelCount ${channelCount})`);
  return pass('health', `HTTP 200, runtime leased${runtime.leaseHolder?.self === true ? ' by this instance' : ''}, channelCount ${channelCount}`);
}

// Paused or active are both operator choices; an active channel that needs a
// cutover mark but has none would post articles from before the cutover.
function evaluateChannelStatus(response) {
  if (response.status !== 200 || !response.json) return fail('status', describeResponse(response));
  const { paused, cutoverRequired, notBefore } = response.json;
  if (paused === true) {
    return pass('status', `paused${cutoverRequired === true ? ', cutoverRequired' : ''}${notBefore ? `, notBefore ${notBefore}` : ', no cutover mark yet'}`);
  }
  if (paused === false && (notBefore || cutoverRequired === false)) {
    return pass('status', `active${notBefore ? `, posting only articles published after notBefore ${notBefore}` : ''}`);
  }
  return fail('status', `paused=${paused}, cutoverRequired=${cutoverRequired}, notBefore ${notBefore ?? 'not set'}`);
}

async function requestApp(ctx, path, headers = {}) {
  const url = `https://${ctx.config.hostname}${path}`;
  try {
    const response = await ctx.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/html;q=0.9', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, MAX_BODY_CHARS);
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return {
      url,
      status: response.status,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type') ?? '',
      body,
      json: json && typeof json === 'object' ? json : null,
    };
  } catch (error) {
    return { url, error: ctx.redactor.redact(describeFetchError(error, REQUEST_TIMEOUT_MS)) };
  }
}

function describeResponse(response) {
  if (response.error) return `request failed: ${response.error}`;
  if (response.status >= 300 && response.status < 400) {
    let host = '?';
    try {
      host = new URL(response.location ?? '', response.url).hostname;
    } catch {
      host = '?';
    }
    return `HTTP ${response.status} redirect to ${host} (the service token was not accepted)`;
  }
  return `HTTP ${response.status}${typeof response.json?.error === 'string' ? ` (${response.json.error})` : ''}`;
}

function pass(kind, detail) {
  return { verdict: 'pass', kind, detail };
}

function fail(kind, detail) {
  return { verdict: 'fail', kind, detail };
}
