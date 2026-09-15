import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectSelectionStats } from '../core/delivery.js';
import { sanitizeRuntimeError } from '../channels/runner.js';
import {
  noStore,
  requireDashboardRole,
  requireSameOrigin,
  requireSecureTransport,
} from './operator-auth.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** Compose the dashboard application without opening a listening socket. */
export function createDashboardApp({
  scheduler,
  auth,
  runtime,
  publicDir = join(moduleDirectory, 'public'),
  version = 'unknown',
  logger = console,
}) {
  if (!scheduler || !auth || !runtime) throw new Error('Dashboard app requires scheduler, auth, and runtime dependencies');
  const app = express();
  if (runtime.trustedProxies.length > 0) app.set('trust proxy', runtime.trustedProxies);
  else app.set('trust proxy', false);
  app.disable('x-powered-by');
  app.use('/api', noStore);
  app.use(requireSecureTransport(runtime));

  const trigger = requireDashboardRole(auth, 'trigger');
  const operator = requireDashboardRole(auth, 'operator');
  const sameOrigin = requireSameOrigin(runtime.externalOrigin);
  const json = express.json({ limit: '8kb', strict: true, type: 'application/json' });
  const mutation = [sameOrigin, requireJson, json];

  const sseClients = new Set();
  scheduler.setEventEmitter(event => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(data);
  });

  app.get('/api/health', (_req, res) => {
    res.json({ service: 'content-radar-dashboard', status: 'ok', time: new Date().toISOString(), version, channelCount: scheduler.listStreams().length });
  });

  app.get('/api/events', trigger, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.get('/api/streams', trigger, (_req, res) => {
    res.json(scheduler.listStreams().map(projectStream));
  });

  app.get('/api/streams/:id', trigger, (req, res) => {
    const stream = scheduler.getStream(req.params.id);
    if (!stream) return res.status(404).json({ error: 'Not found' });
    res.json(projectStream(stream));
  });

  app.post('/api/streams/:id/run', trigger, ...mutation, asyncRoute(async (req, res) => {
    if (req.body?.force === true) return res.status(400).json({ error: 'Use the operator force endpoint' });
    const result = await scheduler.runStream(req.params.id, { triggerType: 'manual' });
    res.json(projectRun(result));
  }));

  app.post('/api/streams/:id/preview', trigger, ...mutation, asyncRoute(async (req, res) => {
    const result = await scheduler.previewStream(req.params.id);
    res.json(projectPreview(result));
  }));

  app.post('/api/streams/:id/force', operator, ...mutation, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const result = await scheduler.forceStream(req.params.id, {
      idempotencyKey: idempotencyKey(body.idempotencyKey),
      operatorId: auth.operator.username,
      reason: operatorReason(body.reason),
      confirmDuplicateRisk: body.confirmDuplicateRisk === true,
    });
    res.json(projectRun(result));
  }));

  app.post('/api/streams/:id/control/:action', operator, ...mutation, asyncRoute(async (req, res) => {
    if (!scheduler.getStream(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const body = req.body ?? {};
    const result = await scheduler.controlStream(req.params.id, req.params.action, {
      idempotencyKey: idempotencyKey(body.idempotencyKey),
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      operatorId: auth.operator.username,
      deliveryId: body.deliveryId,
      outputKey: body.outputKey,
      outboxId: body.outboxId,
      messageId: body.messageId,
      confirmDuplicateRisk: body.confirmDuplicateRisk === true,
      confirmPausedMutation: body.confirmPausedMutation === true,
    });
    res.json(projectControl(result));
  }));

  app.get('/api/streams/:id/unresolved', operator, asyncRoute(async (req, res) => {
    if (!scheduler.getStream(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const result = await scheduler.listUnresolvedTargets(req.params.id, {
      limit: parseBoundedInteger(req.query.limit, 50, 1, 100),
      offset: parseBoundedInteger(req.query.offset, 0, 0, 100_000),
    });
    res.json(projectUnresolvedTargets(result));
  }));

  app.get('/api/streams/:id/runs', trigger, (req, res) => {
    const limit = parseBoundedInteger(req.query.limit, 20, 1, 100);
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100_000);
    const result = scheduler.listRuns(req.params.id, limit, offset);
    res.json({ runs: result.runs.map(projectRun), total: result.total });
  });

  app.get('/api/runs/:id', trigger, (req, res) => {
    const run = scheduler.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    res.json(projectRun(run));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method === 'GET') res.sendFile(join(publicDir, 'index.html'));
    else next();
  });

  app.use((error, req, res, _next) => {
    const sanitized = safeErrorText(error, 500);
    logger.error?.(`[Dashboard] ${sanitized}`);
    if (res.headersSent) return;
    const status = error.type === 'entity.too.large' ? 413
      : error instanceof SyntaxError ? 400
        : /idempotency|duplicate-risk|duplicateRisk|conflicts|required|must|unsupported recovery|cannot|only|paused|version|topology|busy|not found/i.test(sanitized) ? 400
          : 500;
    res.status(status).json({ error: status === 500 ? 'Request failed' : sanitized });
  });

  return app;
}

export function projectStream(stream) {
  const name = publicMetadata(stream.name, 200) || stream.id;
  const sources = Array.isArray(stream.sources)
    ? stream.sources.map(source => projectSource(source)).filter(Boolean)
    : [];
  const outputs = Array.isArray(stream.outputs)
    ? stream.outputs.map(output => publicMetadata(output?.type, 100)).filter(Boolean).map(type => ({ type }))
    : [];
  const provider = publicMetadata(stream.ai?.provider, 100);
  return {
    id: stream.id,
    name,
    enabled: stream.enabled === true,
    cron: publicMetadata(stream.cron, 100),
    timezone: publicMetadata(stream.timezone, 100),
    mode: publicMetadata(stream.mode, 20) || 'digest',
    sources,
    ai: provider ? {
      provider,
      ...optionalMetadata('model', stream.ai?.model, 200),
      ...optionalMetadata('language', stream.ai?.language, 50),
      ...optionalMetadata('style', stream.ai?.style, 50),
      ...optionalMetadata('platform', stream.ai?.platform, 50),
    } : null,
    outputs,
    is_running: stream.is_running === true,
    is_scheduled: stream.is_scheduled === true,
    last_run: stream.last_run ? projectRun(stream.last_run) : null,
  };
}

function projectSource(source) {
  const type = publicMetadata(source?.type, 100);
  if (!type) return null;
  return { type, ...optionalMetadata('preset', source?.preset, 100) };
}

function optionalMetadata(key, value, maximum) {
  const projected = publicMetadata(value, maximum);
  return projected ? { [key]: projected } : {};
}

function publicMetadata(value, maximum) {
  if (typeof value !== 'string' || !value || /\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) return null;
  return safeText(value, maximum);
}

export function projectRun(run) {
  if (!run) return run;
  return {
    id: run.id,
    stream_id: run.stream_id,
    status: run.status,
    ...(run.reason ? { reason: safeErrorText(run.reason, 200) } : {}),
    trigger_type: run.trigger_type,
    stats: projectStats(run.stats),
    ai_usage: projectUsage(run.ai_usage),
    output_results: Array.isArray(run.output_results) ? run.output_results.map(output => ({
      id: output.id,
      name: output.name,
      success: output.success === true,
      ...(output.error ? { error: safeErrorText(output.error, 300) } : {}),
    })) : [],
    output_summary: projectOutputSummary(run.output_summary),
    ...(run.error ? { error: safeErrorText(run.error, 500) } : {}),
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

function projectControl(result) {
  return {
    status: safeText(result?.status ?? 'failed', 80),
    ...(result?.channelId ? { channelId: safeText(result.channelId, 128) } : {}),
    ...(typeof result?.paused === 'boolean' ? { paused: result.paused } : {}),
    ...(result?.deliveryId ? { deliveryId: safeText(result.deliveryId, 500) } : {}),
    ...(result?.deliveryState ? { deliveryState: safeText(result.deliveryState, 80) } : {}),
    ...(result?.outboxId ? { outboxId: safeText(result.outboxId, 500) } : {}),
    ...(result?.outboxState ? { outboxState: safeText(result.outboxState, 80) } : {}),
    ...(Number.isSafeInteger(result?.version) ? { version: result.version } : {}),
    replayed: result?.replayed === true,
  };
}

function projectUnresolvedTargets(result) {
  const projectTarget = target => ({
    kind: safeText(target?.kind ?? 'unknown', 20),
    ...(target?.deliveryId ? { deliveryId: safeText(target.deliveryId, 500) } : {}),
    ...(target?.outputKey ? { outputKey: safeText(target.outputKey, 500) } : {}),
    ...(target?.outboxId ? { outboxId: safeText(target.outboxId, 500) } : {}),
    state: safeText(target?.state ?? 'unknown', 80),
    expectedVersion: Number.isSafeInteger(target?.expectedVersion) ? target.expectedVersion : 0,
    allowedActions: Array.isArray(target?.allowedActions)
      ? target.allowedActions.slice(0, 4).map(action => safeText(action, 40))
      : [],
  });
  return {
    channel: result?.channel ? {
      channelId: safeText(result.channel.channelId, 128),
      state: safeText(result.channel.state, 20),
      expectedVersion: Number.isSafeInteger(result.channel.expectedVersion) ? result.channel.expectedVersion : 0,
      allowedActions: Array.isArray(result.channel.allowedActions)
        ? result.channel.allowedActions.slice(0, 2).map(action => safeText(action, 40))
        : [],
    } : null,
    targets: Array.isArray(result?.targets) ? result.targets.slice(0, 100).map(projectTarget) : [],
    page: {
      limit: Number.isSafeInteger(result?.page?.limit) ? result.page.limit : 50,
      offset: Number.isSafeInteger(result?.page?.offset) ? result.page.offset : 0,
      total: Number.isSafeInteger(result?.page?.total) ? result.page.total : 0,
    },
  };
}

function projectPreview(result) {
  return {
    status: result.status,
    ...(result.reason ? { reason: safeErrorText(result.reason, 200) } : {}),
    ...(result.error ? { error: safeErrorText(result.error, 500) } : {}),
    ...(result.content ? { content: String(result.content).slice(0, 64 * 1024) } : {}),
    ...(Array.isArray(result.articles) ? { articles: result.articles.slice(0, 50).map(item => ({
      article: String(item.article ?? '').slice(0, 500),
      hook: String(item.hook ?? '').slice(0, 4_000),
      dryRun: true,
    })) } : {}),
    stats: projectStats(result.stats),
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Content-Type application/json is required' });
  next();
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) return fallback;
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error('idempotencyKey must contain 1-200 visible ASCII characters');
  }
  return value;
}

function operatorReason(value) {
  const reason = String(value ?? '').trim();
  if (!reason) throw new Error('reason is required');
  if (reason.length > 500) throw new Error('reason exceeds 500 characters');
  return reason;
}

function safeText(value, maximum) {
  return String(value)
    .replace(/unresolved environment reference:\s*[A-Za-z_][A-Za-z0-9_]*/gi, 'unresolved environment reference')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '[redacted-env]')
    .slice(0, maximum);
}

function safeErrorText(value, maximum) {
  return safeText(sanitizeRuntimeError(value), maximum);
}

function projectStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const projected = {};
  for (const key of ['sources', 'articles', 'outputs', 'durationMs', 'remaining', 'blocked']) {
    if (Number.isFinite(stats[key])) projected[key] = stats[key];
  }
  if (typeof stats.mode === 'string') projected.mode = safeText(stats.mode, 20);
  if (typeof stats.ai === 'string') projected.ai = safeText(stats.ai, 100);
  const selection = projectSelectionStats(stats.selection);
  if (selection) projected.selection = selection;
  return projected;
}

function projectUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    ...(Number.isFinite(usage.input) ? { input: usage.input } : {}),
    ...(Number.isFinite(usage.output) ? { output: usage.output } : {}),
  };
}

function projectOutputSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    total: Number.isFinite(summary.total) ? summary.total : 0,
    succeeded: Number.isFinite(summary.succeeded) ? summary.succeeded : 0,
    failed: Number.isFinite(summary.failed) ? summary.failed : 0,
  };
}
