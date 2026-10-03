/**
 * Redaction and bounded projections for API responses, logs, and server-sent
 * events (ported from the retired Express dashboard). Free text that may
 * carry provider details is passed through `sanitizeRuntimeError()` and has
 * URLs and environment references removed; projections copy whitelisted
 * scalar fields only, so new internal fields never leak by default.
 */

import { sanitizeRuntimeError } from '../../channels/runner.js';

const EVENT_DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_EVENT_FIELDS = 20;

/**
 * Remove URLs and environment-variable references, and bound the length.
 * @param {unknown} value
 * @param {number} maximum
 * @returns {string}
 */
export function safeText(value, maximum) {
  return String(value)
    .replace(/unresolved environment reference:\s*[A-Za-z_][A-Za-z0-9_]*/gi, 'unresolved environment reference')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '[redacted-env]')
    .slice(0, maximum);
}

/**
 * `safeText()` over the runtime error sanitizer (tokens, secrets, provider bodies).
 * @param {unknown} value Error or text.
 * @param {number} maximum
 * @returns {string}
 */
export function safeErrorText(value, maximum) {
  return safeText(sanitizeRuntimeError(value), maximum);
}

/**
 * Result of an operator control: identifiers, states, and versions only.
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
export function projectControlResult(result) {
  return {
    channelId: typeof result?.channelId === 'string' ? safeText(result.channelId, 128) : null,
    action: typeof result?.action === 'string' ? safeText(result.action, 40) : null,
    status: safeText(result?.status ?? 'failed', 80),
    replayed: result?.replayed === true,
    ...(typeof result?.paused === 'boolean' ? { paused: result.paused } : {}),
    ...(Number.isSafeInteger(result?.version) ? { version: result.version } : {}),
    ...(typeof result?.deliveryId === 'string' ? { deliveryId: safeText(result.deliveryId, 500) } : {}),
    ...(typeof result?.deliveryState === 'string' ? { deliveryState: safeText(result.deliveryState, 80) } : {}),
    ...(typeof result?.outboxId === 'string' ? { outboxId: safeText(result.outboxId, 500) } : {}),
    ...(typeof result?.outboxState === 'string' ? { outboxState: safeText(result.outboxState, 80) } : {}),
  };
}

/**
 * Runtime event for server-sent events: type, time, and bounded scalar data.
 * @param {import('../runtime/events.js').RuntimeEvent} event
 * @returns {{ type: string, at: string, data: Record<string, string|number|boolean|null> }}
 */
export function projectRuntimeEvent(event) {
  const data = {};
  for (const [key, value] of Object.entries(event?.data ?? {}).slice(0, MAX_EVENT_FIELDS)) {
    if (!EVENT_DATA_KEY.test(key)) continue;
    if (typeof value === 'string') data[key] = safeErrorText(value, 300);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) data[key] = value;
  }
  return {
    type: safeText(event?.type ?? 'unknown', 40),
    at: typeof event?.at === 'string' ? safeText(event.at, 40) : new Date().toISOString(),
    data,
  };
}
