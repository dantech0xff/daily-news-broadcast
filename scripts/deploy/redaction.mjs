/**
 * Redaction for everything the deploy script prints or writes: known secret
 * values (API keys, the service token secret, the app master key) are
 * replaced wherever they appear, secret-looking patterns (bearer tokens, auth
 * headers, JWTs, Cloudflare Tunnel tokens, `cfast_` service token secrets)
 * are masked even when their value was never registered, and the origin
 * server address (ORIGIN_IP) is shown as `ORIGIN_MASK`.
 */

import { PUBLIC_ENV_KEYS } from './config.mjs';

export const REDACTED = '[REDACTED]';
/** How the origin server address appears in output. */
export const ORIGIN_MASK = '<origin-ip>';

// Shorter values would redact ordinary words.
const MIN_SECRET_LENGTH = 8;
const PATTERNS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\b(x-api-key|authorization|cf-access-client-secret|cf-access-jwt-assertion|cf_authorization|set-cookie|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1$2${REDACTED}`],
  // Secret variables as `NAME=value` (dotenv, shell) or `"NAME": "value"` (JSON); prose like "NAME: …" is left alone.
  [/\b(APP_MASTER_KEY|TUNNEL_TOKEN|DOKPLOY_API_KEY|CF_API_TOKEN|CF_ACCESS_CLIENT_SECRET)(\s*=\s*["']?)[^\s"',;]+/g, `$1$2${REDACTED}`],
  [/"(APP_MASTER_KEY|TUNNEL_TOKEN|DOKPLOY_API_KEY|CF_API_TOKEN|CF_ACCESS_CLIENT_SECRET)"(\s*:\s*)"[^"]*"/g, `"$1"$2"${REDACTED}"`],
  [/\bcfast_[A-Za-z0-9_-]+/g, REDACTED],
  // JWTs, then Cloudflare Tunnel tokens (base64 JSON that starts with {"a":).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9+/_=-]{24,}/g, REDACTED],
]);
const SECRET_KEY = /secret|password|passwd|token|api[-_]?key|authorization|cookie|credential|private/i;
// Identifiers whose names look secret but are not (Access policy rule for a service token).
const NON_SECRET_KEYS = new Set(['service_token', 'token_id']);
const ENV_TEXT_KEYS = new Set(['env', 'buildArgs', 'buildSecrets']);

export class Redactor {
  /** @type {Set<string>} */
  #secrets = new Set();
  /** @type {RegExp[]} Forms of the origin address, shown as `ORIGIN_MASK`. */
  #addresses = [];

  /**
   * Register a secret value; returns it unchanged for chaining.
   * @template {string|null|undefined} T
   * @param {T} value
   * @returns {T}
   */
  add(value) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      this.#secrets.add(value);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) this.#secrets.add(encoded);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) this.#secrets.add(escaped);
    }
    return value;
  }

  /**
   * Register the origin server address: not a secret, but never printed or
   * written either. It is matched as a whole token (a longer address that
   * merely contains it stays readable) and also in the dashed form that
   * generated hostnames embed, such as `<app>-203-0-113-10.traefik.me`.
   * @param {string|null|undefined} address An IPv4 address.
   */
  maskAddress(address) {
    if (typeof address !== 'string' || address === '') return;
    for (const form of new Set([address, address.replaceAll('.', '-')])) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      this.#addresses.push(new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, 'g'));
    }
  }

  /**
   * @param {unknown} text
   * @returns {string}
   */
  redact(text) {
    let output = String(text);
    for (const secret of [...this.#secrets].sort((left, right) => right.length - left.length)) {
      output = output.split(secret).join(REDACTED);
    }
    for (const address of this.#addresses) output = output.replace(address, ORIGIN_MASK);
    for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
    return output;
  }

  /**
   * True when `text` contains a registered secret value or the origin address.
   * @param {string} text
   * @returns {boolean}
   */
  containsSecret(text) {
    return [...this.#secrets].some(secret => text.includes(secret))
      || this.#addresses.some(address => text.search(address) !== -1);
  }
}

/**
 * The lines of a dotenv text with every value masked except those of known
 * public keys.
 * @param {unknown} text
 * @returns {unknown} An array of lines for a string; other values unchanged.
 */
export function redactEnvLines(text) {
  if (typeof text !== 'string') return text;
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      const key = (index === -1 ? line : line.slice(0, index)).replace(/^export\s+/, '').trim();
      if (index === -1) return key;
      return PUBLIC_ENV_KEYS.has(key) ? line : `${key}=${REDACTED}`;
    });
}

/**
 * Deep copy of a request or response body safe to print: dotenv fields become
 * their lines with values masked (except public keys), and secret-named
 * fields are masked. Pass the printed result through a `Redactor` as well.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactBody(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map(item => redactBody(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ENV_TEXT_KEYS.has(key)) copy[key] = redactEnvLines(entry);
    else if (!NON_SECRET_KEYS.has(key) && SECRET_KEY.test(key) && entry !== null && entry !== undefined && entry !== '' && typeof entry !== 'boolean') copy[key] = REDACTED;
    else copy[key] = redactBody(entry, depth + 1);
  }
  return copy;
}
