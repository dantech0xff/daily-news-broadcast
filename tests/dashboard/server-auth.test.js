import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';

import { createDashboardApp, projectRun } from '../../src/dashboard/create-dashboard-app.js';
import { createDashboardAuth, validateDashboardRuntime } from '../../src/dashboard/operator-auth.js';

const env = {
  DASHBOARD_TRIGGER_USERNAME: 'trigger-user',
  DASHBOARD_TRIGGER_PASSWORD: 'trigger-password',
  DASHBOARD_OPERATOR_USERNAME: 'operator-user',
  DASHBOARD_OPERATOR_PASSWORD: 'operator-password',
  DASHBOARD_EXTERNAL_ORIGIN: 'http://127.0.0.1:3000',
};

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function request(app, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
    });
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = path;
    req.headers = {
      host: '127.0.0.1:3000',
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...headers,
    };
    req.complete = true;
    if (payload) req.push(payload);
    req.push(null);

    const res = new http.ServerResponse(req);
    const chunks = [];
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const responseHeaders = Object.fromEntries(Object.entries(res.getHeaders()).map(([key, value]) => [key, String(value)]));
      resolve({ status: res.statusCode, headers: responseHeaders, body: raw ? JSON.parse(raw) : null });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });
}

function schedulerStub() {
  const calls = [];
  return {
    calls,
    setEventEmitter() {},
    listStreams: () => [{
      id: 'news', name: 'News', enabled: true, cron: '0 7 * * *', timezone: 'UTC', mode: 'digest',
      sources: [{ type: 'rss', preset: '$SOURCE_PRESET', config: { feedUrl: 'https://secret.example/feed', token: '$RSS_TOKEN' } }],
      ai: { provider: '$AI_PROVIDER', model: '$AI_MODEL', language: '$LANGUAGE', style: '$STYLE', apiKey: '$ANTHROPIC_API_KEY', audience: 'secret prompt' },
      outputs: [{ type: '$OUTPUT_TYPE', config: { botToken: '$TELEGRAM_BOT_TOKEN', chatId: '-100-secret' } }],
      is_running: false, is_scheduled: true, last_run: null,
    }],
    getStream(id) { return id === 'news' ? this.listStreams()[0] : null; },
    listRuns: () => ({ runs: [{ id: 'run-1', stream_id: 'news', status: 'success', content: 'secret generated content', stats: { articles: 1, prompt: 'secret prompt' } }], total: 1 }),
    getRun: () => ({ id: 'run-1', stream_id: 'news', status: 'success', content: 'secret generated content' }),
    async listUnresolvedTargets(id, options) {
      calls.push({ action: 'unresolved', id, options });
      return {
        channel: { channelId: id, state: 'active', expectedVersion: 4, allowedActions: ['pause'], secret: 'hidden' },
        targets: [{
          kind: 'output', deliveryId: 'delivery-id', outputKey: 'output-key', state: 'needs_reconciliation',
          expectedVersion: 7, allowedActions: ['confirm-delivered', 'retry-output'],
          content: 'private body', url: 'https://secret.example/output', providerDestination: 'hidden-provider',
        }],
        page: { limit: options.limit, offset: options.offset, total: 1 },
      };
    },
    async runStream(id, options) { calls.push({ action: 'run', id, options }); return { id: 'run-2', status: 'success' }; },
    async previewStream(id) { calls.push({ action: 'preview', id }); return { status: 'dry_run', content: 'bounded preview' }; },
    async forceStream(id, options) { calls.push({ action: 'force', id, options }); return { id: 'run-force', status: 'success' }; },
    async controlStream(id, controlAction, options) {
      calls.push({ action: 'control', id, controlAction, options });
      return { status: 'confirmed', deliveryId: 'opaque-delivery', version: 8, generatedContent: 'secret digest' };
    },
  };
}

test('dashboard credentials are mandatory and role pairs must be distinct', () => {
  assert.throws(() => createDashboardAuth({}), /credentials/i);
  assert.throws(() => createDashboardAuth({
    ...env,
    DASHBOARD_OPERATOR_USERNAME: env.DASHBOARD_TRIGGER_USERNAME,
    DASHBOARD_OPERATOR_PASSWORD: env.DASHBOARD_TRIGGER_PASSWORD,
  }), /distinct/i);
});

test('non-loopback runtime requires HTTPS plus app TLS or an allowlisted proxy', () => {
  assert.throws(() => validateDashboardRuntime({ DASHBOARD_HOST: '0.0.0.0' }), /HTTPS external origin/i);
  assert.throws(() => validateDashboardRuntime({
    DASHBOARD_HOST: '0.0.0.0', DASHBOARD_EXTERNAL_ORIGIN: 'https://news.example',
  }), /TLS|proxy/i);
  const runtime = validateDashboardRuntime({
    DASHBOARD_HOST: '0.0.0.0', DASHBOARD_EXTERNAL_ORIGIN: 'https://news.example',
    DASHBOARD_TRUSTED_PROXIES: '10.0.0.0/8',
  });
  assert.deepEqual(runtime.trustedProxies, ['10.0.0.0/8']);
});

test('protected APIs enforce Basic roles, origin, no-store, and redacted views', async () => {
  const scheduler = schedulerStub();
  const app = createDashboardApp({ scheduler, auth: createDashboardAuth(env), runtime: validateDashboardRuntime(env) });

  const unauthorized = await request(app, '/api/streams');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers['cache-control'], 'no-store');

  const triggerHeaders = { authorization: basic('trigger-user', 'trigger-password') };
  const streams = await request(app, '/api/streams', { headers: triggerHeaders });
  assert.equal(streams.status, 200);
  assert.equal(JSON.stringify(streams.body).includes('secret'), false);
  assert.equal(JSON.stringify(streams.body).includes('$'), false);

  const runs = await request(app, '/api/streams/news/runs', { headers: triggerHeaders });
  assert.equal(JSON.stringify(runs.body).includes('secret generated content'), false);
  assert.equal(JSON.stringify(runs.body).includes('secret prompt'), false);

  const missingOrigin = await request(app, '/api/streams/news/run', { method: 'POST', headers: triggerHeaders });
  assert.equal(missingOrigin.status, 403);
  assert.equal(scheduler.calls.length, 0);

  const originHeaders = { ...triggerHeaders, origin: env.DASHBOARD_EXTERNAL_ORIGIN, 'content-type': 'application/json' };
  const manual = await request(app, '/api/streams/news/run', { method: 'POST', headers: originHeaders, body: {} });
  assert.equal(manual.status, 200);
  assert.equal(scheduler.calls[0].options.triggerType, 'manual');

  const forceOnManualRoute = await request(app, '/api/streams/news/run', {
    method: 'POST', headers: originHeaders, body: { force: true },
  });
  assert.equal(forceOnManualRoute.status, 400);
  assert.equal(scheduler.calls.filter(call => call.action === 'run').length, 1);

  const deniedForce = await request(app, '/api/streams/news/force', {
    method: 'POST', headers: originHeaders, body: { idempotencyKey: 'k', confirmDuplicateRisk: true },
  });
  assert.equal(deniedForce.status, 403);
  assert.equal(scheduler.calls.filter(call => call.action === 'force').length, 0);

  const operatorHeaders = {
    authorization: basic('operator-user', 'operator-password'),
    origin: env.DASHBOARD_EXTERNAL_ORIGIN,
    'content-type': 'application/json',
  };
  const forceWithoutReason = await request(app, '/api/streams/news/force', {
    method: 'POST', headers: operatorHeaders, body: { idempotencyKey: 'k', confirmDuplicateRisk: true },
  });
  assert.equal(forceWithoutReason.status, 400);
  assert.equal(scheduler.calls.filter(call => call.action === 'force').length, 0);

  const force = await request(app, '/api/streams/news/force', {
    method: 'POST', headers: operatorHeaders,
    body: { idempotencyKey: 'k', reason: 'operator approved resend', confirmDuplicateRisk: true },
  });
  assert.equal(force.status, 200);
  assert.equal(scheduler.calls.at(-1).action, 'force');
  assert.equal(scheduler.calls.at(-1).options.operatorId, 'operator-user');
  assert.equal(scheduler.calls.at(-1).options.reason, 'operator approved resend');
  assert.equal(force.headers['cache-control'], 'no-store');

  const deniedControl = await request(app, '/api/streams/news/control/confirm-delivered', {
    method: 'POST', headers: originHeaders,
    body: { idempotencyKey: 'confirm', expectedVersion: 7, reason: 'verified', deliveryId: 'd', outputKey: 'o' },
  });
  assert.equal(deniedControl.status, 403);

  const control = await request(app, '/api/streams/news/control/confirm-delivered', {
    method: 'POST', headers: operatorHeaders,
    body: { idempotencyKey: 'confirm', expectedVersion: 7, reason: 'verified', deliveryId: 'd', outputKey: 'o' },
  });
  assert.equal(control.status, 200);
  assert.equal(scheduler.calls.at(-1).controlAction, 'confirm-delivered');
  assert.equal(scheduler.calls.at(-1).options.operatorId, 'operator-user');
  assert.equal(JSON.stringify(control.body).includes('secret digest'), false);

  const deniedTargets = await request(app, '/api/streams/news/unresolved?limit=1', { headers: triggerHeaders });
  assert.equal(deniedTargets.status, 403);
  const targets = await request(app, '/api/streams/news/unresolved?limit=1', { headers: operatorHeaders });
  assert.equal(targets.status, 200);
  assert.equal(targets.body.targets[0].deliveryId, 'delivery-id');
  assert.equal(targets.body.targets[0].outputKey, 'output-key');
  assert.equal(targets.body.targets[0].expectedVersion, 7);
  assert.deepEqual(targets.body.targets[0].allowedActions, ['confirm-delivered', 'retry-output']);
  const targetProjection = JSON.stringify(targets.body);
  for (const privateValue of ['private body', 'secret.example', 'hidden-provider', '"secret"']) {
    assert.equal(targetProjection.includes(privateValue), false);
  }
});

test('an untrusted peer cannot spoof X-Forwarded-Proto in proxy mode', async () => {
  const proxyEnv = {
    ...env,
    DASHBOARD_HOST: '0.0.0.0',
    DASHBOARD_EXTERNAL_ORIGIN: 'https://news.example',
    DASHBOARD_TRUSTED_PROXIES: '10.0.0.0/8',
  };
  const app = createDashboardApp({
    scheduler: schedulerStub(),
    auth: createDashboardAuth(proxyEnv),
    runtime: validateDashboardRuntime(proxyEnv),
  });
  const response = await request(app, '/api/health', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 400);
});

test('dashboard error logs and API projections redact provider secrets without erasing generic context', async () => {
  const logs = [];
  const scheduler = schedulerStub();
  scheduler.runStream = async () => {
    throw new Error('ordinary outage provider body={"api_key":"raw-api-key"} https://secret.example/hook Bearer raw-bearer');
  };
  const app = createDashboardApp({
    scheduler,
    auth: createDashboardAuth(env),
    runtime: validateDashboardRuntime(env),
    logger: { error: value => logs.push(String(value)) },
  });
  const response = await request(app, '/api/streams/news/run', {
    method: 'POST',
    headers: {
      authorization: basic('trigger-user', 'trigger-password'),
      origin: env.DASHBOARD_EXTERNAL_ORIGIN,
      'content-type': 'application/json',
    },
    body: {},
  });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Request failed' });
  assert.match(logs.join('\n'), /ordinary outage/i);

  const projected = JSON.stringify(projectRun({
    id: 'run', stream_id: 'news', status: 'error', trigger_type: 'manual',
    error: 'generic failure body={"secret":"raw-provider-secret"}',
    output_results: [{ id: 'out', name: 'Out', success: false, error: 'Bearer output-token' }],
  }));
  for (const secret of ['raw-api-key', 'secret.example', 'raw-bearer', 'raw-provider-secret', 'output-token']) {
    assert.equal((logs.join('\n') + projected).includes(secret), false);
  }
  assert.match(projected, /generic failure/i);
});
