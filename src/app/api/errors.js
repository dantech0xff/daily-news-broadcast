/**
 * HTTP error contract of the app API. Every error response is
 * `{ error, message, issues?, details? }`:
 * - `error`: stable English machine code (switch on this);
 * - `message`: short Vietnamese text for the dashboard;
 * - `issues`: field problems of a `validation_failed` error;
 * - `details`: bounded extra data of some codes (`currentVersion`, `usedBy`, `fields`, …).
 *
 * Status mapping:
 * - 400 `validation_failed`, `invalid_json`, `bad_request` (other malformed requests);
 * - 401 `unauthenticated` (missing or invalid Access JWT);
 * - 403 `forbidden` (no role, or viewer on a mutation), `same_origin_required`;
 * - 404 `not_found`, `channel_not_found`, `credential_not_found`, `run_not_found`,
 *   `content_not_found`, `target_not_found`;
 * - 409 state conflicts the caller can resolve by changing state first:
 *   `version_conflict`, `channel_exists`, `channel_busy`, `channel_disabled`,
 *   `channel_not_paused`, `channel_has_unresolved`, `control_rejected`,
 *   `credential_in_use`, `run_skipped`, `cutover_required` (set the channel's
 *   `notBefore` before resuming, running, or retrying an output);
 * - 413 `payload_too_large`; 415 `unsupported_media_type`;
 * - 422 the channel's stored config is incomplete: `missing_credential`,
 *   `credential_unavailable` (`details.fields` names the credential slots);
 * - 503 `runtime_not_leased`, `runtime_stopped`, `access_keys_unavailable`;
 * - 500 `internal_error` with message `Request failed` (logged, sanitized).
 *
 * `/api/*` errors are JSON; other paths get a minimal HTML page. Nothing here
 * echoes request bodies, tokens, or provider payloads.
 */

import { AccessTokenError } from '../auth/access-jwt.js';
import { AccessDeniedError } from '../auth/access-middleware.js';
import { ChannelCredentialError } from '../channels/build-channel.js';
import { ChannelConflictError, ChannelNotFoundError } from '../channels/channel-repository.js';
import { ValidationError } from '../channels/validation.js';
import { RuntimeError } from '../runtime/errors.js';
import { CredentialInUseError, CredentialNotFoundError } from '../secrets/credential-repository.js';
import { safeErrorText, safeText } from './redaction.js';

export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: 'Cần đăng nhập qua Cloudflare Access.',
  access_keys_unavailable: 'Chưa tải được khoá xác thực của Cloudflare Access; hãy thử lại sau.',
  forbidden: 'Tài khoản của bạn không có quyền thực hiện thao tác này.',
  same_origin_required: 'Yêu cầu thay đổi phải được gửi từ chính dashboard.',
  unsupported_media_type: 'Cần gửi JSON với Content-Type: application/json.',
  payload_too_large: 'Dữ liệu gửi lên vượt quá giới hạn cho phép.',
  invalid_json: 'Nội dung JSON không hợp lệ.',
  bad_request: 'Yêu cầu không hợp lệ.',
  validation_failed: 'Dữ liệu không hợp lệ.',
  not_found: 'Không tìm thấy.',
  channel_not_found: 'Không tìm thấy kênh.',
  credential_not_found: 'Không tìm thấy credential.',
  run_not_found: 'Không tìm thấy lượt chạy.',
  content_not_found: 'Không tìm thấy bài viết.',
  target_not_found: 'Không tìm thấy mục cần xử lý.',
  channel_exists: 'ID kênh đã tồn tại.',
  version_conflict: 'Dữ liệu đã được thay đổi ở nơi khác; hãy tải lại rồi thử lại.',
  channel_busy: 'Kênh đang chạy hoặc đang chờ chạy.',
  channel_disabled: 'Kênh đang tắt.',
  channel_not_paused: 'Cần tạm dừng kênh trước khi xoá.',
  channel_has_unresolved: 'Kênh còn mục chưa xử lý xong.',
  control_rejected: 'Thao tác bị từ chối ở trạng thái hiện tại.',
  credential_in_use: 'Credential đang được kênh sử dụng.',
  run_skipped: 'Lượt chạy bị bỏ qua.',
  cutover_required: 'Kênh cần đặt mốc cutover (notBefore) trước khi resume, chạy hoặc gửi lại bài, để chỉ bài publish sau mốc này được đăng.',
  missing_credential: 'Kênh thiếu credential bắt buộc.',
  credential_unavailable: 'Không đọc được credential của kênh.',
  runtime_not_leased: 'Instance này chưa giữ runtime lease (có thể một instance khác đang chạy); hãy thử lại sau.',
  runtime_stopped: 'Ứng dụng đang dừng.',
  internal_error: 'Request failed',
});

/** Titles of the HTML error pages served outside `/api`. */
const HTML_TITLES = Object.freeze({
  401: 'Chưa xác thực',
  403: 'Không có quyền truy cập',
  404: 'Không tìm thấy',
  503: 'Tạm thời không khả dụng',
});

/** Status of each runtime error code the API exposes (see the module comment). */
const RUNTIME_ERROR_STATUS = Object.freeze({
  runtime_not_leased: 503,
  runtime_stopped: 503,
  channel_disabled: 409,
  channel_busy: 409,
  channel_not_paused: 409,
  channel_has_unresolved: 409,
  version_conflict: 409,
  control_rejected: 409,
  cutover_required: 409,
  target_not_found: 404,
});

const BODY_ERROR_CODES = Object.freeze({
  'entity.too.large': [413, 'payload_too_large'],
  'entity.parse.failed': [400, 'invalid_json'],
  'charset.unsupported': [415, 'unsupported_media_type'],
  'encoding.unsupported': [415, 'unsupported_media_type'],
});

/** An error with an explicit status and machine code, raised by route handlers. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {keyof typeof ERROR_MESSAGES} code
   * @param {{ details?: Record<string, unknown>, issues?: readonly object[] }} [options]
   */
  constructor(status, code, { details, issues } = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (issues !== undefined) this.issues = issues;
  }
}

/**
 * @typedef {object} HttpErrorView
 * @property {number} status
 * @property {string} code
 * @property {readonly object[]} [issues]
 * @property {Record<string, unknown>} [details]
 * @property {boolean} [unexpected] True for 500s, which are logged.
 */

/**
 * Map any error a route can raise to its HTTP status and machine code.
 * @param {unknown} error
 * @returns {HttpErrorView}
 */
export function describeHttpError(error) {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, details: error.details, issues: error.issues };
  }
  if (error instanceof AccessTokenError) {
    return { status: error.status, code: error.code === 'keys_unavailable' ? 'access_keys_unavailable' : 'unauthenticated' };
  }
  if (error instanceof AccessDeniedError) return { status: 403, code: 'forbidden' };
  if (error instanceof ValidationError) return { status: 400, code: 'validation_failed', issues: error.issues };
  if (error instanceof ChannelNotFoundError) return { status: 404, code: 'channel_not_found' };
  if (error instanceof CredentialNotFoundError) return { status: 404, code: 'credential_not_found' };
  if (error instanceof ChannelConflictError) {
    return {
      status: 409,
      code: error.code,
      details: Number.isSafeInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : undefined,
    };
  }
  if (error instanceof CredentialInUseError) {
    return { status: 409, code: 'credential_in_use', details: { usedBy: error.usedBy.map(id => safeText(id, 64)) } };
  }
  if (error instanceof ChannelCredentialError) {
    return { status: 422, code: error.code, details: { fields: error.fields.map(field => safeText(field, 80)) } };
  }
  if (error instanceof RuntimeError && RUNTIME_ERROR_STATUS[error.code]) {
    return { status: RUNTIME_ERROR_STATUS[error.code], code: error.code, details: runtimeDetails(error) };
  }
  const malformed = malformedRequestError(error);
  if (malformed) return malformed;
  return { status: 500, code: 'internal_error', unexpected: true };
}

/**
 * Error-handling middleware: renders the error contract, logs unexpected
 * failures sanitized (routes marked sensitive log only the error class).
 * @param {{ logger?: Pick<Console, 'error'> }} [options]
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler({ logger = console } = {}) {
  return (error, req, res, _next) => {
    const view = describeHttpError(error);
    if (view.unexpected) {
      const what = res.locals?.sensitive === true
        ? `${safeText(error?.name ?? 'Error', 60)} (details withheld on a credential route)`
        : safeErrorText(error, 500);
      logger.error?.(`[App] ${req.method} ${routeLabel(req)} failed: ${what}`);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.set('Cache-Control', 'no-store');
    if (isApiRequest(req)) {
      res.status(view.status).json(errorBody(view));
      return;
    }
    res.status(view.status).type('html').send(htmlPage(HTML_TITLES[view.status] ?? 'Lỗi', ERROR_MESSAGES[view.code] ?? ERROR_MESSAGES.internal_error));
  };
}

/**
 * @param {HttpErrorView} view
 * @returns {{ error: string, message: string, issues?: readonly object[], details?: Record<string, unknown> }}
 */
export function errorBody(view) {
  return {
    error: view.code,
    message: ERROR_MESSAGES[view.code] ?? ERROR_MESSAGES.internal_error,
    ...(view.issues ? { issues: view.issues } : {}),
    ...(view.details && Object.keys(view.details).length > 0 ? { details: view.details } : {}),
  };
}

/**
 * A minimal static HTML page (no scripts or inline styles, so it satisfies the CSP).
 * @param {string} title Trusted static text.
 * @param {string} message Trusted static text.
 * @returns {string}
 */
export function htmlPage(title, message) {
  return `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Content Radar</title></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>
</html>
`;
}

/**
 * Whether the request targets `/api` (case-insensitive, like Express routing).
 * @param {import('express').Request} req
 */
export function isApiRequest(req) {
  const path = String(req.originalUrl ?? req.url ?? '').split('?')[0].toLowerCase();
  return path === '/api' || path.startsWith('/api/');
}

function runtimeDetails(error) {
  const details = {};
  if (Number.isSafeInteger(error.details?.unresolved)) details.unresolved = error.details.unresolved;
  if (error.code === 'control_rejected') details.reason = safeErrorText(error, 300);
  return Object.keys(details).length > 0 ? details : undefined;
}

// Client errors raised by Express itself: body parsing (`type` set) and
// undecodable route parameters (a `URIError` with status 400).
function malformedRequestError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 499) return null;
  if (typeof error?.type === 'string') {
    const known = BODY_ERROR_CODES[error.type];
    return known ? { status: known[0], code: known[1] } : { status: 400, code: 'bad_request' };
  }
  return error instanceof URIError ? { status: 400, code: 'bad_request' } : null;
}

// Route pattern rather than the URL, so ids and query strings stay out of logs.
// Express resets `req.baseUrl` once a router exits; every router is mounted at `/api`.
function routeLabel(req) {
  const prefix = isApiRequest(req) ? '/api' : '';
  if (typeof req.route?.path === 'string') return safeText(`${prefix}${req.route.path}`, 200);
  return `${prefix || '/'} (middleware)`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
