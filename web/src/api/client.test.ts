import { describe, expect, it, vi } from 'vitest';

import { ApiError, buildUrl, createApiClient, SESSION_EXPIRED_MESSAGE } from './client';
import { createApi } from './endpoints';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What a browser hands back for `redirect: 'manual'` when Access redirects to its login page. */
function opaqueRedirect(): Response {
  return { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), text: async () => '' } as unknown as Response;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('createApiClient', () => {
  it('sends same-origin JSON requests with manual redirects and no auth header', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => json(202, { status: 'queued', channelId: 'a', runId: 'r', position: 1 }));
    const api = createApi(createApiClient({ fetch }));

    await api.runNow('telegram-ops');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/channels/telegram-ops/run');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', body: '{}' });
    expect(init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });

    fetch.mockResolvedValueOnce(json(200, { items: [], page: { limit: 8, offset: 0, total: 0 } }));
    await api.listContent({ status: ['delivered', 'failed'], keyword: 'rust ai', limit: 8 });
    const [listUrl, listInit] = fetch.mock.calls[1] ?? [];
    expect(listUrl).toBe('/api/content?status=delivered%2Cfailed&keyword=rust+ai&limit=8');
    expect(listInit?.method).toBe('GET');
    expect(listInit?.body).toBeUndefined();
  });

  it('treats a 401 as an expired session, notifies once, and stops calling the network', async () => {
    const fetch = vi.fn(async () => json(401, { error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' }));
    const client = createApiClient({ fetch });
    const listener = vi.fn();
    client.onSessionExpired(listener);

    const error = await failure(client.request('/api/me'));
    expect(error.status).toBe(401);
    expect(error.code).toBe('session_expired');
    expect(error.isSessionExpired).toBe(true);
    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(client.sessionExpired).toBe(true);

    const again = await failure(client.request('/api/channels'));
    expect(again.isSessionExpired).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats an opaque redirect to the Access login (status 0) as an expired session', async () => {
    const client = createApiClient({ fetch: async () => opaqueRedirect() });
    const error = await failure(client.request('/api/health'));
    expect(error.status).toBe(0);
    expect(error.isSessionExpired).toBe(true);
    expect(client.sessionExpired).toBe(true);
  });

  it('treats a raw 3xx redirect as an expired session too', async () => {
    const client = createApiClient({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } }) });
    const error = await failure(client.request('/api/health'));
    expect(error.isSessionExpired).toBe(true);
  });

  it('maps 403 to a forbidden error without expiring the session', async () => {
    const client = createApiClient({
      fetch: async () => json(403, { error: 'forbidden', message: 'Tài khoản của bạn không có quyền thực hiện thao tác này.' }),
    });
    const error = await failure(client.request('/api/channels/a/run', { method: 'POST' }));
    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden');
    expect(error.isForbidden).toBe(true);
    expect(error.isSessionExpired).toBe(false);
    expect(error.message).toBe('Tài khoản của bạn không có quyền thực hiện thao tác này.');
    expect(client.sessionExpired).toBe(false);
  });

  it('keeps the code, issues, and details of a 409 version conflict', async () => {
    const client = createApiClient({
      fetch: async () => json(409, {
        error: 'version_conflict',
        message: 'Dữ liệu đã được thay đổi ở nơi khác; hãy tải lại rồi thử lại.',
        issues: [{ field: 'version', code: 'stale', message: 'Phiên bản cũ.' }, { bogus: true }],
        details: { currentVersion: 9 },
      }),
    });
    const error = await failure(client.request('/api/channels/a', { method: 'PUT', body: { version: 8 } }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('version_conflict');
    expect(error.isVersionConflict).toBe(true);
    expect(error.issues).toEqual([{ field: 'version', code: 'stale', message: 'Phiên bản cũ.' }]);
    expect(error.details).toEqual({ currentVersion: 9 });
  });

  it('maps 400 validation issues field by field', async () => {
    const issues = [
      { field: 'cron', code: 'invalid_cron', message: 'Cron sai.' },
      { field: 'sources.0.config.feedUrl', code: 'invalid_url', message: 'URL sai.' },
    ];
    const client = createApiClient({ fetch: async () => json(400, { error: 'validation_failed', message: 'Dữ liệu không hợp lệ.', issues }) });
    const error = await failure(client.request('/api/channels', { method: 'POST', body: {} }));
    expect(error.code).toBe('validation_failed');
    expect(error.issues).toEqual(issues);
  });

  it('reports network failures without expiring the session', async () => {
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const error = await failure(client.request('/api/health'));
    expect(error.status).toBe(0);
    expect(error.code).toBe('network_error');
    expect(client.sessionExpired).toBe(false);
  });

  it('describes non-JSON server errors by status', async () => {
    const client = createApiClient({ fetch: async () => new Response('<html>Bad gateway</html>', { status: 502 }) });
    const error = await failure(client.request('/api/health'));
    expect(error.status).toBe(502);
    expect(error.code).toBe('http_502');
    expect(error.message).toContain('502');
  });

  it('rethrows aborts so query cancellation stays silent', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const client = createApiClient({
      fetch: async () => {
        throw abort;
      },
    });
    await expect(client.request('/api/health')).rejects.toBe(abort);
  });

  it('refuses paths outside /api', async () => {
    const client = createApiClient({ fetch: async () => json(200, {}) });
    await expect(client.request('https://evil.example/api/x')).rejects.toThrow(TypeError);
  });
});

describe('buildUrl', () => {
  it('drops empty values and joins arrays', () => {
    expect(buildUrl('/api/stats', { from: '2026-10-01T00:00:00Z', to: undefined, channelId: '', utcOffsetMinutes: 420 }))
      .toBe('/api/stats?from=2026-10-01T00%3A00%3A00Z&utcOffsetMinutes=420');
    expect(buildUrl('/api/content', { status: [] })).toBe('/api/content');
  });
});

describe('gateway timeouts', () => {
  it('explain that the work may still be running', async () => {
    const client = createApiClient({ fetch: async () => new Response('<html>timeout</html>', { status: 524 }) });
    const error = await failure(client.request('/api/channels/a/preview', { method: 'POST' }));
    expect(error.code).toBe('http_524');
    expect(error.message).toContain('Thao tác có thể vẫn đang chạy');
  });
});
