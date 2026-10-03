/**
 * Statistics route (`viewer`).
 * - `GET /api/stats?from&to&channelId&utcOffsetMinutes` → `{ range, postsPerDay,
 *   sourceHealthPerDay, failureRatesPerDay, tokenUsagePerDay }`. `from`
 *   (inclusive) and `to` (exclusive) are required ISO instants at most 400
 *   days apart; `utcOffsetMinutes` (-720…840, default 0) sets where each day
 *   starts (the dashboard sends 420 for Vietnam time).
 */

import { Router } from 'express';

import { pickQuery } from './http.js';

const STATS_QUERY_KEYS = Object.freeze(['from', 'to', 'channelId', 'utcOffsetMinutes']);

/**
 * @param {{
 *   runtime: import('../runtime/create-runtime.js').ContentRadarRuntime,
 *   guards: { viewer: import('express').RequestHandler },
 * }} options
 * @returns {import('express').Router}
 */
export function createStatsRoutes({ runtime, guards }) {
  const router = Router();
  router.get('/stats', guards.viewer, (req, res) => {
    res.json(runtime.getStats(pickQuery(req.query, STATS_QUERY_KEYS)));
  });
  return router;
}
