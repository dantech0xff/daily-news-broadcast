/**
 * In-process runtime event bus for the dashboard's server-sent events.
 * Payloads carry identifiers, statuses, and reasons only: never secrets,
 * credential values, or generated content.
 */

import { sanitizeRuntimeError } from '../../channels/runner.js';

export const RUNTIME_EVENT_TYPES = Object.freeze([
  'run.started',
  'run.finished',
  'control.applied',
  'channel.changed',
  'credential.changed',
]);

/**
 * @typedef {object} RuntimeEvent
 * @property {string} type One of `RUNTIME_EVENT_TYPES`.
 * @property {string} at ISO instant.
 * @property {Readonly<Record<string, unknown>>} data
 */

export class RuntimeEvents {
  /**
   * @param {{ clock?: () => Date, logger?: Pick<Console, 'warn'> }} [options]
   */
  constructor({ clock = () => new Date(), logger = console } = {}) {
    this._clock = clock;
    this._logger = logger;
    /** @type {Set<(event: RuntimeEvent) => unknown>} */
    this._listeners = new Set();
  }

  /**
   * @param {(event: RuntimeEvent) => unknown} listener
   * @returns {() => void} Unsubscribe.
   */
  on(listener) {
    if (typeof listener !== 'function') throw new TypeError('Runtime event listener must be a function');
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /**
   * Deliver an event to every listener. A failing listener is logged and
   * never affects the emitter or other listeners.
   * @param {string} type
   * @param {Record<string, unknown>} data
   */
  emit(type, data) {
    if (!RUNTIME_EVENT_TYPES.includes(type)) throw new TypeError(`Unknown runtime event type: ${type}`);
    const event = Object.freeze({ type, at: this._clock().toISOString(), data: Object.freeze({ ...data }) });
    for (const listener of [...this._listeners]) {
      try {
        const result = listener(event);
        if (result && typeof result.then === 'function') {
          result.then(undefined, error => this._listenerFailed(type, error));
        }
      } catch (error) {
        this._listenerFailed(type, error);
      }
    }
  }

  _listenerFailed(type, error) {
    this._logger.warn?.(`[Events] A ${type} listener failed: ${sanitizeRuntimeError(error)}`);
  }
}
