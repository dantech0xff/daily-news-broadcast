#!/usr/bin/env node
/**
 * Deploy Content Radar to Dokploy behind Cloudflare Tunnel + Access, using
 * the Dokploy and Cloudflare APIs only.
 *
 *   npm run deploy:preflight                      read-only checks; exit 1 on any blocker
 *   npm run deploy:dokploy                        preflight, then the idempotent deploy
 *   npm run deploy:dokploy -- --dry-run           the ordered list of changes; read-only calls only
 *   npm run deploy:verify [-- --redeploy-check]   acceptance checks of the live deployment
 *
 * Settings come from the shell or `.env`. Secret values (API keys, the
 * service token secret, the app master key, the tunnel token) are never
 * printed or written to disk: every output line is redacted, and the only
 * file written is `.cache/deploy/state.json` with resource IDs.
 */

import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULTS, readDeployConfig } from './config.mjs';
import { runDeploy } from './deploy.mjs';
import { runPreflight } from './preflight.mjs';
import { Redactor } from './redaction.mjs';
import { DEFAULT_STATE_DIR, createReporter, createRunContext, errorMessage, writeStateFile } from './run-context.mjs';
import { probeOriginHttp, runVerify } from './verify.mjs';

const SECRET_VARIABLES = Object.freeze(['DOKPLOY_API_KEY', 'CF_API_TOKEN', 'CF_ACCESS_CLIENT_SECRET']);

export const USAGE = `Usage: node scripts/deploy/dokploy-cloudflare.mjs <preflight|deploy|verify> [options]

Commands:
  preflight  Read-only checks: Dokploy version and API surface (OpenAPI), Cloudflare
             token, Zero Trust organization, zone, service token, tunnel, DNS.
  deploy     Preflight, then the idempotent deploy in this order: Access -> Dokploy
             app (deployed) -> tunnel ingress + cloudflared -> DNS.
  verify     Checks of the live deployment: Access in front, the service token works,
             the origin is closed.

Options:
  deploy   --dry-run                  List the changes in order; read-only API calls only.
           --git-url <https url>      Default ${DEFAULTS.gitUrl}
           --git-branch <branch>      Default ${DEFAULTS.gitBranch}
           --cloudflared-image <ref>  Default ${DEFAULTS.cloudflaredImage} (must be pinned)
           --wait-minutes <n>         How long to wait for a build (default ${DEFAULTS.waitMinutes}).
  verify   --redeploy-check           Also redeploy the app and confirm the data survives.
           --origin-ip <ip>           Server IP for the origin probe (default: DOKPLOY_URL's host).
           --wait-minutes <n>         How long to wait for the redeploy.
  -h, --help

Environment (shell or .env; values are never printed):
  DOKPLOY_URL, DOKPLOY_API_KEY, CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, APP_HOSTNAME,
  APP_OPERATOR_EMAILS, APP_VIEWER_EMAILS (optional), CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET (verify only).
`;

/**
 * @param {string[]} argv Arguments after the script path.
 * @param {Partial<import('./run-context.mjs').RunDependencies> & {
 *   env?: Record<string, string|undefined>,
 *   stdout?: { write: (text: string) => unknown },
 *   stderr?: { write: (text: string) => unknown },
 * }} [deps] Injectable for tests; production uses the real process, network, and clock.
 * @returns {Promise<number>} Exit code: 0 success, 1 blocked or failed, 2 usage or configuration error.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!cli.command) {
    stderr.write(USAGE);
    return 2;
  }

  const env = deps.env ?? await loadEnvironment();
  const redactor = new Redactor();
  for (const name of SECRET_VARIABLES) redactor.add(typeof env[name] === 'string' ? env[name].trim() : undefined);
  const report = createReporter({ stdout, stderr, redactor });
  const { config, problems, warnings } = readDeployConfig(env, cli);
  for (const warning of warnings) report.warn(warning);
  if (!config) {
    for (const problem of problems) report.blocker(problem);
    return 2;
  }

  const ctx = createRunContext({
    config,
    redactor,
    report,
    deps: {
      fetch: deps.fetch ?? globalThis.fetch,
      sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      now: deps.now ?? (() => Date.now()),
      lookup: deps.lookup ?? (async hostname => (await dnsLookup(hostname)).address),
      probeOrigin: deps.probeOrigin ?? probeOriginHttp,
      randomBytes: deps.randomBytes ?? randomBytes,
      stateDir: deps.stateDir === undefined ? DEFAULT_STATE_DIR : deps.stateDir,
    },
  });
  try {
    if (config.command === 'preflight') return await commandPreflight(ctx);
    if (config.command === 'deploy') return await commandDeploy(ctx);
    return await commandVerify(ctx);
  } catch (error) {
    report.fail(errorMessage(error));
    return 1;
  }
}

async function commandPreflight(ctx) {
  const preflight = await runPreflight(ctx);
  summarizePreflight(ctx, preflight);
  return preflight.blockers.length > 0 ? 1 : 0;
}

async function commandDeploy(ctx) {
  ctx.report.line(ctx.dryRun
    ? `Dry run for ${ctx.config.hostname}: only read-only API calls are made; planned changes are listed in order.`
    : `Deploying ${ctx.config.hostname} (branch ${ctx.config.git.branch}).`);
  const preflight = await runPreflight(ctx);
  summarizePreflight(ctx, preflight);
  if (preflight.blockers.length > 0) {
    ctx.report.fail('The deploy did not start: resolve the blockers above, then re-run.');
    return 1;
  }
  try {
    const outcome = await runDeploy(ctx, preflight.facts);
    ctx.report.section(ctx.dryRun ? 'Dry run result' : 'Deploy result');
    if (ctx.dryRun) {
      ctx.report.line(`${ctx.planner.calls.length} change(s) planned; nothing was sent.`);
    } else {
      ctx.report.line(`Done: https://${ctx.config.hostname} → tunnel ${outcome.tunnelId} → ${outcome.appName}:3000 (every channel stays paused).`);
      ctx.report.line('Next: npm run deploy:verify');
    }
    return 0;
  } catch (error) {
    ctx.report.fail(`The deploy stopped: ${errorMessage(error)}`);
    return 1;
  } finally {
    try {
      const file = await writeStateFile(ctx);
      if (file) ctx.report.info(`Resource IDs (no secrets) saved to ${relative(process.cwd(), file)}.`);
    } catch (error) {
      ctx.report.warn(`Could not write the state cache: ${errorMessage(error)}`);
    }
  }
}

async function commandVerify(ctx) {
  const { failed } = await runVerify(ctx);
  return failed > 0 ? 1 : 0;
}

function summarizePreflight(ctx, { blockers, warnings }) {
  ctx.report.section('Preflight result');
  if (blockers.length === 0) {
    ctx.report.line(`No blockers (${warnings.length} warning${warnings.length === 1 ? '' : 's'}).`);
    return;
  }
  ctx.report.line(`${blockers.length} blocker${blockers.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
  for (const blocker of blockers) ctx.report.line(`  - ${blocker}`);
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'dry-run': { type: 'boolean' },
      'redeploy-check': { type: 'boolean' },
      'git-url': { type: 'string' },
      'git-branch': { type: 'string' },
      'cloudflared-image': { type: 'string' },
      'origin-ip': { type: 'string' },
      'wait-minutes': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  // Extra arguments are not echoed: a secret pasted by mistake must not be printed.
  if (positionals.length > 1) throw new Error(`Expected one command, got ${positionals.length} arguments.`);
  const { help, ...flags } = values;
  return { command: positionals[0], help: help === true, flags };
}

async function loadEnvironment() {
  try {
    const { config } = await import('dotenv');
    config({ quiet: true });
  } catch {
    // dotenv is optional; the shell environment is used as is.
  }
  return process.env;
}

const isExecutable = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutable) {
  process.exitCode = await main(process.argv.slice(2));
}
