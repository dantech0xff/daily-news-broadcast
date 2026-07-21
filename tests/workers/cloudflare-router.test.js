import { describe, expect, it, vi } from 'vitest';

import worker from '../../src/adapters/cloudflare.js';

const TRIGGER_SECRET = 'fixture-trigger-authority';
const OPERATOR_SECRET = 'fixture-operator-authority';

function createEnv(stubOverrides = {}) {
  const stub = {
    getStatus: vi.fn(async () => ({
      channel: { channelId: 'telegram-main', paused: true, version: 1 },
      counts: { requests: 0, activeDeliveries: 0, ambiguousOutputs: 0, maintenanceDeadLetters: 0 },
      requests: [],
      nextCursor: null,
    })),
    ...stubOverrides,
  };
  const namespace = { getByName: vi.fn(() => stub) };
  return {
    stub,
    namespace,
    env: {
      NEWS_RUNTIME_MODE: 'active',
      NEWS_COORDINATOR: namespace,
      TRIGGER_SECRET,
      OPERATOR_SECRET,
      OPERATOR_KEY_ID: 'fixture-operator',
      TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
      TELEGRAM_CHAT_ID: 'fixture-chat-id',
      AI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'https://offline-ai.newsengine.invalid',
    },
  };
}

function request(path, { method = 'GET', token, body, idempotencyKey } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('production Cloudflare router authorization', () => {
  it('keeps shallow health public and non-cacheable', async () => {
    const response = await worker.fetch(request('/health'), {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      runtimeMode: 'bootstrap',
      buildVersion: null,
      channelCount: 0,
    });
    expect(Number.isFinite(Date.parse(body.time))).toBe(true);
  });

  it('fails closed before coordinator lookup when auth configuration is missing', async () => {
    const namespace = { getByName: vi.fn() };
    const response = await worker.fetch(request('/status?channel=telegram-main', {
      token: TRIGGER_SECRET,
    }), {
      NEWS_RUNTIME_MODE: 'active',
      NEWS_COORDINATOR: namespace,
    }, {});

    expect(response.status).toBe(503);
    expect(namespace.getByName).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an invalid bearer token without touching the Durable Object', async () => {
    const { env: workerEnv, namespace } = createEnv();
    const response = await worker.fetch(request('/status?channel=telegram-main', {
      token: 'wrong-authority',
    }), workerEnv, {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('does not let trigger authority call an operator-only force route', async () => {
    const { env: workerEnv, namespace } = createEnv();
    const response = await worker.fetch(request('/force', {
      method: 'POST',
      token: TRIGGER_SECRET,
      body: {
        channelId: 'telegram-main',
        idempotencyKey: 'fixture-force-key',
        duplicateRiskAccepted: true,
      },
    }), workerEnv, {});

    expect(response.status).toBe(401);
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('allows trigger authority to read a redacted status projection only', async () => {
    const { env: workerEnv, namespace, stub } = createEnv();
    const response = await worker.fetch(request('/status?channel=telegram-main&limit=10', {
      token: TRIGGER_SECRET,
    }), workerEnv, {});

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(namespace.getByName).toHaveBeenCalledWith('telegram-main');
    expect(stub.getStatus).toHaveBeenCalledWith({
      channelId: 'telegram-main',
      limit: 10,
      cursor: 0,
      targetCursor: 0,
    });
    const body = await response.json();
    expect(body).toMatchObject({ channel: { channelId: 'telegram-main', paused: true } });
    expect(JSON.stringify(body)).not.toContain('fixture-bot-token');
    expect(JSON.stringify(body)).not.toContain('fixture-chat-id');
  });

  it('requires an idempotency key before accepting a manual mutation', async () => {
    const { env: workerEnv, namespace } = createEnv();
    const response = await worker.fetch(request('/trigger', {
      method: 'POST',
      token: TRIGGER_SECRET,
      body: { channelId: 'telegram-main' },
    }), workerEnv, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'idempotency_key_required' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('rejects conflicting header and body idempotency keys', async () => {
    const { env: workerEnv, namespace } = createEnv();
    const response = await worker.fetch(request('/trigger', {
      method: 'POST',
      token: TRIGGER_SECRET,
      idempotencyKey: 'header-key',
      body: { channelId: 'telegram-main', idempotencyKey: 'body-key' },
    }), workerEnv, {});

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'idempotency_key_conflict' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('returns a pollable status link only after a manual request is persisted', async () => {
    const acceptRequest = vi.fn(async () => ({
      requestId: 'persisted-manual-request',
      channelId: 'telegram-main',
      state: 'accepted',
    }));
    const { env: workerEnv } = createEnv({ acceptRequest });
    const response = await worker.fetch(request('/trigger', {
      method: 'POST',
      token: TRIGGER_SECRET,
      idempotencyKey: 'manual-status-link',
      body: { channelId: 'telegram-main' },
    }), workerEnv, {});

    expect(response.status).toBe(202);
    expect(acceptRequest).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      requestId: 'persisted-manual-request',
      statusLink: '/status?channel=telegram-main&requestId=persisted-manual-request',
    });
  });

  it('requires explicit paused-mutation confirmation for a one-mutation canary', async () => {
    const { env: workerEnv, namespace } = createEnv({ acceptRequest: vi.fn() });
    const response = await worker.fetch(request('/canary', {
      method: 'POST',
      token: OPERATOR_SECRET,
      idempotencyKey: 'canary-without-pause-confirmation',
      body: {
        channelId: 'telegram-main',
        singleMutation: true,
        duplicateRiskAccepted: true,
        limit: 1,
        reason: 'offline canary request',
      },
    }), workerEnv, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'confirmPausedMutation_required' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('rejects an ordinary force request that attempts to borrow the paused canary override', async () => {
    const { env: workerEnv, namespace } = createEnv({ acceptRequest: vi.fn() });
    const response = await worker.fetch(request('/force', {
      method: 'POST',
      token: OPERATOR_SECRET,
      idempotencyKey: 'unsafe-force-override',
      body: {
        channelId: 'telegram-main',
        confirmPausedMutation: true,
        duplicateRiskAccepted: true,
        reason: 'must use the canary contract instead',
      },
    }), workerEnv, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'paused_override_reserved_for_canary' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('caps a chunked JSON request before coordinator lookup', async () => {
    const { env: workerEnv, namespace } = createEnv();
    const oversized = request('/trigger', {
      method: 'POST',
      token: TRIGGER_SECRET,
      body: { channelId: 'telegram-main', padding: 'x'.repeat(17 * 1024) },
    });
    expect(oversized.headers.get('content-length')).toBeNull();

    const response = await worker.fetch(oversized, workerEnv, {});
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request_body_too_large' });
    expect(namespace.getByName).not.toHaveBeenCalled();
  });

  it('returns a durable retry request id and a directly pollable status link', async () => {
    const control = vi.fn(async () => ({
      status: 'claimed',
      requestId: 'opaque-operator-retry-request',
      deliveryId: 'delivery-1',
    }));
    const getRequest = vi.fn(async ({ requestId }) => ({ requestId, state: 'completed', outcome: 'success' }));
    const { env: workerEnv } = createEnv({ control, getRequest });
    const response = await worker.fetch(request('/control/retry-output', {
      method: 'POST',
      token: OPERATOR_SECRET,
      idempotencyKey: 'retry-output-status-link',
      body: {
        channelId: 'telegram-main',
        deliveryId: 'delivery-1',
        outputKey: 'output-1',
        expectedVersion: 2,
        reason: 'provider confirms no visible mutation',
        duplicateRiskAccepted: true,
      },
    }), workerEnv, {});
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      requestId: 'opaque-operator-retry-request',
      statusLink: '/status?channel=telegram-main&requestId=opaque-operator-retry-request',
    });

    const status = await worker.fetch(request(body.statusLink, { token: TRIGGER_SECRET }), workerEnv, {});
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      requestId: 'opaque-operator-retry-request',
      state: 'completed',
    });
  });

  it('routes an explicit topology restore as an audited operator action', async () => {
    const control = vi.fn(async action => ({
      status: 'restored',
      deliveryId: action.deliveryId,
      version: action.expectedVersion + 1,
    }));
    const { env: workerEnv } = createEnv({ control });
    const response = await worker.fetch(request('/control/restore-topology', {
      method: 'POST',
      token: OPERATOR_SECRET,
      idempotencyKey: 'restore-matched-topology',
      body: {
        channelId: 'telegram-main',
        deliveryId: 'delivery-topology-blocked',
        expectedVersion: 4,
        reason: 'configured output identity restored and verified',
      },
    }), workerEnv, {});

    expect(response.status).toBe(200);
    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restore-topology',
      channelId: 'telegram-main',
      deliveryId: 'delivery-topology-blocked',
      expectedVersion: 4,
      idempotencyKey: 'restore-matched-topology',
      operatorId: 'fixture-operator',
    }));
  });

  it('uses requestId for exact request-status correlation', async () => {
    const { env: workerEnv, stub } = createEnv({
      getRequest: vi.fn(async ({ requestId }) => ({
        requestId,
        channelId: 'telegram-main',
        state: 'completed',
      })),
    });
    const response = await worker.fetch(request(
      '/status?channel=telegram-main&requestId=opaque-request-id',
      { token: TRIGGER_SECRET },
    ), workerEnv, {});

    expect(response.status).toBe(200);
    expect(stub.getRequest).toHaveBeenCalledWith({
      channelId: 'telegram-main',
      requestId: 'opaque-request-id',
    });
    expect(await response.json()).toMatchObject({ requestId: 'opaque-request-id' });
  });

  it('reports unexpected coordinator/storage faults as generic server failures', async () => {
    const { env: workerEnv } = createEnv({
      getStatus: vi.fn(async () => {
        throw new Error('SQLite read failed at https://private.invalid/?token=secret');
      }),
    });
    const response = await worker.fetch(request('/status?channel=telegram-main', {
      token: TRIGGER_SECRET,
    }), workerEnv, {});

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('keeps status and pause available in hard-paused bootstrap while blocking provider work', async () => {
    const control = vi.fn(async action => ({
      channelId: action.channelId,
      paused: true,
      version: 2,
    }));
    const { env: workerEnv, stub } = createEnv({ control });
    workerEnv.NEWS_RUNTIME_MODE = 'bootstrap';

    const status = await worker.fetch(request('/status?channel=telegram-main', {
      token: TRIGGER_SECRET,
    }), workerEnv, {});
    expect(status.status).toBe(200);
    expect(stub.getStatus).toHaveBeenCalledOnce();

    const pause = await worker.fetch(request('/control/pause', {
      method: 'POST',
      token: OPERATOR_SECRET,
      idempotencyKey: 'bootstrap-pause',
      body: { channelId: 'telegram-main', expectedVersion: 1 },
    }), workerEnv, {});
    expect(pause.status).toBe(200);
    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pause',
      channelId: 'telegram-main',
      idempotencyKey: 'bootstrap-pause',
    }));

    const preview = await worker.fetch(request('/preview', {
      method: 'POST',
      token: TRIGGER_SECRET,
      body: { channelId: 'telegram-main' },
    }), workerEnv, {});
    expect(preview.status).toBe(409);
    expect(await preview.json()).toEqual({
      error: 'runtime_not_active',
      runtimeMode: 'bootstrap',
    });
  });
});

describe('token maintenance runtime gate', () => {
  it('uses active as the only explicit maintenance mode and stays inert otherwise', async () => {
    const activePromises = [];
    await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, {
      NEWS_RUNTIME_MODE: 'active',
      TOKEN_MAINTENANCE_MODE: 'active',
      TRIGGER_SECRET,
      OPERATOR_SECRET,
      OPERATOR_KEY_ID: 'fixture-operator',
    }, {
      waitUntil(promise) { activePromises.push(promise); },
    });
    expect(activePromises).toHaveLength(1);
    await Promise.all(activePromises);

    for (const env of [
      {
        NEWS_RUNTIME_MODE: 'active',
        TOKEN_MAINTENANCE_MODE: 'disabled',
        TRIGGER_SECRET,
        OPERATOR_SECRET,
        OPERATOR_KEY_ID: 'fixture-operator',
      },
      { NEWS_RUNTIME_MODE: 'bootstrap', TOKEN_MAINTENANCE_MODE: 'active' },
      { NEWS_RUNTIME_MODE: 'quiesced', TOKEN_MAINTENANCE_MODE: 'active' },
    ]) {
      const waits = [];
      await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, env, {
        waitUntil(promise) { waits.push(promise); },
      });
      expect(waits).toHaveLength(0);
    }
  });

  it('fails delivery cron before coordinator lookup when operator auth is unusable', async () => {
    const namespace = { getByName: vi.fn() };
    await expect(worker.scheduled({
      cron: '*/30 * * * *',
      scheduledTime: Date.now(),
    }, {
      NEWS_RUNTIME_MODE: 'active',
      NEWS_COORDINATOR: namespace,
      TRIGGER_SECRET: 'same-secret',
      OPERATOR_SECRET: 'same-secret',
      OPERATOR_KEY_ID: 'fixture-operator',
    }, {
      waitUntil: vi.fn(),
    })).rejects.toThrow(/distinct/i);
    expect(namespace.getByName).not.toHaveBeenCalled();
  });
});
