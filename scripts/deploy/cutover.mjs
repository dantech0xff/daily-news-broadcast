#!/usr/bin/env node
/**
 * Cutover of `telegram-main` from the Cloudflare Worker to the Dokploy app
 * (docs/deployment.md, "Cutover Runbook" and "Rollback Runbook").
 *
 *   npm run cutover:status                       read-only: Worker channel, app channel, app health
 *   npm run cutover:preview                      A4: read-only preview while nothing is delivered
 *   npm run cutover:pause-worker -- --confirm    pause the Worker channel, then require paused=true
 *   npm run cutover:activate -- --confirm        Worker paused → notBefore = now → resume the app channel
 *   npm run cutover:check                        A5 one-shot check: exit 0 done, 2 not yet, 1 violation
 *   npm run cutover:rollback -- --confirm        pause the app channel (--resume-worker: then the Worker)
 *
 * The Worker and the app are never both active on the chat: the app channel
 * is resumed only after the Worker reports it paused, and a rollback pauses
 * the app before it touches the Worker. Commands that change state print
 * their plan and act only with --confirm. Secrets come from the shell or
 * `.env` and are never printed: every output line passes through the
 * redactor.
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createAppClient, createWorkerClient } from './cutover-clients.mjs';
import { CHANNEL_ID, DEFAULT_WORKER_URL, SECRET_VARIABLES, readCutoverConfig } from './cutover-config.mjs';
import { COMMAND_HANDLERS, EXIT } from './cutover-steps.mjs';
import { Redactor } from './redaction.mjs';
import { createReporter, errorMessage } from './run-context.mjs';

export const USAGE = `Usage: node scripts/deploy/cutover.mjs <command> [options]

Moves ${CHANNEL_ID} from the Cloudflare Worker to the Dokploy app. The Worker
and the app are never both active on the chat.

Commands:
  status            Read-only: the Worker channel, the app channel, and app health.
  preview           A4, read-only: the app's preview must return generated content
                    while nothing is delivered and the channel stays paused.
  pause-worker      Pause ${CHANNEL_ID} on the Worker, then require paused=true.
  activate          Only while the Worker reports paused: set notBefore to now on the
                    app channel, resume it, and verify.
  check-first-post  A5, read-only and one-shot (poll it about hourly): exit 0 once a post
                    is delivered with a message ID and none was published before
                    notBefore; 2 while nothing is delivered yet (up to 24 h after
                    notBefore); 1 on any violation.
  rollback          Pause ${CHANNEL_ID} on the app; --resume-worker then asks the
                    Worker to resume (refused while it runs in bootstrap mode).

Commands that change state print their plan first and act only with --confirm.

Options:
  --confirm            Apply the plan (pause-worker, activate, rollback).
  --reset-not-before   activate: move an existing notBefore to now.
  --run-now            activate: trigger one manual run once the channel is active.
  --resume-worker      rollback: also resume the Worker channel.
  -h, --help

Environment (shell or .env; values are never printed):
  WORKER_URL (default ${DEFAULT_WORKER_URL}), TRIGGER_SECRET,
  OPERATOR_SECRET (pause-worker, rollback --resume-worker), APP_HOSTNAME,
  CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET (every command except pause-worker).

Exit codes: 0 done; 1 failed, refused, or invalid usage; 2 (check-first-post) nothing delivered yet.
`;

/**
 * @param {string[]} argv Arguments after the script path.
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   stdout?: { write: (text: string) => unknown },
 *   stderr?: { write: (text: string) => unknown },
 * }} [deps] Injectable for tests; production uses the real process, network, and clock.
 * @returns {Promise<number>} See `EXIT`.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    return EXIT.failed;
  }
  if (cli.help) {
    stdout.write(USAGE);
    return EXIT.ok;
  }
  if (!cli.command) {
    stderr.write(USAGE);
    return EXIT.failed;
  }

  const env = deps.env ?? await loadEnvironment();
  const redactor = new Redactor();
  for (const name of SECRET_VARIABLES) redactor.add(typeof env[name] === 'string' ? env[name].trim() : undefined);
  const report = createReporter({ stdout, stderr, redactor });
  const { config, problems } = readCutoverConfig(env, cli);
  if (!config) {
    for (const problem of problems) report.blocker(problem);
    return EXIT.failed;
  }

  const fetch = deps.fetch ?? globalThis.fetch;
  /** @type {import('./cutover-steps.mjs').CutoverContext} */
  const ctx = {
    config,
    report,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    worker: config.worker
      ? createWorkerClient({
        url: config.worker.url,
        triggerSecret: config.worker.triggerSecret,
        operatorSecret: config.worker.operatorSecret,
        fetch,
        redactor,
      })
      : null,
    app: config.app
      ? createAppClient({
        hostname: config.app.hostname,
        clientId: config.app.clientId,
        clientSecret: config.app.clientSecret,
        fetch,
        redactor,
      })
      : null,
  };
  try {
    return await COMMAND_HANDLERS[config.command](ctx);
  } catch (error) {
    report.fail(errorMessage(error));
    return EXIT.failed;
  }
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      confirm: { type: 'boolean' },
      'reset-not-before': { type: 'boolean' },
      'run-now': { type: 'boolean' },
      'resume-worker': { type: 'boolean' },
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
