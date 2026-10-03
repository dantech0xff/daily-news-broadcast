/**
 * Configuration of the Dokploy + Cloudflare deploy script: fixed resource
 * names, the production environment contract of the app container, and
 * validation of the operator's environment variables and flags.
 *
 * Problems name variables and rules only, never values: secrets reach the
 * script through the environment and must never be echoed. Secret settings
 * are non-enumerable on the returned config so serializing it cannot leak
 * them.
 */

import { isIP } from 'node:net';

/** Names the script looks resources up by on every run. */
export const NAMES = Object.freeze({
  project: 'content-radar',
  environment: 'production',
  app: 'content-radar',
  cloudflared: 'content-radar-cloudflared',
  tunnel: 'content-radar',
  volume: 'content-radar-data',
  accessApp: 'Content Radar',
  allowPolicy: 'content-radar-users',
  servicePolicy: 'content-radar-agent-service-token',
  otpProvider: 'One-time PIN',
});

export const DEFAULTS = Object.freeze({
  gitUrl: 'https://github.com/dantech0xff/daily-news-broadcast.git',
  gitBranch: 'feat/dokploy-dashboard',
  cloudflaredImage: 'cloudflare/cloudflared:2026.9.3',
  waitMinutes: 30,
});

/** `deployment.readLogs` (used when a deployment fails) arrived in v0.29.5. */
export const MIN_DOKPLOY_VERSION = Object.freeze([0, 29, 5]);
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const APP_PORT = 3000;
export const DATA_MOUNT_PATH = '/data';
/** Mirrors `DEFAULT_SHUTDOWN_WAIT_SECONDS` / `STOP_GRACE_MARGIN_SECONDS` in `src/app/config/env.js`. */
export const SHUTDOWN_WAIT_SECONDS = 120;
export const STOP_GRACE_MARGIN_SECONDS = 15;
export const STOP_GRACE_SECONDS = SHUTDOWN_WAIT_SECONDS + STOP_GRACE_MARGIN_SECONDS;
/** Docker Swarm durations are nanoseconds. */
export const NANOSECONDS_PER_SECOND = 1_000_000_000;

/** One task at a time and the old task stops first: never two schedulers on one SQLite file. */
export const SWARM_UPDATE_CONFIG = Object.freeze({ Parallelism: 1, Order: 'stop-first' });
/** Same probe as the Dockerfile HEALTHCHECK: `/healthz` is the only route served without an Access token. */
export const SWARM_HEALTHCHECK = Object.freeze({
  Test: Object.freeze([
    'CMD', 'node', '-e',
    `fetch('http://127.0.0.1:${APP_PORT}/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
  ]),
  Interval: 30 * NANOSECONDS_PER_SECOND,
  Timeout: 5 * NANOSECONDS_PER_SECOND,
  StartPeriod: 30 * NANOSECONDS_PER_SECOND,
  Retries: 3,
});
/** cloudflared's entrypoint is `cloudflared --no-autoupdate`; these replace its default `version` command. */
export const CLOUDFLARED_ARGS = Object.freeze(['tunnel', 'run']);

/** Environment keys whose values are not secret and may be shown in a dry run. */
export const PUBLIC_ENV_KEYS = Object.freeze(new Set([
  'NODE_ENV', 'HOST', 'PORT', 'DATA_DIR', 'CACHE_PATH', 'PUBLIC_ORIGIN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD',
  'APP_OPERATOR_EMAILS', 'APP_VIEWER_EMAILS',
  'SHUTDOWN_WAIT_SECONDS', 'CONTENT_SCAN_RETENTION_DAYS', 'RUN_HISTORY_RETENTION_DAYS', 'NEWS_BUILD_VERSION',
]));

export const COMMANDS = Object.freeze(['preflight', 'deploy', 'verify']);

const DEPLOY_VARIABLES = Object.freeze([
  'DOKPLOY_URL', 'DOKPLOY_API_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID',
  'APP_HOSTNAME', 'APP_OPERATOR_EMAILS', 'CF_ACCESS_CLIENT_ID',
]);
const VERIFY_VARIABLES = Object.freeze([
  'DOKPLOY_URL', 'DOKPLOY_API_KEY', 'APP_HOSTNAME', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
]);
/** Flags each command accepts (besides --help). */
const COMMAND_FLAGS = Object.freeze({
  preflight: Object.freeze([]),
  deploy: Object.freeze(['dry-run', 'git-url', 'git-branch', 'cloudflared-image', 'wait-minutes']),
  verify: Object.freeze(['redeploy-check', 'origin-ip', 'wait-minutes']),
});

const MAX_EMAILS = 200;
const MAX_EMAIL_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
// Characters that would change the meaning of an unquoted dotenv value.
const DOTENV_UNSAFE = /[\s#"'`\\]/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/i;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GIT_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const IMAGE_REFERENCE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(@sha256:[a-f0-9]{64})?$/;

/**
 * @typedef {object} DeployConfig
 * @property {'preflight'|'deploy'|'verify'} command
 * @property {boolean} dryRun
 * @property {boolean} redeployCheck
 * @property {{ url: string, apiKey: string }} dokploy `apiKey` is non-enumerable.
 * @property {{ apiToken: string, accountId: string, zoneId: string }} cloudflare `apiToken` is non-enumerable.
 * @property {string} hostname Lowercase FQDN served through the tunnel.
 * @property {string[]} operatorEmails Lowercase, unique.
 * @property {string[]} viewerEmails Lowercase, unique.
 * @property {{ clientId: string, clientSecret: string }} serviceToken `clientSecret` is non-enumerable.
 * @property {{ url: string, branch: string }} git
 * @property {string} cloudflaredImage Pinned image reference.
 * @property {number} waitMs How long to wait for one Dokploy build/deployment.
 * @property {string|null} originIp `--origin-ip` override for the origin probe.
 */

/**
 * Validate the environment and flags for one command.
 * @param {Record<string, string|undefined>} env
 * @param {{ command: string, flags: Record<string, string|boolean|undefined> }} cli
 * @returns {{ config: DeployConfig|null, problems: string[], warnings: string[] }}
 */
export function readDeployConfig(env, { command, flags = {} }) {
  const problems = [];
  const warnings = [];
  if (!COMMANDS.includes(command)) {
    return { config: null, problems: [`Unknown command; use one of: ${COMMANDS.join(', ')}.`], warnings };
  }
  for (const flag of Object.keys(flags)) {
    if (flags[flag] !== undefined && flag !== 'help' && !COMMAND_FLAGS[command].includes(flag)) {
      problems.push(`--${flag} is not an option of the ${command} command.`);
    }
  }

  const read = name => {
    const value = env?.[name];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  const required = command === 'verify' ? VERIFY_VARIABLES : DEPLOY_VARIABLES;
  const missing = required.filter(name => read(name) === '');
  if (missing.length > 0) problems.push(`Missing environment variables: ${missing.join(', ')}.`);
  if (command !== 'verify' && read('CF_ACCESS_CLIENT_SECRET') === '') {
    warnings.push('CF_ACCESS_CLIENT_SECRET is not set: the deploy does not need it, but the verify command does.');
  }

  const dokployUrl = read('DOKPLOY_URL') ? readDokployUrl(read('DOKPLOY_URL'), problems) : null;
  if (dokployUrl?.startsWith('http://') && !isLoopbackUrl(dokployUrl)) {
    warnings.push('DOKPLOY_URL uses plain http: the Dokploy API key travels unencrypted; prefer an https URL.');
  }
  const dokployApiKey = readHeaderSecret(read('DOKPLOY_API_KEY'), 'DOKPLOY_API_KEY', problems);
  const cfApiToken = readHeaderSecret(read('CF_API_TOKEN'), 'CF_API_TOKEN', problems);
  const clientSecret = readHeaderSecret(read('CF_ACCESS_CLIENT_SECRET'), 'CF_ACCESS_CLIENT_SECRET', problems);
  const accountId = readCloudflareId(read('CF_ACCOUNT_ID'), 'CF_ACCOUNT_ID', problems);
  const zoneId = readCloudflareId(read('CF_ZONE_ID'), 'CF_ZONE_ID', problems);
  const hostname = read('APP_HOSTNAME') ? readHostname(read('APP_HOSTNAME'), problems) : '';
  const operatorEmails = readEmails(read('APP_OPERATOR_EMAILS'), 'APP_OPERATOR_EMAILS', problems);
  const viewerEmails = readEmails(read('APP_VIEWER_EMAILS'), 'APP_VIEWER_EMAILS', problems);
  const clientId = read('CF_ACCESS_CLIENT_ID');
  if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
    problems.push('CF_ACCESS_CLIENT_ID must be a service token client ID (letters, digits, ".", "_" and "-", at most 200 characters).');
  }
  if (command !== 'verify' && read('APP_OPERATOR_EMAILS') && operatorEmails.length === 0 && !problems.some(p => p.startsWith('APP_OPERATOR_EMAILS'))) {
    problems.push('APP_OPERATOR_EMAILS must list at least one email address.');
  }

  const gitUrl = readGitUrl(stringFlag(flags['git-url']) ?? DEFAULTS.gitUrl, problems);
  const gitBranch = stringFlag(flags['git-branch']) ?? DEFAULTS.gitBranch;
  if (!GIT_BRANCH.test(gitBranch) || gitBranch.includes('..') || gitBranch.startsWith('/') || gitBranch.endsWith('/')) {
    problems.push('--git-branch must be a branch name such as feat/dokploy-dashboard or master.');
  }
  const cloudflaredImage = stringFlag(flags['cloudflared-image']) ?? DEFAULTS.cloudflaredImage;
  const imageMatch = IMAGE_REFERENCE.exec(cloudflaredImage);
  if (!imageMatch || (!imageMatch[2] && (!imageMatch[1] || imageMatch[1] === 'latest'))) {
    problems.push('--cloudflared-image must be a pinned image reference with a version tag (not latest) or a sha256 digest, for example cloudflare/cloudflared:2026.9.3.');
  }
  const waitMinutes = readWaitMinutes(stringFlag(flags['wait-minutes']), problems);
  const originIp = stringFlag(flags['origin-ip']) ?? null;
  if (originIp !== null && isIP(originIp) === 0) problems.push('--origin-ip must be an IPv4 or IPv6 address.');

  if (problems.length > 0) return { config: null, problems, warnings };

  const config = {
    command,
    dryRun: flags['dry-run'] === true,
    redeployCheck: flags['redeploy-check'] === true,
    dokploy: { url: dokployUrl },
    cloudflare: { accountId, zoneId },
    hostname,
    operatorEmails,
    viewerEmails,
    serviceToken: { clientId },
    git: { url: gitUrl, branch: gitBranch },
    cloudflaredImage,
    waitMs: waitMinutes * 60_000,
    originIp,
  };
  Object.defineProperty(config.dokploy, 'apiKey', { value: dokployApiKey, enumerable: false });
  Object.defineProperty(config.cloudflare, 'apiToken', { value: cfApiToken, enumerable: false });
  Object.defineProperty(config.serviceToken, 'clientSecret', { value: clientSecret, enumerable: false });
  return { config, problems, warnings };
}

/**
 * Environment the app container runs with (see `src/app/config/env.js`).
 * Every key here is owned by the deploy script; other keys already set on the
 * Dokploy application are kept.
 * @param {{
 *   masterKey: string, authDomain: string, aud: string, operatorEmails: string[],
 *   viewerEmails: string[], serviceClientId: string, hostname: string,
 * }} values
 * @returns {Record<string, string>}
 */
export function managedAppEnv({ masterKey, authDomain, aud, operatorEmails, viewerEmails, serviceClientId, hostname }) {
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(APP_PORT),
    DATA_DIR: DATA_MOUNT_PATH,
    CACHE_PATH: `${DATA_MOUNT_PATH}/news.json`,
    APP_MASTER_KEY: masterKey,
    ACCESS_TEAM_DOMAIN: `https://${authDomain}`,
    ACCESS_AUD: aud,
    APP_OPERATOR_EMAILS: operatorEmails.join(','),
    APP_VIEWER_EMAILS: viewerEmails.join(','),
    APP_SERVICE_TOKEN_ROLES: `${serviceClientId}:operator`,
    PUBLIC_ORIGIN: `https://${hostname}`,
    SHUTDOWN_WAIT_SECONDS: String(SHUTDOWN_WAIT_SECONDS),
  };
}

/**
 * Parse a `vMAJOR.MINOR.PATCH[-suffix]` version.
 * @param {unknown} value
 * @returns {number[]|null}
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} Negative, zero, or positive.
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function stringFlag(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function readDokployUrl(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push('DOKPLOY_URL must be the http(s) URL of the Dokploy panel, for example https://dokploy.example.com.');
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    problems.push('DOKPLOY_URL must be an http(s) URL without credentials, query, or fragment.');
    return null;
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -'/api'.length);
  return `${url.origin}${path}`;
}

function isLoopbackUrl(value) {
  const { hostname } = new URL(value);
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

function readHeaderSecret(value, name, problems) {
  if (value && !HEADER_SAFE.test(value)) problems.push(`${name} must contain only visible ASCII characters (no spaces or line breaks).`);
  return value;
}

function readCloudflareId(value, name, problems) {
  if (value && !CLOUDFLARE_ID.test(value)) problems.push(`${name} must be a 32-character hexadecimal Cloudflare ID.`);
  return value.toLowerCase();
}

function readHostname(value, problems) {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || !labels.every(label => HOSTNAME_LABEL.test(label)) || /^\d+$/.test(labels.at(-1))) {
    problems.push('APP_HOSTNAME must be a fully qualified hostname such as radar.example.com (no scheme, port, path, or wildcard).');
    return '';
  }
  return hostname;
}

function readEmails(value, name, problems) {
  const entries = [...new Set(value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean))];
  if (entries.length > MAX_EMAILS) {
    problems.push(`${name} accepts at most ${MAX_EMAILS} email addresses.`);
    return [];
  }
  const invalid = entries.findIndex(entry => entry.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(entry) || DOTENV_UNSAFE.test(entry));
  if (invalid !== -1) {
    problems.push(`${name} entry #${invalid + 1} is not a plain email address; use a comma-separated list such as ops@example.com,lead@example.com.`);
    return [];
  }
  return entries;
}

function readGitUrl(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push('--git-url must be a public https Git URL.');
    return value;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    problems.push('--git-url must be a public https Git URL without credentials, query, or fragment.');
  }
  return url.href;
}

function readWaitMinutes(value, problems) {
  if (value === undefined) return DEFAULTS.waitMinutes;
  const minutes = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) {
    problems.push('--wait-minutes must be a whole number of minutes between 1 and 240.');
    return DEFAULTS.waitMinutes;
  }
  return minutes;
}
