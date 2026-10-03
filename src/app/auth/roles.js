/**
 * Identities and roles. Cloudflare Access authenticates people (`email`
 * claim) and service tokens (`common_name` claim = client ID, no email); the
 * app maps them to one of two roles through the environment:
 * - `viewer`: every read;
 * - `operator`: every read and every mutation (operator ⊇ viewer).
 * An authenticated identity that is not mapped has no role (403); a request
 * without a valid token never reaches role checks (401).
 */

/** Roles an identity can be mapped to, weakest first. */
export const ACCESS_ROLES = Object.freeze(['viewer', 'operator']);

const ROLE_RANK = Object.freeze({ viewer: 1, operator: 2 });
const MAX_EMAIL_LENGTH = 320;
const MAX_CLIENT_ID_LENGTH = 200;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * @typedef {Readonly<{ type: 'user', email: string } | { type: 'service', clientId: string }>} AccessIdentity
 */

/**
 * Identity carried by verified Access claims: a user when `email` is set,
 * otherwise a service token when `common_name` is set.
 * @param {import('./access-jwt.js').AccessClaims} claims
 * @returns {AccessIdentity|null} `null` when the token names no usable identity.
 */
export function identityFromClaims(claims) {
  const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (email !== '') {
    return email.length <= MAX_EMAIL_LENGTH && VISIBLE_ASCII.test(email) && email.includes('@')
      ? Object.freeze({ type: 'user', email })
      : null;
  }
  const clientId = typeof claims?.common_name === 'string' ? claims.common_name.trim() : '';
  if (clientId !== '' && clientId.length <= MAX_CLIENT_ID_LENGTH && VISIBLE_ASCII.test(clientId)) {
    return Object.freeze({ type: 'service', clientId });
  }
  return null;
}

/**
 * @param {import('../config/env.js').RoleConfig} roles
 * @returns {{ roleFor: (identity: AccessIdentity|null) => 'viewer'|'operator'|null }}
 */
export function createRoleResolver({ operatorEmails = [], viewerEmails = [], serviceTokens = [] } = {}) {
  const emails = new Map();
  for (const email of viewerEmails) emails.set(String(email).toLowerCase(), 'viewer');
  // Listed as both: the stronger role wins.
  for (const email of operatorEmails) emails.set(String(email).toLowerCase(), 'operator');
  const clients = new Map();
  for (const { clientId, role } of serviceTokens) {
    if (!ACCESS_ROLES.includes(role)) throw new TypeError('Service token role must be viewer or operator');
    clients.set(clientId, role);
  }
  return Object.freeze({
    roleFor(identity) {
      if (identity?.type === 'user') return emails.get(identity.email) ?? null;
      if (identity?.type === 'service') return clients.get(identity.clientId) ?? null;
      return null;
    },
  });
}

/**
 * @param {string|null|undefined} role
 * @param {'viewer'|'operator'} required
 * @returns {boolean}
 */
export function hasRole(role, required) {
  const needed = ROLE_RANK[required];
  if (!needed) throw new TypeError(`Unknown role: ${String(required)}`);
  return (ROLE_RANK[role] ?? 0) >= needed;
}

/**
 * Audit identity recorded by the runtime (`operatorId`, `updatedBy`): the
 * email of a person, or `service:<clientId>` for a service token.
 * @param {AccessIdentity} identity
 * @returns {string}
 */
export function actorFor(identity) {
  if (identity?.type === 'user') return identity.email;
  if (identity?.type === 'service') return `service:${identity.clientId}`;
  throw new TypeError('actorFor requires an Access identity');
}
