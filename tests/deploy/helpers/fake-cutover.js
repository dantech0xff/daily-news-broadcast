/**
 * In-memory fake of the production Worker API and the dashboard app API for
 * the cutover script tests. Requests are checked the way the real services
 * check them (trigger/operator secrets, the Access service token, Origin and
 * JSON for app mutations, exact versions, idempotency-key replay) and every
 * request is recorded. Nothing here touches the network.
 */

import { main } from '../../../scripts/deploy/cutover.mjs';
import { captureStream } from './fake-platform.js';

export const CUTOVER = Object.freeze({
  workerUrl: 'https://news-engine.dan-tran.workers.dev',
  triggerSecret: 'trigger-secret-SECRET-1001',
  operatorSecret: 'operator-secret-SECRET-1002',
  hostname: 'radar.example.test',
  clientId: '7f3c9a1b2d4e.access',
  clientSecret: 'cf-access-client-secret-SECRET-1003',
  now: '2026-10-03T12:00:00.000Z',
});

/** Every secret value the script must never print. */
export const CUTOVER_SECRETS = Object.freeze([CUTOVER.triggerSecret, CUTOVER.operatorSecret, CUTOVER.clientSecret]);

const WORKER_ORIGIN = new URL(CUTOVER.workerUrl).origin;
const APP_ORIGIN = `https://${CUTOVER.hostname}`;
const CHANNEL = 'telegram-main';

/**
 * @param {Record<string, string|undefined>} [overrides]
 * @returns {Record<string, string|undefined>}
 */
export function cutoverEnv(overrides = {}) {
  return {
    TRIGGER_SECRET: CUTOVER.triggerSecret,
    OPERATOR_SECRET: CUTOVER.operatorSecret,
    APP_HOSTNAME: CUTOVER.hostname,
    CF_ACCESS_CLIENT_ID: CUTOVER.clientId,
    CF_ACCESS_CLIENT_SECRET: CUTOVER.clientSecret,
    ...overrides,
  };
}

let itemSequence = 0;

/**
 * A library item as `GET /api/content` lists it.
 * @param {Record<string, unknown>} [overrides]
 */
export function contentItem(overrides = {}) {
  itemSequence += 1;
  return {
    id: `content-${itemSequence}`,
    channelId: CHANNEL,
    articleKey: `article-${itemSequence}`,
    title: `Article ${itemSequence}`,
    url: `https://news.example.test/${itemSequence}`,
    sourceId: 'hackernews',
    sourceName: 'Hacker News',
    category: null,
    publishedAt: null,
    firstSeenAt: CUTOVER.now,
    lastSeenAt: CUTOVER.now,
    status: 'selected',
    rejectReason: null,
    deliveryId: null,
    messageId: null,
    deliveredAt: null,
    runId: null,
    updatedAt: CUTOVER.now,
    summaryPreview: null,
    ...overrides,
  };
}

/** A drip-mode preview: no `content`, one generated hook per item. */
export function dripPreview(hooks = ['Bài viết thử nghiệm về Node.js 24 và node:sqlite. '.repeat(12)]) {
  return {
    channelId: CHANNEL,
    status: 'dry_run',
    reason: null,
    mode: 'drip',
    publishingDay: '2026-10-03',
    content: null,
    items: hooks.map((hook, index) => ({ title: `Preview article ${index + 1}`, hook })),
    stats: { articles: hooks.length, sources: 25, durationMs: 4200, selection: { fetched: 120, fresh: 80, uncovered: 75, relevant: 30, ranked: 18, enqueued: hooks.length } },
    sourceHealth: { total: 25, healthy: 23, failed: 1, unknown: 1, degraded: false },
    sources: [],
    aiUsage: { attempted: hooks.length, succeeded: hooks.length, failed: 0, inputTokens: 1200, outputTokens: 300 },
  };
}

/**
 * @param {{ worker?: Record<string, unknown>, app?: Record<string, unknown> }} [options]
 *   Overrides of the initial Worker and app state (see the defaults below).
 */
export function createFakeCutover({ worker = {}, app = {} } = {}) {
  const state = {
    worker: {
      runtimeMode: 'bootstrap',
      paused: false,
      version: 543,
      mutationState: 'blocked_ambiguous',
      updatedAt: '2026-10-02T09:00:00.000Z',
      ambiguousOutputs: 1,
      /** @type {Map<string, { fingerprint: string, result: object }>} */
      actions: new Map(),
      controlAttempts: 0,
      /** Runs before a control applies: `(worker, { action, body, attempt }) => { status, body }|void` (a return value answers instead). */
      beforeControl: null,
      /** Controls answer 200 without changing `paused` (a misbehaving Worker). */
      ignoreControls: false,
      /** When set, every request answers with this status and body. */
      failWith: null,
      ...worker,
    },
    app: {
      record: { id: CHANNEL, enabled: true, notBefore: null, cutoverRequired: true, version: 2, createdAt: '2026-10-03T08:00:00.000Z' },
      delivery: { paused: true, version: 7, mutationState: 'free' },
      /** @type {Map<string, { fingerprint: string, result: object }>} */
      actions: new Map(),
      /** @type {object[]} */
      content: [],
      /** @type {object[]} newest first */
      runs: [],
      lastRun: null,
      preview: dripPreview(),
      /** Runs while a preview is served: `(app) => { status, body }|void` (a return value answers instead). */
      onPreview: null,
      /** Runs before a control applies: `(app, { action, body }) => { status, body }|void` (a return value answers instead). */
      beforeControl: null,
      /** Controls answer 200 without changing `paused` (a misbehaving app). */
      ignoreControls: false,
      ...app,
    },
  };
  /** @type {{ service: string, method: string, url: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: any, redirect: string|undefined }[]} */
  const calls = [];

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    let body;
    if (init.body !== undefined) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const service = url.origin === WORKER_ORIGIN ? 'worker' : url.origin === APP_ORIGIN ? 'app' : 'other';
    const call = { service, method, url: url.href, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body, redirect: init.redirect };
    calls.push(call);
    if (service === 'worker') return workerResponse(call);
    if (service === 'app') return appResponse(call);
    throw new Error(`Unexpected request to ${url.origin}`);
  }

  function workerResponse({ method, path, query, headers, body }) {
    const w = state.worker;
    if (w.failWith) return json(w.failWith.status, w.failWith.body);
    if (path === '/status') {
      if (headers.authorization !== `Bearer ${CUTOVER.triggerSecret}`) return json(401, { error: 'unauthorized' });
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
      if (query.channel !== CHANNEL) return json(404, { error: 'channel_not_found' });
      return json(200, {
        runtimeMode: w.runtimeMode,
        channel: { channelId: CHANNEL, paused: w.paused, mutationState: w.mutationState, version: w.version, updatedAt: w.updatedAt },
        lastRequest: null,
        sourceWarning: null,
        queue: { publishingDay: '2026-10-03', total: 0, remaining: 0, blocked: 0 },
        counts: { requests: 12, activeDeliveries: 0, ambiguousOutputs: w.ambiguousOutputs, maintenanceDeadLetters: 0, unresolvedTargets: 34 },
        requests: [],
        nextCursor: null,
        unresolvedTargets: [],
        nextTargetCursor: null,
      });
    }
    const control = /^\/control\/(pause|resume)$/.exec(path);
    if (!control) return json(404, { error: 'not_found' });
    if (headers.authorization !== `Bearer ${CUTOVER.operatorSecret}`) return json(401, { error: 'unauthorized' });
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const action = control[1];
    if (w.runtimeMode === 'bootstrap' && action !== 'pause') return json(409, { error: 'runtime_not_active', runtimeMode: 'bootstrap' });
    if (!String(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(415, { error: 'application_json_required' });
    if (!body || typeof body !== 'object' || body.channelId !== CHANNEL) return json(400, { error: 'channelId_required' });
    const key = headers['idempotency-key'];
    if (!key) return json(400, { error: 'idempotency_key_required' });
    if (body.idempotencyKey && body.idempotencyKey !== key) return json(409, { error: 'idempotency_key_conflict' });
    w.controlAttempts += 1;
    const early = w.beforeControl?.(w, { action, body, attempt: w.controlAttempts });
    if (early) return json(early.status, early.body);
    const fingerprint = JSON.stringify([action, body.expectedVersion, body.reason]);
    const existing = w.actions.get(key);
    if (existing) {
      // The Worker maps a payload mismatch and a version conflict to the same code.
      if (existing.fingerprint !== fingerprint) return json(409, { error: 'request_conflict' });
      return json(200, { ...existing.result, replayed: true });
    }
    if (body.expectedVersion !== w.version) return json(409, { error: 'request_conflict' });
    if (!w.ignoreControls) w.paused = action === 'pause';
    w.version += 1;
    w.updatedAt = '2026-10-03T12:00:00.000Z';
    const result = {
      status: action === 'pause' ? 'paused' : 'resumed',
      version: w.version,
      channel: { channelId: CHANNEL, paused: w.paused, mutationState: w.mutationState, version: w.version, updatedAt: w.updatedAt },
      replayed: false,
    };
    w.actions.set(key, { fingerprint, result });
    return json(200, result);
  }

  function appResponse({ method, path, query, headers, body }) {
    const a = state.app;
    if (headers['cf-access-client-id'] !== CUTOVER.clientId || headers['cf-access-client-secret'] !== CUTOVER.clientSecret) {
      return new Response(null, { status: 302, headers: { location: `https://radar-team.cloudflareaccess.com/cdn-cgi/access/login/${CUTOVER.hostname}` } });
    }
    if (method !== 'GET') {
      if (headers.origin !== APP_ORIGIN) return json(403, { error: 'same_origin_required', message: 'Yêu cầu thay đổi phải được gửi từ chính dashboard.' });
      if (headers['content-type'] !== 'application/json') return json(415, { error: 'unsupported_media_type' });
    }
    const route = `${method} ${path}`;
    if (route === 'GET /api/health') {
      return json(200, {
        status: 'ok',
        version: 'test',
        time: CUTOVER.now,
        runtime: { active: true, leased: true, leaseHolder: { id: 'abcd1234', self: true, expiresAt: CUTOVER.now }, running: false, queued: 0, scheduledChannels: 1 },
        channelCount: 1,
      });
    }
    if (route === `GET /api/channels/${CHANNEL}`) return json(200, recordView());
    if (route === `PUT /api/channels/${CHANNEL}`) {
      if (body?.version !== a.record.version) {
        return json(409, { error: 'version_conflict', message: 'Dữ liệu đã được thay đổi ở nơi khác.', details: { currentVersion: a.record.version } });
      }
      if (body.notBefore !== undefined) {
        if (body.notBefore !== null && !Number.isFinite(Date.parse(body.notBefore))) {
          return json(400, { error: 'validation_failed', issues: [{ field: 'notBefore', code: 'invalid_format' }] });
        }
        a.record.notBefore = body.notBefore === null ? null : new Date(body.notBefore).toISOString();
      }
      a.record.version += 1;
      return json(200, recordView());
    }
    if (route === `GET /api/channels/${CHANNEL}/status`) return json(200, statusView());
    if (route === `POST /api/channels/${CHANNEL}/preview`) {
      if (Object.keys(body ?? {}).length > 0) return json(400, { error: 'validation_failed' });
      const early = a.onPreview?.(a);
      if (early) return json(early.status, early.body);
      return json(200, a.preview);
    }
    if (route === `POST /api/channels/${CHANNEL}/run`) {
      if (a.record.cutoverRequired && !a.record.notBefore) return json(409, { error: 'cutover_required' });
      const runId = `run-${a.runs.length + 1}`;
      a.runs.unshift({ id: runId, channelId: CHANNEL, triggerType: 'manual', status: 'running', startedAt: CUTOVER.now, finishedAt: null });
      return json(202, { status: 'queued', channelId: CHANNEL, runId, position: 0 });
    }
    if (route === 'GET /api/content') return listContent(query);
    if (route === `GET /api/channels/${CHANNEL}/runs`) {
      const { limit, offset } = page(query, 20);
      return json(200, { runs: a.runs.slice(offset, offset + limit), page: { limit, offset, total: a.runs.length } });
    }
    const control = new RegExp(`^/api/channels/${CHANNEL}/control/(pause|resume)$`).exec(path);
    if (method === 'POST' && control) return appControl(control[1], body);
    return json(404, { error: 'not_found' });
  }

  function appControl(action, body) {
    const a = state.app;
    const { idempotencyKey, expectedVersion, reason } = body ?? {};
    if (typeof idempotencyKey !== 'string' || !Number.isSafeInteger(expectedVersion) || typeof reason !== 'string') {
      return json(400, { error: 'validation_failed' });
    }
    if (action === 'resume' && a.record.cutoverRequired && !a.record.notBefore) return json(409, { error: 'cutover_required' });
    const early = a.beforeControl?.(a, { action, body });
    if (early) return json(early.status, early.body);
    const fingerprint = JSON.stringify([action, expectedVersion, reason]);
    const existing = a.actions.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return json(409, { error: 'control_rejected', details: { reason: 'Idempotency key conflicts with a different operator action' } });
      return json(200, { ...existing.result, replayed: true });
    }
    if (expectedVersion !== a.delivery.version) return json(409, { error: 'version_conflict' });
    if (!a.ignoreControls) a.delivery.paused = action === 'pause';
    a.delivery.version += 1;
    const result = { channelId: CHANNEL, action, status: action === 'pause' ? 'paused' : 'resumed', replayed: false, paused: a.delivery.paused, version: a.delivery.version };
    a.actions.set(idempotencyKey, { fingerprint, result });
    return json(200, result);
  }

  function listContent(query) {
    const { limit, offset, invalid } = page(query, 50);
    if (invalid) return json(400, { error: 'validation_failed' });
    const statuses = query.status ? query.status.split(',') : null;
    const column = { seen: 'lastSeenAt', published: 'publishedAt', delivered: 'deliveredAt' }[query.dateField ?? 'seen'];
    if (!column) return json(400, { error: 'validation_failed' });
    let items = state.app.content.filter(item => (!query.channelId || item.channelId === query.channelId)
      && (!statuses || statuses.includes(item.status)));
    if (query.from) {
      const from = new Date(query.from).toISOString();
      items = items.filter(item => typeof item[column] === 'string' && item[column] >= from);
    }
    return json(200, { items: items.slice(offset, offset + limit), page: { limit, offset, total: items.length } });
  }

  function recordView() {
    const r = state.app.record;
    return {
      id: r.id, name: 'Telegram chính', enabled: r.enabled, platform: 'telegram', mode: 'drip', cron: '0 0-17 * * *', timezone: 'UTC',
      notBefore: r.notBefore, sources: [], prompt: {}, ai: {}, telegram: {}, limits: { dailyLimit: 18 },
      cutoverRequired: r.cutoverRequired, version: r.version, createdAt: r.createdAt, updatedAt: CUTOVER.now, updatedBy: 'system',
    };
  }

  function statusView() {
    const { record: r, delivery: d } = state.app;
    return {
      channelId: CHANNEL, name: 'Telegram chính', enabled: r.enabled, mode: 'drip', cron: '0 0-17 * * *', timezone: 'UTC',
      notBefore: r.notBefore, cutoverRequired: r.cutoverRequired, dailyLimit: 18, configVersion: r.version,
      paused: d.paused, version: d.version, mutationState: d.mutationState, allowedActions: [],
      scheduled: true, running: false, queued: false,
      queue: { date: '2026-10-03', total: 0, remaining: 0, blocked: 0, delivered: 0 },
      lastRun: state.app.lastRun, unresolvedCount: 0,
    };
  }

  return { state, calls, fetch };
}

/**
 * Run the cutover CLI against a fake with a fake clock and instant sleeps.
 * @param {string[]} argv
 * @param {{ fake: ReturnType<typeof createFakeCutover>, env?: Record<string, string|undefined>, now?: string }} options
 */
export async function runCutover(argv, { fake, env = cutoverEnv(), now = CUTOVER.now }) {
  const stdout = captureStream();
  const stderr = captureStream();
  let clock = Date.parse(now);
  const sleeps = [];
  const firstCall = fake.calls.length;
  const code = await main(argv, {
    env,
    fetch: fake.fetch,
    stdout,
    stderr,
    now: () => clock,
    sleep: async ms => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return {
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    output: `${stdout.text}\n${stderr.text}`,
    calls: fake.calls.slice(firstCall),
    sleeps,
  };
}

function page(query, defaultLimit) {
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  const invalid = !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0;
  return { limit, offset, invalid };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
