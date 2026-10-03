/**
 * Operational routes: channel status, queue, recovery targets, run history,
 * manual runs, read-only previews, and operator controls. Reads need
 * `viewer`; runs, previews, and controls need `operator` plus the mutation
 * guards, and record the authenticated identity as the operator.
 * - `GET /api/channels/:id/status` → status snapshot (`version` = delivery-state
 *   version for pause/resume, `configVersion` = config version for PUT)
 * - `GET /api/channels/:id/queue?day=YYYY-MM-DD` → queue of one publishing day
 * - `GET /api/channels/:id/unresolved?limit&offset` → recovery targets with allowed actions
 * - `GET /api/channels/:id/runs?limit&offset` → `{ runs, page }`, newest first
 * - `GET /api/runs/:id` → run with per-source health
 * - `POST /api/channels/:id/run` (`{}`) → 202 `{ status: 'queued', channelId, runId, position }`
 * - `POST /api/channels/:id/preview` (`{}`) → dry-run projection; never sends or writes state
 * - `POST /api/channels/:id/control/:action` → control result
 */

import { Router } from 'express';

import { ValidationError } from '../channels/validation.js';
import { CONTROL_ACTIONS } from '../runtime/controls.js';
import { ApiError } from './errors.js';
import { pickQuery, readBody } from './http.js';
import { projectControlResult } from './redaction.js';

const PAGE_KEYS = Object.freeze(['limit', 'offset']);
const RUN_SKIP_STATUS = Object.freeze({ channel_busy: 409, runtime_not_leased: 503, runtime_stopped: 503 });

/**
 * @param {{
 *   runtime: import('../runtime/create-runtime.js').ContentRadarRuntime,
 *   guards: { viewer: import('express').RequestHandler, mutation: (limit?: string) => import('express').RequestHandler[] },
 * }} options
 * @returns {import('express').Router}
 */
export function createOperationRoutes({ runtime, guards }) {
  const router = Router();

  router.get('/channels/:id/status', guards.viewer, async (req, res) => {
    res.json(await runtime.getStatus(req.params.id));
  });

  router.get('/channels/:id/queue', guards.viewer, async (req, res) => {
    res.json(await runtime.listQueue(req.params.id, req.query.day));
  });

  router.get('/channels/:id/unresolved', guards.viewer, async (req, res) => {
    res.json(await runtime.listUnresolved(req.params.id, pickQuery(req.query, PAGE_KEYS)));
  });

  router.get('/channels/:id/runs', guards.viewer, (req, res) => {
    res.json(runtime.listRuns(req.params.id, pickQuery(req.query, PAGE_KEYS)));
  });

  router.get('/runs/:id', guards.viewer, (req, res) => {
    const run = runtime.getRun(req.params.id);
    if (!run) throw new ApiError(404, 'run_not_found');
    res.json(run);
  });

  router.post('/channels/:id/run', guards.mutation(), async (req, res) => {
    readBody(req.body, []);
    const result = await runtime.runNow(req.params.id, req.auth.actor);
    if (result.status !== 'queued') {
      const known = Object.hasOwn(RUN_SKIP_STATUS, result.reason);
      throw new ApiError(known ? RUN_SKIP_STATUS[result.reason] : 409, known ? result.reason : 'run_skipped');
    }
    res.status(202).json(result);
  });

  router.post('/channels/:id/preview', guards.mutation(), async (req, res) => {
    readBody(req.body, []);
    res.json(await runtime.preview(req.params.id));
  });

  router.post('/channels/:id/control/:action', guards.mutation(), async (req, res) => {
    const { action } = req.params;
    if (!CONTROL_ACTIONS.includes(action)) {
      throw new ValidationError('Control request is invalid', [{
        field: 'action',
        code: 'invalid_value',
        message: `Thao tác hợp lệ: ${CONTROL_ACTIONS.join(', ')}.`,
      }]);
    }
    const result = await runtime.control(req.params.id, action, req.body ?? {}, req.auth.actor);
    res.json(projectControlResult(result));
  });

  return router;
}
