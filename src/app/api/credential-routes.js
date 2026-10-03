/**
 * Write-only credential routes. Responses carry metadata only (`id`,
 * `label`, `kind`, `isSet`, timestamps, `updatedBy`, `usedBy`); values are
 * accepted on create/replace and never returned or logged. The audit actor
 * is the authenticated identity, never a body field.
 * - `GET /api/credentials` → `{ credentials: CredentialMetadata[] }`
 * - `POST /api/credentials` (`{ label, kind, value }`) → 201 `CredentialMetadata`
 * - `PUT /api/credentials/:id` (`{ value }`) → `CredentialMetadata`
 * - `DELETE /api/credentials/:id` (`{}`) → `{ credentialId, deleted: true }`; 409 while a channel uses it
 */

import { Router } from 'express';

import { markSensitive, readBody } from './http.js';

/**
 * @param {{
 *   runtime: import('../runtime/create-runtime.js').ContentRadarRuntime,
 *   guards: { viewer: import('express').RequestHandler, mutation: (limit?: string) => import('express').RequestHandler[] },
 * }} options
 * @returns {import('express').Router}
 */
export function createCredentialRoutes({ runtime, guards }) {
  const router = Router();

  router.get('/credentials', guards.viewer, (_req, res) => {
    res.json({ credentials: runtime.listCredentials() });
  });

  router.post('/credentials', markSensitive, guards.mutation(), (req, res) => {
    const input = readBody(req.body, ['label', 'kind', 'value']);
    res.status(201).json(runtime.createCredential(input, req.auth.actor));
  });

  router.put('/credentials/:id', markSensitive, guards.mutation(), (req, res) => {
    const input = readBody(req.body, ['value']);
    res.json(runtime.replaceCredential(req.params.id, input, req.auth.actor));
  });

  router.delete('/credentials/:id', markSensitive, guards.mutation(), (req, res) => {
    readBody(req.body, []);
    res.json(runtime.deleteCredential(req.params.id, req.auth.actor));
  });

  return router;
}
