/**
 * Channel configuration routes. Reads need `viewer`; writes need `operator`
 * plus the mutation guards. Records carry credential ids, never values.
 * - `GET /api/channels` → `{ channels: ChannelRecord[] }`
 * - `POST /api/channels` (config) → 201 `ChannelRecord` (created paused)
 * - `GET /api/channels/:id` → `ChannelRecord`
 * - `PUT /api/channels/:id` (changed top-level fields + current `version`) → `ChannelRecord`
 * - `DELETE /api/channels/:id` (`{ expectedVersion }`) → `{ channelId, deleted: true }`
 */

import { Router } from 'express';

import { IssueCollector, ValidationError, readInteger } from '../channels/validation.js';
import { ApiError } from './errors.js';
import { CHANNEL_JSON_LIMIT, readBody } from './http.js';

/**
 * @param {{
 *   runtime: import('../runtime/create-runtime.js').ContentRadarRuntime,
 *   guards: { viewer: import('express').RequestHandler, mutation: (limit?: string) => import('express').RequestHandler[] },
 * }} options
 * @returns {import('express').Router}
 */
export function createChannelRoutes({ runtime, guards }) {
  const router = Router();

  router.get('/channels', guards.viewer, (_req, res) => {
    res.json({ channels: runtime.listChannels() });
  });

  router.post('/channels', guards.mutation(CHANNEL_JSON_LIMIT), async (req, res) => {
    const record = await runtime.createChannel(req.body ?? {}, req.auth.actor);
    res.status(201).json(record);
  });

  router.get('/channels/:id', guards.viewer, (req, res) => {
    const record = runtime.getChannel(req.params.id);
    if (!record) throw new ApiError(404, 'channel_not_found');
    res.json(record);
  });

  router.put('/channels/:id', guards.mutation(CHANNEL_JSON_LIMIT), async (req, res) => {
    res.json(await runtime.updateChannel(req.params.id, req.body ?? {}, req.auth.actor));
  });

  router.delete('/channels/:id', guards.mutation(), async (req, res) => {
    const { expectedVersion } = readBody(req.body, ['expectedVersion']);
    const issues = new IssueCollector();
    const version = readInteger(issues, expectedVersion, 'expectedVersion', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true });
    if (issues.hasIssues) throw new ValidationError('Delete request is invalid', issues.issues);
    res.json(await runtime.deleteChannel(req.params.id, req.auth.actor, { expectedVersion: version }));
  });

  return router;
}
