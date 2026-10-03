/**
 * Network guard of the E2E server process: like `tests/helpers/deny-network.js`,
 * but loopback stays allowed because the server itself is reached on
 * 127.0.0.1. Every other outbound connection is refused before it leaves the
 * process, at two layers:
 * - `globalThis.fetch` (what every source, AI, and output plugin uses), with
 *   a clear error naming the blocked origin;
 * - `net.Socket#connect`, which also covers `http`/`https`/`tls` and fetch's
 *   own sockets, as a backstop for anything that bypasses `fetch`.
 * Blocked attempts are reported to the `onBlocked` listener so the harness can
 * record them and the specs can prove that nothing tried to go out.
 */

import net from 'node:net';

const BLOCKED_CODE = 'E2E_NETWORK_BLOCKED';
const SELF_TEST_HOST = '192.0.2.1';
const SELF_TEST_TIMEOUT_MS = 2_000;

export class BlockedNetworkError extends Error {
  /** @param {string} target Origin or `host:port`; never includes paths or credentials. */
  constructor(target) {
    super(`Outbound network access blocked by the E2E harness: ${target}`);
    this.name = 'BlockedNetworkError';
    this.code = BLOCKED_CODE;
    this.target = target;
  }
}

/**
 * @param {string|undefined|null} host Hostname or IP literal (IPv6 may be bracketed).
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const value = String(host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (net.isIPv4(value)) return value.startsWith('127.');
  if (net.isIPv6(value)) return value === '::1' || value === '0:0:0:0:0:0:0:1' || /^::ffff:127\./.test(value);
  return false;
}

/**
 * Install the guard once per process.
 * @returns {{ onBlocked: (listener: (entry: { via: string, target: string, at: string }) => void) => void, selfTest: () => Promise<void> }}
 */
export function installNetworkGuard() {
  if (globalThis.__E2E_NETWORK_GUARD__) throw new Error('The E2E network guard is already installed');
  let listener = () => {};
  const block = (via, target) => {
    const error = new BlockedNetworkError(target);
    try {
      listener({ via, target, at: new Date().toISOString() });
    } catch {
      // Recording a blocked attempt must never turn into a different failure.
    }
    return error;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = requestUrl(input);
    if (!url || !isLoopbackHost(url.hostname)) throw block('fetch', url ? url.origin : 'unparseable URL');
    return originalFetch(input, init);
  };

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (target && !isLoopbackHost(target.host)) {
      const error = block('socket', `${target.host}:${target.port}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  Object.defineProperty(globalThis, '__E2E_NETWORK_GUARD__', { value: true });

  return {
    onBlocked(next) {
      if (typeof next !== 'function') throw new TypeError('onBlocked needs a function');
      listener = next;
    },
    /**
     * Prove both layers refuse a non-loopback destination. The target is a
     * TEST-NET-1 documentation address (RFC 5737): even a broken guard would
     * reach nobody. Call it before `onBlocked`, so nothing is recorded.
     */
    async selfTest() {
      await expectBlocked(() => globalThis.fetch(`https://${SELF_TEST_HOST}/`, { signal: AbortSignal.timeout(SELF_TEST_TIMEOUT_MS) }), 'fetch');
      await expectBlocked(() => new Promise((resolve, reject) => {
        const socket = net.connect({ host: SELF_TEST_HOST, port: 443 });
        socket.setTimeout(SELF_TEST_TIMEOUT_MS, () => socket.destroy(new Error('connect timed out')));
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      }), 'net.connect');
    },
  };
}

async function expectBlocked(attempt, layer) {
  try {
    await attempt();
  } catch (error) {
    if (error?.code === BLOCKED_CODE) return;
    throw new Error(`E2E network guard self-test: ${layer} failed with an unexpected error (${error?.message ?? error})`);
  }
  throw new Error(`E2E network guard self-test: ${layer} reached a public address`);
}

function requestUrl(input) {
  try {
    if (input instanceof URL) return input;
    return new URL(typeof input === 'string' ? input : input?.url);
  } catch {
    return null;
  }
}

/**
 * TCP destination of a `Socket#connect` call, or `null` for IPC (path) connections.
 * Node calls it as `connect(options[, cb])`, `connect(port[, host][, cb])`,
 * `connect(path[, cb])`, or internally with one normalized `[options, cb]` array.
 */
function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    if (first.path !== undefined && first.path !== null) return null;
    return { host: first.host ?? 'localhost', port: first.port };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  }
  return null;
}
