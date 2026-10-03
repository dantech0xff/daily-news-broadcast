/**
 * Run context shared by the commands: redacted output, the API clients, the
 * dry-run planner, the injectable seams (fetch, clock, sleep, origin probe,
 * random bytes), and the non-secret state cache.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareClient, createDokployClient, createPlanner } from './api-clients.mjs';

/** Default location of the state cache: `.cache/deploy/` (gitignored). */
export const DEFAULT_STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'deploy');
export const STATE_FILE = 'state.json';

/** An expected stop: the message tells the operator what to do. It never contains secrets. */
export class DeployStop extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DeployStop';
  }
}

/**
 * Line-oriented output; every line passes through the redactor.
 * @param {{ stdout: { write: (text: string) => unknown }, stderr: { write: (text: string) => unknown }, redactor: import('./redaction.mjs').Redactor }} options
 */
export function createReporter({ stdout, stderr, redactor }) {
  const write = (stream, text) => stream.write(`${redactor.redact(text)}\n`);
  return {
    /** @param {string} text */
    line: text => write(stdout, text),
    /** @param {string} title */
    section: title => write(stdout, `\n== ${title} ==`),
    /** @param {string} text */
    ok: text => write(stdout, `[ok] ${text}`),
    /** @param {string} text */
    info: text => write(stdout, `[info] ${text}`),
    /** @param {string} action @param {string} text */
    change: (action, text) => write(stdout, `[${action}] ${text}`),
    /** @param {string} text */
    plan: text => write(stdout, `    ${text}`),
    /** @param {string} text */
    warn: text => write(stderr, `[warn] ${text}`),
    /** @param {string} text */
    blocker: text => write(stderr, `[blocker] ${text}`),
    /** @param {string} text */
    fail: text => write(stderr, `[fail] ${text}`),
    /** @param {string} text */
    log: text => write(stderr, `    | ${text}`),
  };
}

/**
 * @typedef {object} RunDependencies
 * @property {typeof fetch} fetch
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now Epoch milliseconds.
 * @property {(options: { address: string, port: number, hostname: string, path: string, timeoutMs: number })
 *   => Promise<import('./verify.mjs').OriginProbeResult>} probeOrigin HTTPS request to the origin address with
 *   SNI and Host `hostname` (`probeOriginHttps`).
 * @property {(size: number) => Buffer} [randomBytes]
 * @property {string|null} stateDir `null` disables the state cache.
 */

/**
 * @param {{
 *   config: import('./config.mjs').DeployConfig,
 *   deps: RunDependencies,
 *   redactor: import('./redaction.mjs').Redactor,
 *   report: ReturnType<typeof createReporter>,
 * }} options
 */
export function createRunContext({ config, deps, redactor, report }) {
  const planner = createPlanner({ dryRun: config.dryRun, report });
  const dokploy = createDokployClient({
    baseUrl: config.dokploy.url,
    apiKey: config.dokploy.apiKey,
    // Only a panel behind Cloudflare Access gets the service token; otherwise
    // its secret goes to the app alone.
    accessServiceToken: config.dokploy.behindAccess ? config.serviceToken : undefined,
    fetch: deps.fetch,
    planner,
    redactor,
  });
  const cloudflare = config.cloudflare.apiToken
    ? createCloudflareClient({ apiToken: config.cloudflare.apiToken, fetch: deps.fetch, planner, redactor })
    : null;
  return {
    config,
    report,
    redactor,
    planner,
    dryRun: config.dryRun,
    dokploy,
    cloudflare,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    probeOrigin: deps.probeOrigin,
    randomBytes: deps.randomBytes,
    stateDir: deps.stateDir,
    /** @type {import('./dokploy-contract.mjs').DokployContract|null} Set by preflight. */
    contract: null,
    /** Non-secret IDs collected for the state cache. */
    state: {},
    /**
     * Announce a change; in a dry run it is marked as planned.
     * @param {string} action
     * @param {string} text
     */
    change(action, text) {
      report.change(config.dryRun ? `plan ${action}` : action, text);
    },
  };
}

/**
 * Text of any error, safe to print (the reporter redacts it again).
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Write the non-secret state cache (resource IDs) for the operator's records.
 * Refuses to write anything that contains a registered secret.
 * @param {ReturnType<typeof createRunContext>} ctx
 * @returns {Promise<string|null>} The file written, or `null`.
 */
export async function writeStateFile(ctx) {
  if (!ctx.stateDir || ctx.dryRun || Object.keys(ctx.state).length === 0) return null;
  const text = `${JSON.stringify({ ...ctx.state, updatedAt: new Date(ctx.now()).toISOString() }, null, 2)}\n`;
  if (ctx.redactor.containsSecret(text)) {
    ctx.report.warn('The state cache was not written because it would contain a secret value.');
    return null;
  }
  await mkdir(ctx.stateDir, { recursive: true, mode: 0o700 });
  const file = join(ctx.stateDir, STATE_FILE);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
