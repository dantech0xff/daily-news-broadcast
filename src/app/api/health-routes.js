/**
 * Liveness and identity endpoints.
 * - `GET /healthz` (outside `/api`, no authentication): Docker liveness only;
 *   the body is `ok` and nothing else.
 * - `GET /api/health`: any valid Access JWT, including unmapped service
 *   tokens (used to verify the deployment): version, time, runtime lease
 *   view, and channel count.
 * - `GET /api/me`: the caller's identity and role (viewer or operator).
 */

import { createHash } from 'node:crypto';

import { Router } from 'express';

/** @type {import('express').RequestHandler} */
export function liveness(_req, res) {
  res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
}

/**
 * @param {{
 *   runtime: Pick<import('../runtime/create-runtime.js').ContentRadarRuntime, 'getHealth'|'listChannels'>,
 *   version: string,
 *   clock: () => Date,
 *   guards: { viewer: import('express').RequestHandler },
 * }} options
 * @returns {import('express').Router}
 */
export function createHealthRoutes({ runtime, version, clock, guards }) {
  const router = Router();

  router.get('/health', (_req, res) => {
    const health = runtime.getHealth();
    const holder = health.leaseHolder;
    res.json({
      status: 'ok',
      version,
      time: clock().toISOString(),
      runtime: {
        active: health.active === true,
        leased: health.leased === true,
        leaseHolder: holder ? {
          id: shortOwnerId(holder.ownerId),
          self: holder.ownerId === health.ownerId,
          expiresAt: holder.expiresAt,
        } : null,
        running: Boolean(health.running),
        queued: health.queued,
        scheduledChannels: health.scheduledChannels,
      },
      channelCount: runtime.listChannels().length,
    });
  });

  router.get('/me', guards.viewer, (req, res) => {
    res.json({ identity: req.auth.identity, role: req.auth.role });
  });

  return router;
}

// Owner ids embed the host name and pid; the health view needs only a stable handle.
function shortOwnerId(ownerId) {
  return createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 8);
}
