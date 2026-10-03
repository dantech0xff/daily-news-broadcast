/**
 * HTTP client of the app API.
 *
 * - Relative `/api/...` URLs only. In production Cloudflare Access injects the
 *   `Cf-Access-Jwt-Assertion` header at the edge, so the browser sends no auth
 *   header; the Access session cookie rides along as a same-origin credential.
 * - `redirect: 'manual'`: when the Access session has expired, Access answers
 *   with a redirect to `*.cloudflareaccess.com`. Browsers surface that as an
 *   `opaqueredirect` response (status 0); with a 401 it means the session is
 *   gone. The client then flags the session as expired once, notifies
 *   listeners, and refuses every later request without touching the network,
 *   so nothing retries in a loop; only a full page reload re-authenticates.
 * - Every failure is an `ApiError` carrying the HTTP `status`, the machine
 *   `code` (`error` of the API body, or a client code), a Vietnamese
 *   `message`, field `issues`, and `details`.
 */

import type { ApiIssue } from './types';

export const SESSION_EXPIRED_CODE = 'session_expired';
export const NETWORK_ERROR_CODE = 'network_error';
export const INVALID_RESPONSE_CODE = 'invalid_response';

export const SESSION_EXPIRED_MESSAGE = 'Phiên đăng nhập đã hết hạn. Hãy tải lại trang để đăng nhập lại.';
export const NETWORK_ERROR_MESSAGE = 'Không kết nối được tới máy chủ. Kiểm tra mạng rồi thử lại.';
export const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const INVALID_RESPONSE_MESSAGE = 'Máy chủ trả về dữ liệu không đọc được.';

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  query?: Readonly<Record<string, QueryValue>>;
  /** JSON body of a mutation; mutations without one send `{}`. Ignored for GET. */
  body?: unknown;
  signal?: AbortSignal;
}

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  issues?: readonly ApiIssue[];
  details?: Readonly<Record<string, unknown>>;
}

export class ApiError extends Error {
  /** HTTP status; `0` when no HTTP response was read (network failure, opaque redirect). */
  readonly status: number;
  /** API machine code (`validation_failed`, `version_conflict`, …) or a client code. */
  readonly code: string;
  readonly issues: readonly ApiIssue[];
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor({ status, code, message, issues = [], details }: ApiErrorInit) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }

  get isSessionExpired(): boolean {
    return this.code === SESSION_EXPIRED_CODE;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isVersionConflict(): boolean {
    return this.code === 'version_conflict';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** True once a response showed that the Access session is gone. */
  readonly sessionExpired: boolean;
  /** Called once, when the session is first found expired. Returns an unsubscribe function. */
  onSessionExpired(listener: () => void): () => void;
  /** Flag the session as expired (e.g. when the event stream finds out first). */
  markSessionExpired(): void;
}

export interface ApiClientOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createApiClient({ fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) }: ApiClientOptions = {}): ApiClient {
  let expired = false;
  const listeners = new Set<() => void>();

  function markSessionExpired(): void {
    if (expired) return;
    expired = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[api] session listener failed', error);
      }
    }
  }

  async function request<T>(path: string, { method = 'GET', query, body, signal }: RequestOptions = {}): Promise<T> {
    if (!path.startsWith('/api/')) throw new TypeError(`API paths must start with /api/: ${path}`);
    if (expired) throw sessionExpiredError(0);
    const mutation = method !== 'GET';
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      headers: mutation ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
      ...(signal ? { signal } : {}),
    };

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(path, query), init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError({ status: 0, code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE });
    }

    if (isSessionLoss(response)) {
      markSessionExpired();
      throw sessionExpiredError(response.status);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return (await readJson(response)) as T;
  }

  return {
    request,
    get sessionExpired() {
      return expired;
    },
    onSessionExpired(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markSessionExpired,
  };
}

/** `/api/...?a=1&b=x,y`; `null`, `undefined`, and `''` values are left out, arrays are comma-joined. */
export function buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

// Access redirects to its login page when the session cookie expired: browsers
// expose the manual redirect as an opaque response with status 0 (other
// runtimes show the raw 3xx); a 401 means the request reached the app without
// a valid Access token.
function isSessionLoss(response: Response): boolean {
  return response.type === 'opaqueredirect'
    || response.status === 0
    || response.status === 401
    || (response.status >= 300 && response.status < 400);
}

function sessionExpiredError(status: number): ApiError {
  return new ApiError({ status, code: SESSION_EXPIRED_CODE, message: SESSION_EXPIRED_MESSAGE });
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const body = await readJsonQuietly(response);
  const record = isRecord(body) ? body : {};
  const code = typeof record.error === 'string' && record.error !== '' ? record.error : `http_${response.status}`;
  const serverMessage = typeof record.message === 'string' && record.message.trim() !== '' ? record.message : null;
  return new ApiError({
    status: response.status,
    code,
    message: serverMessage ?? fallbackMessage(response.status),
    issues: Array.isArray(record.issues) ? record.issues.filter(isIssue) : [],
    details: isRecord(record.details) ? record.details : undefined,
  });
}

function fallbackMessage(status: number): string {
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 404) return 'Không tìm thấy.';
  // 524 is Cloudflare's origin timeout (about 100 s); the work may still finish on the server.
  if (status === 504 || status === 524) return 'Máy chủ phản hồi quá lâu nên kết nối bị ngắt. Thao tác có thể vẫn đang chạy; hãy thử lại sau.';
  if (status >= 500) return `Máy chủ gặp lỗi (HTTP ${status}). Hãy thử lại sau.`;
  return `Yêu cầu thất bại (HTTP ${status}).`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({ status: response.status, code: INVALID_RESPONSE_CODE, message: INVALID_RESPONSE_MESSAGE });
  }
}

async function readJsonQuietly(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is ApiIssue {
  return isRecord(value) && typeof value.field === 'string' && typeof value.code === 'string' && typeof value.message === 'string';
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
