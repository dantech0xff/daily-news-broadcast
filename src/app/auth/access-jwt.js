/**
 * Cloudflare Access JWT verification (defense in depth behind Access).
 *
 * The token is read only from the `Cf-Access-Jwt-Assertion` header that
 * Access adds to every proxied request. The `CF_Authorization` cookie and the
 * `Cf-Access-Authenticated-User-Email` header are never trusted. Every token
 * is checked for an RS256 signature by a key of the team's JWKS (selected by
 * `kid`), the team-domain issuer, one of the configured AUD tags, and an
 * unexpired `exp` (with a small clock tolerance).
 */

import { readFile } from 'node:fs/promises';

import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify } from 'jose';

import { sanitizeRuntimeError } from '../../channels/runner.js';

/** Lowercase name of the only header the token is read from. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_JWT_ALGORITHMS = Object.freeze(['RS256']);
export const ACCESS_CLOCK_TOLERANCE_SECONDS = 30;
export const MAX_ACCESS_TOKEN_LENGTH = 8_192;
/**
 * Issuer of locally signed development tokens (`npm run dev:token`). Used as
 * the default issuer only when ACCESS_JWKS_FILE is set and NODE_ENV is
 * `development` or `test`.
 */
export const DEV_ACCESS_ISSUER = 'https://dev-access.content-radar.invalid';

const MAX_CLOCK_TOLERANCE_SECONDS = 60;
const MAX_JWKS_FILE_BYTES = 64 * 1024;
// Compact JWS: base64url header and payload, possibly empty signature (rejected later).
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * The request carries no usable Access token (`missing_token`,
 * `invalid_token`: 401), or the signing keys could not be loaded
 * (`keys_unavailable`: 503). Messages never contain the token or its claims.
 */
export class AccessTokenError extends Error {
  /**
   * @param {'missing_token'|'invalid_token'|'keys_unavailable'} code
   * @param {{ reason?: string }} [options] `reason` is a short machine reason safe to log.
   */
  constructor(code, { reason } = {}) {
    super(code === 'keys_unavailable'
      ? 'Cloudflare Access signing keys are unavailable'
      : code === 'missing_token' ? 'Cloudflare Access token is missing' : 'Cloudflare Access token is invalid');
    this.name = 'AccessTokenError';
    this.code = code;
    this.status = code === 'keys_unavailable' ? 503 : 401;
    if (reason) this.reason = reason;
  }
}

/**
 * @typedef {import('jose').JWTPayload & { email?: unknown, common_name?: unknown }} AccessClaims
 */

/**
 * Read the Access JWT from the request headers. Only `Cf-Access-Jwt-Assertion`
 * is accepted.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string|null}
 */
export function readAccessToken(headers) {
  const value = headers?.[ACCESS_JWT_HEADER];
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token === '' ? null : token;
}

/**
 * @param {{
 *   issuer: string,
 *   audience: readonly string[],
 *   keySet: import('jose').JWTVerifyGetKey,
 *   clock?: () => Date,
 *   clockToleranceSeconds?: number,
 * }} options
 *   - `keySet`: key resolver from `createAccessKeySet()` (or an injected
 *     `createLocalJWKSet()` in tests).
 *   - `clock`: the time `exp`/`nbf` are checked against.
 * @returns {{ verify: (token: string|null) => Promise<AccessClaims> }}
 */
export function createAccessVerifier({
  issuer,
  audience,
  keySet,
  clock = () => new Date(),
  clockToleranceSeconds = ACCESS_CLOCK_TOLERANCE_SECONDS,
}) {
  if (typeof issuer !== 'string' || issuer === '') throw new TypeError('Access verifier requires an issuer');
  if (!Array.isArray(audience) || audience.length === 0 || audience.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new TypeError('Access verifier requires at least one audience');
  }
  if (typeof keySet !== 'function') throw new TypeError('Access verifier requires a key set');
  if (typeof clock !== 'function') throw new TypeError('Access verifier clock must be a function');
  if (!Number.isFinite(clockToleranceSeconds) || clockToleranceSeconds < 0 || clockToleranceSeconds > MAX_CLOCK_TOLERANCE_SECONDS) {
    throw new TypeError(`Access clock tolerance must be between 0 and ${MAX_CLOCK_TOLERANCE_SECONDS} seconds`);
  }
  const options = Object.freeze({
    issuer,
    audience: [...audience],
    algorithms: [...ACCESS_JWT_ALGORITHMS],
    clockTolerance: clockToleranceSeconds,
    requiredClaims: ['exp'],
  });

  return Object.freeze({
    /**
     * @param {string|null} token
     * @returns {Promise<AccessClaims>} The verified claims.
     * @throws {AccessTokenError}
     */
    async verify(token) {
      if (token === null || token === undefined || token === '') throw new AccessTokenError('missing_token');
      if (typeof token !== 'string' || token.length > MAX_ACCESS_TOKEN_LENGTH || !COMPACT_JWS_PATTERN.test(token)) {
        throw new AccessTokenError('invalid_token', { reason: 'malformed' });
      }
      try {
        const { payload } = await jwtVerify(token, keySet, { ...options, currentDate: clock() });
        return payload;
      } catch (error) {
        throw classifyVerificationError(error);
      }
    },
  });
}

/**
 * Key resolver for the configured key source: the local JWKS file in
 * development and tests, otherwise the team's remote JWKS (cached by `jose`,
 * refetched on an unknown `kid` at most once per cooldown).
 * @param {Pick<import('../config/env.js').AccessConfig, 'certsUrl'|'jwksFile'>} access
 * @returns {Promise<import('jose').JWTVerifyGetKey>}
 */
export async function createAccessKeySet(access) {
  if (access?.jwksFile) return createLocalJWKSet(await readJwksFile(access.jwksFile));
  if (typeof access?.certsUrl !== 'string') throw new TypeError('Access key set requires a JWKS URL');
  // A container's first outbound HTTPS request (DNS + TLS) can exceed jose's
  // 5 s default, which made the first request after a deploy answer 503.
  return createRemoteJWKSet(new URL(access.certsUrl), { timeoutDuration: REMOTE_JWKS_TIMEOUT_MS });
}

export const REMOTE_JWKS_TIMEOUT_MS = 15_000;
const WARM_UP_ATTEMPTS = 3;
const WARM_UP_RETRY_MS = 2_000;

/**
 * Fetch the remote signing keys once in the background so the first request
 * does not wait for them. Failures are logged, never thrown: verification
 * fetches the keys again on demand.
 * @param {import('jose').JWTVerifyGetKey & { reload?: () => Promise<void> }} keySet
 * @param {{ logger?: Pick<Console, 'log'|'warn'>, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<boolean>} Whether the keys were loaded.
 */
export async function warmUpAccessKeySet(keySet, {
  logger = console,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()),
} = {}) {
  if (typeof keySet?.reload !== 'function') return false;
  for (let attempt = 1; attempt <= WARM_UP_ATTEMPTS; attempt++) {
    try {
      await keySet.reload();
      logger.log?.('[Auth] Cloudflare Access signing keys loaded');
      return true;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : String(error?.name ?? 'Error');
      logger.warn?.(`[Auth] Loading Cloudflare Access signing keys failed (attempt ${attempt}/${WARM_UP_ATTEMPTS}): ${code}`);
      if (attempt < WARM_UP_ATTEMPTS) await sleep(WARM_UP_RETRY_MS * attempt);
    }
  }
  return false;
}

/**
 * Read a local JSON Web Key Set of public signing keys.
 * @param {string} path
 * @returns {Promise<import('jose').JSONWebKeySet>}
 */
export async function readJwksFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`ACCESS_JWKS_FILE could not be read (${error?.code ?? 'unknown error'})`);
  }
  let jwks = null;
  try {
    jwks = Buffer.byteLength(text, 'utf8') <= MAX_JWKS_FILE_BYTES ? JSON.parse(text) : null;
  } catch {
    jwks = null;
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : null;
  if (!keys || keys.length === 0 || keys.some(key => !key || typeof key !== 'object' || 'd' in key)) {
    throw new Error('ACCESS_JWKS_FILE must be a JSON Web Key Set with at least one public key and no private key material');
  }
  return { keys };
}

// Token problems are 401. Failing to load the keys (network, timeout, a bad
// JWKS response) is the server's problem and must not read as a bad token.
// Only the error code is kept for token problems: jose attaches the claims.
function classifyVerificationError(error) {
  const code = typeof error?.code === 'string' ? error.code : String(error?.name ?? 'Error');
  const keysUnavailable = !(error instanceof errors.JOSEError)
    || error instanceof errors.JWKSTimeout
    || error instanceof errors.JWKSInvalid
    || error.code === 'ERR_JOSE_GENERIC';
  if (!keysUnavailable) return new AccessTokenError('invalid_token', { reason: code.slice(0, 80) });
  return new AccessTokenError('keys_unavailable', { reason: `${code}: ${sanitizeRuntimeError(error)}`.slice(0, 300) });
}
