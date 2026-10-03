/**
 * Content library routes (`viewer`).
 * - `GET /api/content?channelId&status&source&dateField&from&to&keyword&limit&offset`
 *   → `{ items, page: { limit, offset, total } }`; `status` takes a comma list
 *   or repeated parameter; `dateField` is `seen` (default), `published`, or
 *   `delivered`; `from` is inclusive and `to` exclusive (ISO instants with a
 *   zone, URL-encoded); items carry a 300-character `summaryPreview`.
 * - `GET /api/content/:id` → one item with the full `summaryText`.
 */

import { Router } from 'express';

import { ApiError } from './errors.js';
import { pickQuery } from './http.js';

const CONTENT_QUERY_KEYS = Object.freeze([
  'channelId', 'status', 'source', 'dateField', 'from', 'to', 'keyword', 'limit', 'offset',
]);

/**
 * @param {{
 *   runtime: import('../runtime/create-runtime.js').ContentRadarRuntime,
 *   guards: { viewer: import('express').RequestHandler },
 * }} options
 * @returns {import('express').Router}
 */
export function createContentRoutes({ runtime, guards }) {
  const router = Router();

  router.get('/content', guards.viewer, (req, res) => {
    res.json(runtime.listContent(pickQuery(req.query, CONTENT_QUERY_KEYS)));
  });

  router.get('/content/:id', guards.viewer, (req, res) => {
    const item = runtime.getContent(req.params.id);
    if (!item) throw new ApiError(404, 'content_not_found');
    res.json(item);
  });

  return router;
}
