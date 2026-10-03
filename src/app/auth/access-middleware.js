/**
 * Express middleware that authenticates every request with the Cloudflare
 * Access JWT and enforces the role a route needs. Failures are passed to the
 * error handler as `AccessTokenError` (401/503) or `AccessDeniedError` (403);
 * tokens and claims are never logged.
 */

import { AccessTokenError, readAccessToken } from './access-jwt.js';
import { actorFor, hasRole, identityFromClaims } from './roles.js';

/** The identity is authenticated but lacks the role the route needs (403). */
export class AccessDeniedError extends Error {
  /** @param {'viewer'|'operator'} required */
  constructor(required) {
    super(`The ${required} role is required`);
    this.name = 'AccessDeniedError';
    this.code = 'forbidden';
    this.status = 403;
    this.requiredRole = required;
  }
}

/**
 * @typedef {object} RequestAuth
 * @property {import('./roles.js').AccessIdentity|null} identity
 * @property {'viewer'|'operator'|null} role
 * @property {string|null} actor Audit identity for the runtime; `null` without a role.
 * @property {number} expiresAt Token expiry in epoch milliseconds (long-lived streams end then).
 */

/**
 * Verify the Access JWT and attach `req.auth` (frozen `RequestAuth`).
 * @param {{
 *   verifier: { verify: (token: string|null) => Promise<import('./access-jwt.js').AccessClaims> },
 *   roles: { roleFor: (identity: import('./roles.js').AccessIdentity|null) => 'viewer'|'operator'|null },
 *   logger?: Pick<Console, 'error'>,
 * }} options
 * @returns {import('express').RequestHandler}
 */
export function authenticateAccess({ verifier, roles, logger = console }) {
  if (typeof verifier?.verify !== 'function') throw new TypeError('authenticateAccess requires an Access verifier');
  if (typeof roles?.roleFor !== 'function') throw new TypeError('authenticateAccess requires a role resolver');
  return async (req, _res, next) => {
    let claims;
    try {
      claims = await verifier.verify(readAccessToken(req.headers));
    } catch (error) {
      if (error instanceof AccessTokenError && error.code === 'keys_unavailable') {
        logger.error?.(`[Auth] ${error.message}: ${error.reason ?? 'unknown reason'}`);
      }
      next(error instanceof AccessTokenError ? error : new AccessTokenError('invalid_token'));
      return;
    }
    const identity = identityFromClaims(claims);
    const role = roles.roleFor(identity);
    req.auth = Object.freeze({ identity, role, actor: role ? actorFor(identity) : null, expiresAt: claims.exp * 1000 });
    next();
  };
}

/**
 * Require at least `required` (operator ⊇ viewer). Must run after `authenticateAccess`.
 * @param {'viewer'|'operator'} required
 * @returns {import('express').RequestHandler}
 */
export function requireRole(required) {
  hasRole('viewer', required); // Rejects unknown role names at wiring time.
  return (req, _res, next) => {
    next(hasRole(req.auth?.role, required) ? undefined : new AccessDeniedError(required));
  };
}
