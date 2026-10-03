/**
 * Configuration of the cutover script (`cutover.mjs`): the channel it moves,
 * its commands and flags, the environment each command needs, and the
 * deterministic idempotency keys of its operator actions.
 *
 * Problems name variables and rules only, never values: secrets reach the
 * script through the environment and must never be echoed. Secret settings
 * are non-enumerable on the returned config so serializing it cannot leak
 * them.
 */

/** The channel moved from the Worker to the app. */
export const CHANNEL_ID = 'telegram-main';
/** The production Worker (docs/deployment.md). */
export const DEFAULT_WORKER_URL = 'https://news-engine.dan-tran.workers.dev';
/** Audit reasons of the operator actions (both runtimes accept at most 500 characters). */
export const REASONS = Object.freeze({
  cutover: 'Cutover to Dokploy',
  rollback: 'Rollback of the Dokploy cutover',
});

export const COMMANDS = Object.freeze(['status', 'preview', 'pause-worker', 'activate', 'check-first-post', 'rollback']);

/** Environment variables holding secrets: registered with the redactor, never printed. */
export const SECRET_VARIABLES = Object.freeze(['TRIGGER_SECRET', 'OPERATOR_SECRET', 'CF_ACCESS_CLIENT_SECRET']);

/** Flags each command accepts (besides --help); the commands that change state take `--confirm`. */
const COMMAND_FLAGS = Object.freeze({
  status: Object.freeze([]),
  preview: Object.freeze([]),
  'pause-worker': Object.freeze(['confirm']),
  activate: Object.freeze(['confirm', 'reset-not-before', 'run-now']),
  'check-first-post': Object.freeze([]),
  rollback: Object.freeze(['confirm', 'resume-worker']),
});

const APP_VARIABLES = Object.freeze(['APP_HOSTNAME', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']);
const KEY_PREFIXES = Object.freeze({
  workerPause: 'cutover-pause',
  appResume: 'cutover-resume',
  appPause: 'cutover-rollback-pause',
  workerResume: 'cutover-rollback-resume',
});
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * @typedef {object} CutoverConfig
 * @property {string} command One of `COMMANDS`.
 * @property {boolean} confirm Apply the plan of a command that changes state.
 * @property {boolean} resetNotBefore `activate`: replace an existing `notBefore`.
 * @property {boolean} runNow `activate`: trigger one manual run afterwards.
 * @property {boolean} resumeWorker `rollback`: also resume the Worker channel.
 * @property {{ url: string, triggerSecret: string, operatorSecret: string|null }|null} worker
 *   Set when the command talks to the Worker; the secrets are non-enumerable.
 * @property {{ hostname: string, origin: string, clientId: string, clientSecret: string }|null} app
 *   Set when the command talks to the app; `clientSecret` is non-enumerable.
 */

/**
 * Validate the environment and flags of one command.
 * @param {Record<string, string|undefined>} env
 * @param {{ command?: string, flags?: Record<string, boolean|undefined> }} cli
 * @returns {{ config: CutoverConfig|null, problems: string[] }}
 */
export function readCutoverConfig(env, { command, flags = {} }) {
  const problems = [];
  if (typeof command !== 'string' || !COMMANDS.includes(command)) {
    return { config: null, problems: [`Unknown command; use one of: ${COMMANDS.join(', ')}.`] };
  }
  for (const [flag, value] of Object.entries(flags)) {
    if (value !== undefined && !COMMAND_FLAGS[command].includes(flag)) {
      problems.push(`--${flag} is not an option of the ${command} command.`);
    }
  }

  const read = name => {
    const value = env?.[name];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  const resumeWorker = command === 'rollback' && flags['resume-worker'] === true;
  const need = {
    worker: ['status', 'pause-worker', 'activate', 'check-first-post'].includes(command) || resumeWorker,
    workerControl: command === 'pause-worker' || resumeWorker,
    app: command !== 'pause-worker',
  };
  const required = [
    ...(need.worker ? ['TRIGGER_SECRET'] : []),
    ...(need.workerControl ? ['OPERATOR_SECRET'] : []),
    ...(need.app ? APP_VARIABLES : []),
  ];
  const missing = required.filter(name => read(name) === '');
  if (missing.length > 0) problems.push(`Missing environment variables: ${missing.join(', ')}.`);
  for (const name of SECRET_VARIABLES) {
    if (required.includes(name) && read(name) !== '' && !HEADER_SAFE.test(read(name))) {
      problems.push(`${name} must contain only visible ASCII characters (no spaces or line breaks).`);
    }
  }
  if (need.workerControl && read('TRIGGER_SECRET') !== '' && read('TRIGGER_SECRET') === read('OPERATOR_SECRET')) {
    problems.push('TRIGGER_SECRET and OPERATOR_SECRET must be different values (the Worker refuses identical secrets).');
  }
  const workerUrl = need.worker ? readWorkerUrl(read('WORKER_URL') || DEFAULT_WORKER_URL, problems) : null;
  const hostname = need.app && read('APP_HOSTNAME') !== '' ? readHostname(read('APP_HOSTNAME'), problems) : '';
  const clientId = read('CF_ACCESS_CLIENT_ID');
  if (need.app && clientId !== '' && !CLIENT_ID_PATTERN.test(clientId)) {
    problems.push('CF_ACCESS_CLIENT_ID must be a service token client ID (letters, digits, ".", "_" and "-", at most 200 characters).');
  }
  if (problems.length > 0) return { config: null, problems };

  /** @type {CutoverConfig} */
  const config = {
    command,
    confirm: flags.confirm === true,
    resetNotBefore: flags['reset-not-before'] === true,
    runNow: flags['run-now'] === true,
    resumeWorker,
    worker: null,
    app: null,
  };
  if (need.worker) {
    const worker = { url: workerUrl };
    Object.defineProperty(worker, 'triggerSecret', { value: read('TRIGGER_SECRET'), enumerable: false });
    Object.defineProperty(worker, 'operatorSecret', { value: need.workerControl ? read('OPERATOR_SECRET') : null, enumerable: false });
    config.worker = /** @type {CutoverConfig['worker']} */ (worker);
  }
  if (need.app) {
    const app = { hostname, origin: `https://${hostname}`, clientId };
    Object.defineProperty(app, 'clientSecret', { value: read('CF_ACCESS_CLIENT_SECRET'), enumerable: false });
    config.app = /** @type {CutoverConfig['app']} */ (app);
  }
  return { config, problems };
}

/**
 * Deterministic idempotency key of a cutover operator action. The same action
 * on the same UTC day (and, when given, the same delivery-state version)
 * always sends the same key, so a repeated request replays the first result
 * instead of acting twice; a changed version gets a fresh key.
 * @param {keyof typeof KEY_PREFIXES} kind `workerPause`, `appResume`, `appPause`, or `workerResume`.
 * @param {number} epochMs The command's start time.
 * @param {number} [version] Expected delivery-state version.
 * @returns {string} For example `cutover-pause-telegram-main-20261003` or `cutover-resume-telegram-main-20261003-v7`.
 */
export function idempotencyKey(kind, epochMs, version) {
  if (!Object.hasOwn(KEY_PREFIXES, kind)) throw new TypeError(`Unknown idempotency key kind: ${String(kind)}`);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
    throw new TypeError('An idempotency key version must be a positive integer');
  }
  const day = new Date(epochMs).toISOString().slice(0, 10).replaceAll('-', '');
  const base = `${KEY_PREFIXES[kind]}-${CHANNEL_ID}-${day}`;
  return version === undefined ? base : `${base}-v${version}`;
}

function readWorkerUrl(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push(`WORKER_URL must be the https URL of the Worker, for example ${DEFAULT_WORKER_URL}.`);
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    problems.push('WORKER_URL must be an https URL (plain http only for localhost) without credentials, query, or fragment.');
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// Same rule as APP_HOSTNAME in the deploy script (config.mjs).
function readHostname(value, problems) {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || !labels.every(label => HOSTNAME_LABEL.test(label)) || /^\d+$/.test(labels.at(-1))) {
    problems.push('APP_HOSTNAME must be a fully qualified hostname such as radar.example.com (no scheme, port, path, or wildcard).');
    return '';
  }
  return hostname;
}
