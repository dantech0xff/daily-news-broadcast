/**
 * Express application of the Content Radar dashboard, composed without
 * opening a socket (see `server.js` for the process lifecycle).
 *
 * Request pipeline:
 * 1. Security headers on every response (CSP without inline scripts,
 *    `nosniff`, `no-referrer`, `DENY` framing); `x-powered-by` is off.
 * 2. `GET /healthz`: liveness for the container health check, the only
 *    route served without authentication; it answers `ok` and nothing else.
 * 3. `Cache-Control: no-store` on everything under `/api`.
 * 4. Cloudflare Access JWT verification for every other request, API and UI
 *    alike (401 without a valid token). There is no bypass.
 * 5. Roles: `/api/health` accepts any valid token; every other read needs
 *    `viewer`; every mutation needs `operator`, the exact `PUBLIC_ORIGIN` as
 *    `Origin`, `Content-Type: application/json`, and a bounded body (8 KB,
 *    64 KB for channel create/update).
 * 6. API routes, then the static UI with SPA fallback, then the error handler
 *    (see `api/errors.js` for the error contract).
 */

import { fileURLToPath } from 'node:url';

import express from 'express';

import { authenticateAccess, requireRole } from './auth/access-middleware.js';
import { createChannelRoutes } from './api/channel-routes.js';
import { createContentRoutes } from './api/content-routes.js';
import { createCredentialRoutes } from './api/credential-routes.js';
import { ApiError, createErrorHandler } from './api/errors.js';
import { DEFAULT_SSE_HEARTBEAT_MS, createEventStreams } from './api/event-stream.js';
import { createHealthRoutes, liveness } from './api/health-routes.js';
import {
  CHANNEL_JSON_LIMIT,
  DEFAULT_JSON_LIMIT,
  jsonBody,
  noStore,
  requireJsonContent,
  requireSameOrigin,
  securityHeaders,
} from './api/http.js';
import { createOperationRoutes } from './api/operation-routes.js';
import { createStatsRoutes } from './api/stats-routes.js';
import { createWebUi } from './api/web-ui.js';

/** Built dashboard (`web/dist` at the repository root). */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * @param {{
 *   runtime: import('./runtime/create-runtime.js').ContentRadarRuntime,
 *   verifier: { verify: (token: string|null) => Promise<import('./auth/access-jwt.js').AccessClaims> },
 *   roles: { roleFor: (identity: import('./auth/roles.js').AccessIdentity|null) => 'viewer'|'operator'|null },
 *   publicOrigin: string,
 *   version: string,
 *   webDir?: string,
 *   logger?: Pick<Console, 'log'|'warn'|'error'>,
 *   clock?: () => Date,
 *   sseHeartbeatMs?: number,
 * }} options
 * @returns {{ app: import('express').Express, closeEventStreams: () => void }}
 */
export function createApp({
  runtime,
  verifier,
  roles,
  publicOrigin,
  version,
  webDir = DEFAULT_WEB_DIR,
  logger = console,
  clock = () => new Date(),
  sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS,
}) {
  if (!runtime || typeof runtime.getHealth !== 'function') throw new TypeError('createApp requires the app runtime');
  if (typeof version !== 'string' || version === '') throw new TypeError('createApp requires a version');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('etag', false);

  const parsers = { [DEFAULT_JSON_LIMIT]: jsonBody(DEFAULT_JSON_LIMIT), [CHANNEL_JSON_LIMIT]: jsonBody(CHANNEL_JSON_LIMIT) };
  const operator = requireRole('operator');
  const sameOrigin = requireSameOrigin(publicOrigin);
  const guards = Object.freeze({
    viewer: requireRole('viewer'),
    /** @param {string} [limit] */
    mutation: (limit = DEFAULT_JSON_LIMIT) => {
      if (!parsers[limit]) throw new TypeError(`No JSON parser for limit ${limit}`);
      return [operator, sameOrigin, requireJsonContent, parsers[limit]];
    },
  });
  const events = createEventStreams({ runtime, heartbeatMs: sseHeartbeatMs, clock });

  app.use(securityHeaders);
  app.get('/healthz', liveness);
  app.use('/api', noStore);
  app.use(authenticateAccess({ verifier, roles, logger }));

  const api = express.Router();
  api.use(createHealthRoutes({ runtime, version, clock, guards }));
  api.use(createChannelRoutes({ runtime, guards }));
  api.use(createCredentialRoutes({ runtime, guards }));
  api.use(createOperationRoutes({ runtime, guards }));
  api.use(createContentRoutes({ runtime, guards }));
  api.use(createStatsRoutes({ runtime, guards }));
  api.get('/events', guards.viewer, events.open);
  api.use((_req, _res, next) => next(new ApiError(404, 'not_found')));
  app.use('/api', api);

  app.use(guards.viewer, ...createWebUi({ webDir }));
  app.use((_req, _res, next) => next(new ApiError(404, 'not_found')));
  app.use(createErrorHandler({ logger }));

  return { app, closeEventStreams: () => events.closeAll() };
}
