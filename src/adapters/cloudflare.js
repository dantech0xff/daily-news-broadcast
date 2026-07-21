import { defineChannels } from '../channels/definitions.js';
import { isHalfHourlyScheduleReachable, shouldRun } from '../channels/runner.js';
import { opaqueId, sanitizeError } from '../core/index.js';
import { ThreadsOutput } from '../outputs/threads.js';
import { XOutput } from '../outputs/x.js';
import { KVTokenStore } from '../utils/token-store.js';
import { ChannelDeliveryCoordinator } from './cloudflare-channel-coordinator.js';

export { ChannelDeliveryCoordinator };

export default {
  async scheduled(event, env, ctx) {
    if (runtimeMode(env) !== 'active') return;
    validateAuthConfiguration(env);
    if (event.cron === '0 * * * *') {
      if (String(env.TOKEN_MAINTENANCE_MODE ?? 'disabled') === 'active') {
        ctx.waitUntil(refreshTokens(env));
      }
      return;
    }
    requireCoordinator(env);
    const channels = defineAndValidateChannels(env);
    const requestedAt = new Date(event.scheduledTime);
    const requests = channels
      .filter(channel => shouldRun(channel.schedule, requestedAt, channel.timezone || 'UTC'))
      .map(async channel => {
        const requestId = await opaqueId('scheduled-request', channel.id, event.cron, requestedAt.toISOString());
        return coordinator(env, channel.id).acceptRequest({
          requestId,
          channelId: channel.id,
          triggerType: 'scheduled',
          force: false,
          requestedAt: requestedAt.toISOString(),
        });
      });
    if (requests.length) ctx.waitUntil(Promise.all(requests));
  },

  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/' || url.pathname === '/health') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return json(healthProjection(env));
      }

      const route = classifyRoute(url.pathname);
      if (!route) return json({ error: 'not_found' }, 404);
      validateAuthConfiguration(env);
      if (!authorized(request, route.authority === 'operator' ? env.OPERATOR_SECRET : env.TRIGGER_SECRET)) {
        return json({ error: 'unauthorized' }, 401);
      }

      if (route.method !== request.method) return methodNotAllowed([route.method]);
      const mode = runtimeMode(env);
      if (mode === 'invalid') return json({ error: 'runtime_mode_invalid' }, 503);
      if (mode === 'quiesced') return json({ error: 'runtime_quiesced' }, 409);
      if (mode === 'bootstrap' && route.bootstrapAllowed !== true) {
        return json({ error: 'runtime_not_active', runtimeMode: mode }, 409);
      }
      requireCoordinator(env);

      if (route.name === 'trigger') {
        if (url.searchParams.has('force')) return json({ error: 'force_not_allowed_on_trigger' }, 400);
        const body = await readJson(request);
        if (body.force === true) return json({ error: 'force_not_allowed_on_trigger' }, 400);
        const channel = resolveChannel(env, body.channelId);
        const idempotencyKey = idempotencyKeyFor(request, body);
        const requestId = await requestIdFor('manual', channel.id, idempotencyKey);
        const accepted = await coordinator(env, channel.id).acceptRequest({
          requestId,
          channelId: channel.id,
          triggerType: 'manual',
          force: false,
          requestedAt: new Date().toISOString(),
        });
        return json(withStatusLink(accepted, channel.id), 202);
      }

      if (route.name === 'force' || route.name === 'canary') {
        const body = await readJson(request);
        const channel = resolveChannel(env, body.channelId);
        const idempotencyKey = idempotencyKeyFor(request, body);
        if (route.name === 'canary' && body.singleMutation !== true) throw new HttpError(400, 'singleMutation_required');
        if (route.name === 'canary' && body.confirmPausedMutation !== true) {
          throw new HttpError(400, 'confirmPausedMutation_required');
        }
        if (route.name === 'canary' && body.limit !== 1) throw new HttpError(400, 'canary_limit_one_required');
        if (route.name === 'force' && body.confirmPausedMutation === true) {
          throw new HttpError(400, 'paused_override_reserved_for_canary');
        }
        if (body.duplicateRiskAccepted !== true) throw new HttpError(400, 'duplicateRiskAccepted_required');
        if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) {
          throw new HttpError(400, 'bounded_reason_required');
        }
        const requestId = await requestIdFor(route.name, channel.id, idempotencyKey);
        const accepted = await coordinator(env, channel.id).acceptRequest({
          requestId,
          channelId: channel.id,
          triggerType: route.name,
          force: true,
          operatorForce: route.name === 'canary',
          confirmPausedMutation: route.name === 'canary',
          singleMutation: route.name === 'canary',
          limit: route.name === 'canary' ? 1 : undefined,
          operatorId: requiredEnvironment(env, 'OPERATOR_KEY_ID'),
          reason: body.reason.trim(),
          duplicateRiskAccepted: true,
          requestedAt: new Date().toISOString(),
        });
        return json(withStatusLink(accepted, channel.id), 202);
      }

      if (route.name === 'status') {
        const channel = resolveChannel(env, url.searchParams.get('channel'));
        const stub = coordinator(env, channel.id);
        const canonicalRequestId = url.searchParams.get('requestId');
        const legacyRequestId = url.searchParams.get('request');
        if (canonicalRequestId && legacyRequestId && canonicalRequestId !== legacyRequestId) {
          throw new HttpError(409, 'request_id_conflict');
        }
        const requestId = canonicalRequestId || legacyRequestId;
        if (requestId) {
          const result = await stub.getRequest({ channelId: channel.id, requestId });
          return result ? json(result) : json({ error: 'request_not_found' }, 404);
        }
        return json(await stub.getStatus({
          channelId: channel.id,
          limit: parseBoundedInteger(url.searchParams.get('limit'), 50, 1, 100),
          cursor: parseBoundedInteger(url.searchParams.get('cursor'), 0, 0, 1_000_000),
          targetCursor: parseBoundedInteger(url.searchParams.get('targetCursor'), 0, 0, 1_000_000),
        }));
      }

      if (route.name === 'queue') {
        const channel = resolveChannel(env, url.searchParams.get('channel'));
        return json(await coordinator(env, channel.id).getQueue({
          channelId: channel.id,
          publishingDay: url.searchParams.get('day') || undefined,
          limit: parseBoundedInteger(url.searchParams.get('limit'), 50, 1, 100),
          cursor: parseBoundedInteger(url.searchParams.get('cursor'), 0, 0, 1_000_000),
        }));
      }

      if (route.name === 'preview') {
        const body = await readJson(request);
        const channel = resolveChannel(env, body.channelId);
        return json(await coordinator(env, channel.id).preview({ channelId: channel.id, mode: body.mode }));
      }

      if (route.name === 'control') {
        const body = await readJson(request);
        const channel = resolveChannel(env, body.channelId);
        body.idempotencyKey = idempotencyKeyFor(request, body);
        if (['retry-generation', 'retry-output'].includes(route.action) && !body.requestId) {
          body.requestId = await requestIdFor(route.action, channel.id, body.idempotencyKey);
        }
        const result = await coordinator(env, channel.id).control({
          ...body,
          action: route.action,
          channelId: channel.id,
          operatorId: requiredEnvironment(env, 'OPERATOR_KEY_ID'),
        });
        const projected = withStatusLink(result, channel.id);
        return json(projected, ['retry-generation', 'retry-output'].includes(route.action) ? 202 : 200);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const classified = classifyHttpFailure(error);
      return json({ error: classified.code }, classified.status);
    }
  },
};

function classifyRoute(pathname) {
  if (pathname === '/trigger') return { name: 'trigger', method: 'POST', authority: 'trigger', mutating: true };
  if (pathname === '/force') return { name: 'force', method: 'POST', authority: 'operator', mutating: true };
  if (pathname === '/canary') return { name: 'canary', method: 'POST', authority: 'operator', mutating: true };
  if (pathname === '/status') return { name: 'status', method: 'GET', authority: 'trigger', bootstrapAllowed: true };
  if (pathname === '/queue') return { name: 'queue', method: 'GET', authority: 'trigger', bootstrapAllowed: true };
  if (pathname === '/preview') return { name: 'preview', method: 'POST', authority: 'trigger', mutating: false };
  const control = pathname.match(/^\/control\/(pause|resume|retry-generation|retry-output|restore-topology|confirm-delivered|abandon|retry-maintenance|migrate-legacy)$/);
  return control ? {
    name: 'control',
    action: control[1],
    method: 'POST',
    authority: 'operator',
    bootstrapAllowed: control[1] === 'pause',
  } : null;
}

function coordinator(env, channelId) {
  const namespace = requireCoordinator(env);
  return namespace.getByName(channelId);
}

function requireCoordinator(env) {
  if (!env.NEWS_COORDINATOR?.getByName) throw new HttpError(503, 'coordinator_binding_missing');
  return env.NEWS_COORDINATOR;
}

function defineAndValidateChannels(env) {
  const channels = defineChannels(env);
  const ids = new Set();
  for (const channel of channels) {
    if (!channel.id || ids.has(channel.id)) throw new HttpError(500, 'invalid_channel_configuration');
    ids.add(channel.id);
    if (!channel.schedule || !channel.output || !channel.ai || !Array.isArray(channel.sources) || channel.sources.length === 0) {
      throw new HttpError(500, 'invalid_channel_configuration');
    }
    if (!isHalfHourlyScheduleReachable(channel.schedule, channel.timezone || 'UTC')) {
      throw new HttpError(500, 'channel_schedule_unreachable');
    }
  }
  return channels;
}

function resolveChannel(env, channelId) {
  if (!channelId || typeof channelId !== 'string') throw new HttpError(400, 'channelId_required');
  const channels = defineAndValidateChannels(env);
  const channel = channels.find(value => value.id === channelId);
  if (!channel) throw new HttpError(404, 'channel_not_found');
  return channel;
}

async function requestIdFor(kind, channelId, idempotencyKey) {
  const key = String(idempotencyKey ?? '').trim();
  if (!key) throw new HttpError(400, 'idempotency_key_required');
  if (key.length > 200) throw new HttpError(400, 'idempotency_key_too_long');
  return opaqueId('worker-request', kind, channelId, key);
}

function idempotencyKeyFor(request, body) {
  const header = String(request.headers.get('idempotency-key') ?? '').trim();
  const payload = String(body?.idempotencyKey ?? '').trim();
  if (header && payload && header !== payload) throw new HttpError(409, 'idempotency_key_conflict');
  const key = header || payload;
  if (!key) throw new HttpError(400, 'idempotency_key_required');
  if (key.length > 200) throw new HttpError(400, 'idempotency_key_too_long');
  return key;
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'application_json_required');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > 16 * 1024) throw new HttpError(413, 'request_body_too_large');
  const text = await readBoundedRequestText(request, 16 * 1024);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

async function readBoundedRequestText(request, byteLimit) {
  const body = request.body;
  if (!body || typeof body.getReader !== 'function') return '';
  const buffer = new Uint8Array(byteLimit);
  const reader = body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (chunk.byteLength > byteLimit - offset) {
        try { await reader.cancel(); } catch {}
        throw new HttpError(413, 'request_body_too_large');
      }
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function validateAuthConfiguration(env) {
  const trigger = requiredEnvironment(env, 'TRIGGER_SECRET');
  const operator = requiredEnvironment(env, 'OPERATOR_SECRET');
  requiredEnvironment(env, 'OPERATOR_KEY_ID');
  if (constantTimeEqual(trigger, operator)) throw new HttpError(503, 'auth_secrets_must_be_distinct');
}

function authorized(request, secret) {
  const header = request.headers.get('authorization') ?? '';
  return constantTimeEqual(header, `Bearer ${secret}`);
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  const length = Math.max(a.length, b.length, 1);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index++) mismatch |= (a[index % (a.length || 1)] ?? 0) ^ (b[index % (b.length || 1)] ?? 0);
  return mismatch === 0;
}

function requiredEnvironment(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new HttpError(503, `${name.toLowerCase()}_missing`);
  return value;
}

function runtimeMode(env) {
  const mode = String(env.NEWS_RUNTIME_MODE ?? 'bootstrap').toLowerCase();
  return ['quiesced', 'bootstrap', 'active'].includes(mode) ? mode : 'invalid';
}

function healthProjection(env) {
  let channelCount = null;
  try { channelCount = defineChannels(env).length; } catch {}
  const buildVersion = String(env.BUILD_VERSION ?? env.CF_VERSION_METADATA?.id ?? '').trim();
  return {
    status: 'ok',
    runtimeMode: runtimeMode(env),
    time: new Date().toISOString(),
    buildVersion: buildVersion ? buildVersion.slice(0, 200) : null,
    channelCount,
  };
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new HttpError(400, 'invalid_pagination');
  return number;
}

function methodNotAllowed(methods) {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: {
      Allow: methods.join(', '),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function withStatusLink(result, channelId) {
  if (!result?.requestId) return result;
  return {
    ...result,
    statusLink: `/status?channel=${encodeURIComponent(channelId)}&requestId=${encodeURIComponent(result.requestId)}`,
  };
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function classifyHttpFailure(error) {
  if (error instanceof HttpError) return { status: error.status, code: error.code };
  const message = sanitizeError(error);
  if (/active request limit/i.test(message)) return { status: 429, code: 'request_limit_reached' };
  if (/conflict|busy|in progress|not committed|requires a paused|must remain paused|stale|changed|blocked/i.test(message)) {
    return { status: 409, code: 'request_conflict' };
  }
  if (/required|invalid|exceeds|must|cannot|only|unsupported|not found|limit=1/i.test(message)) {
    return { status: 422, code: 'invalid_request' };
  }
  console.error(`[Worker] Internal request failure: ${sanitizeError(error)}`);
  return { status: 500, code: 'internal_error' };
}

async function refreshTokens(env) {
  if (!env.TOKEN_ENCRYPTION_KEY || !env.NEWS_CACHE) return;
  const tokenStore = new KVTokenStore(env.NEWS_CACHE, env.TOKEN_ENCRYPTION_KEY);
  if (env.X_CLIENT_ID) {
    try {
      const current = await tokenStore.getToken('x-tech-vn');
      if (!current) {
        const refresh = await tokenStore.getToken('x-tech-vn:refresh');
        if (refresh) await XOutput.refreshToken(tokenStore, 'x-tech-vn', refresh, env.X_CLIENT_ID);
      }
    } catch (error) {
      console.error(`[TokenMaintenance] X refresh failed: ${sanitizeError(error)}`);
    }
  }
  if (env.THREADS_USER_ID) {
    try { await ThreadsOutput.refreshToken(tokenStore, 'threads-dev-vn'); }
    catch (error) { console.error(`[TokenMaintenance] Threads refresh failed: ${sanitizeError(error)}`); }
  }
}
