/**
 * Errors the runtime service raises for requests it refuses. `code` is a
 * stable machine code the API layer maps to an HTTP status; messages never
 * contain secrets or credential values.
 *
 * Codes:
 * - `runtime_not_leased`: this instance does not hold the runtime lease (503).
 * - `runtime_stopped`: the runtime is shutting down or stopped (503).
 * - `channel_disabled`: manual runs need an enabled channel (409).
 * - `channel_busy`: the channel is running or queued (409).
 * - `channel_not_paused`, `channel_has_unresolved`: deletion preconditions (409).
 * - `version_conflict`: stale `expectedVersion` (409).
 * - `target_not_found`: recovery target does not exist for this channel (404).
 * - `control_rejected`: the delivery state machine refused the action (409).
 */
export class RuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
