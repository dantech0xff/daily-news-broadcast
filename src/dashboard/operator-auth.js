import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Validate and hold the two mandatory Basic-auth role credentials. */
export function createDashboardAuth(env = process.env) {
  const trigger = credential(env.DASHBOARD_TRIGGER_USERNAME, env.DASHBOARD_TRIGGER_PASSWORD);
  const operator = credential(env.DASHBOARD_OPERATOR_USERNAME, env.DASHBOARD_OPERATOR_PASSWORD);
  if (!trigger || !operator) throw new Error('Dashboard trigger and operator credentials are required');
  if (constantTimeEqual(`${trigger.username}\0${trigger.password}`, `${operator.username}\0${operator.password}`)) {
    throw new Error('Dashboard trigger and operator credentials must be distinct');
  }
  return Object.freeze({ trigger, operator });
}

/** Validate bind/origin/TLS policy before the server acquires persistent ownership. */
export function validateDashboardRuntime(env = process.env, options = {}) {
  const host = stringValue(env.DASHBOARD_HOST, '127.0.0.1');
  const port = integerValue(env.DASHBOARD_PORT, 3000, 1, 65_535);
  const loopback = isLoopback(host);
  const hasCert = Boolean(env.DASHBOARD_TLS_CERT_PATH);
  const hasKey = Boolean(env.DASHBOARD_TLS_KEY_PATH);
  if (hasCert !== hasKey) throw new Error('Both dashboard TLS certificate and key paths are required');
  const appTls = options.appTls ?? (hasCert && hasKey);
  const defaultOrigin = `${appTls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const externalOrigin = parseOrigin(env.DASHBOARD_EXTERNAL_ORIGIN || defaultOrigin);
  const trustedProxies = parseTrustedProxies(env.DASHBOARD_TRUSTED_PROXIES);

  if (!loopback) {
    if (!env.DASHBOARD_EXTERNAL_ORIGIN || !externalOrigin.startsWith('https://')) {
      throw new Error('Non-loopback dashboard binding requires an HTTPS external origin');
    }
    if (!appTls && trustedProxies.length === 0) {
      throw new Error('Non-loopback dashboard binding requires app TLS or an explicitly allowlisted trusted proxy');
    }
  }
  return Object.freeze({ host, port, loopback, appTls, externalOrigin, trustedProxies });
}

export function requireDashboardRole(auth, requiredRole) {
  if (!['trigger', 'operator'].includes(requiredRole)) throw new Error(`Unknown dashboard role: ${requiredRole}`);
  return (req, res, next) => {
    const presented = parseBasic(req.headers.authorization);
    const role = presented ? authenticate(auth, presented) : null;
    if (!role) {
      res.set('WWW-Authenticate', 'Basic realm="NewsEngine", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (requiredRole === 'operator' && role !== 'operator') {
      return res.status(403).json({ error: 'Operator authority required' });
    }
    req.dashboardRole = role;
    next();
  };
}

export function requireSameOrigin(externalOrigin) {
  return (req, res, next) => {
    let presented;
    try { presented = parseOrigin(req.headers.origin); }
    catch { return res.status(403).json({ error: 'Same-origin request required' }); }
    if (!constantTimeEqual(presented, externalOrigin)) {
      return res.status(403).json({ error: 'Same-origin request required' });
    }
    next();
  };
}

export function requireSecureTransport(runtime) {
  return (req, res, next) => {
    if (!runtime.loopback && !req.secure) {
      return res.status(400).json({ error: 'HTTPS is required' });
    }
    next();
  };
}

export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function authenticate(auth, presented) {
  if (credentialMatches(presented, auth.operator)) return 'operator';
  if (credentialMatches(presented, auth.trigger)) return 'trigger';
  return null;
}

function credentialMatches(presented, expected) {
  const usernameMatches = constantTimeEqual(presented.username, expected.username);
  const passwordMatches = constantTimeEqual(presented.password, expected.password);
  return usernameMatches && passwordMatches;
}

function parseBasic(header) {
  if (typeof header !== 'string' || header.length > 2_048) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function credential(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!username.trim() || !password.trim() || username.includes(':') || username.length > 200 || password.length > 500) return null;
  return Object.freeze({ username, password });
}

function constantTimeEqual(left, right) {
  const leftHash = createHash('sha256').update(String(left)).digest();
  const rightHash = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isLoopback(host) {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function parseOrigin(value) {
  if (typeof value !== 'string' || !value) throw new Error('Dashboard external origin is invalid');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Dashboard external origin must be an HTTP(S) origin without path, credentials, query, or fragment');
  }
  return url.origin;
}

function parseTrustedProxies(value) {
  if (value === undefined || value === '') return [];
  const entries = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 32) throw new Error('DASHBOARD_TRUSTED_PROXIES is invalid');
  for (const entry of entries) {
    const [address, rawPrefix, extra] = entry.split('/');
    const family = isIP(address);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (extra !== undefined || maximum === -1) throw new Error(`Invalid trusted proxy: ${entry}`);
    if (rawPrefix !== undefined && (!/^\d+$/.test(rawPrefix) || Number(rawPrefix) > maximum)) {
      throw new Error(`Invalid trusted proxy: ${entry}`);
    }
  }
  return entries;
}

function stringValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value);
}

function integerValue(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Dashboard port must be between ${minimum} and ${maximum}`);
  }
  return Number(value);
}
