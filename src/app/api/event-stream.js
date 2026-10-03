/**
 * `GET /api/events` (`viewer`): server-sent events from the runtime event bus.
 *
 * Every message is an unnamed SSE `data:` line holding
 * `{ type, at, data }`: first `{ type: 'connected' }`, then runtime events
 * (`run.started`, `run.finished`, `control.applied`, `channel.changed`,
 * `credential.changed`) whose `data` keeps bounded scalar fields only
 * (identifiers, statuses, reasons; never secrets or generated content).
 * A comment line every ~25 s keeps proxies (Cloudflare) from closing an idle
 * stream. A stream ends when the Access token it was opened with expires, so
 * the browser reconnects through Access with a fresh, re-verified token.
 * Closed connections unsubscribe immediately; `closeAll()` ends every stream
 * at shutdown.
 */

import { projectRuntimeEvent } from './redaction.js';

export const DEFAULT_SSE_HEARTBEAT_MS = 25_000;
const RECONNECT_DELAY_MS = 5_000;
// setTimeout's ceiling; a stream living that long simply ends early and reconnects.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * @param {{
 *   runtime: Pick<import('../runtime/create-runtime.js').ContentRadarRuntime, 'onEvent'>,
 *   heartbeatMs?: number,
 *   clock?: () => Date,
 * }} options
 * @returns {{ open: import('express').RequestHandler, closeAll: () => void, readonly size: number }}
 */
export function createEventStreams({ runtime, heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS, clock = () => new Date() }) {
  if (typeof runtime?.onEvent !== 'function') throw new TypeError('Event streams require a runtime with onEvent()');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('SSE heartbeat must be a positive integer');
  /** @type {Set<{ close: () => void, end: () => void }>} */
  const clients = new Set();

  function open(req, res) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.flushHeaders();

    let closed = false;
    let heartbeat = null;
    let expiry = null;
    let unsubscribe = () => {};
    const write = chunk => {
      if (closed || res.writableEnded || res.destroyed) return;
      res.write(chunk);
    };
    const client = {
      close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(expiry);
        unsubscribe();
        clients.delete(client);
      },
      end() {
        client.close();
        if (!res.writableEnded) res.end();
      },
    };
    clients.add(client);
    req.on('close', client.close);
    res.on('close', client.close);
    res.on('error', client.close);

    unsubscribe = runtime.onEvent(event => write(`data: ${JSON.stringify(projectRuntimeEvent(event))}\n\n`));
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    heartbeat.unref?.();
    // Without a known expiry (never the case behind authenticateAccess) the stream ends at once.
    const remainingMs = Number.isFinite(req.auth?.expiresAt) ? req.auth.expiresAt - clock().getTime() : 0;
    expiry = setTimeout(client.end, Math.min(Math.max(remainingMs, 0), MAX_TIMER_MS));
    expiry.unref?.();
    write(`retry: ${RECONNECT_DELAY_MS}\ndata: ${JSON.stringify({ type: 'connected', at: clock().toISOString(), data: {} })}\n\n`);
  }

  return {
    open,
    closeAll() {
      for (const client of [...clients]) client.end();
    },
    get size() {
      return clients.size;
    },
  };
}
