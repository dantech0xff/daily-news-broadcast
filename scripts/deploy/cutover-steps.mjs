/**
 * The cutover commands; `cutover.mjs` is the CLI around them. Each command
 * takes a `CutoverContext` and resolves to an exit code (`EXIT`). Commands
 * that change state print their plan and act only with --confirm.
 *
 * Safety order: the app channel is resumed only after the Worker reports its
 * channel paused, and the Worker is checked again afterwards; a rollback
 * pauses the app channel and verifies it before it touches the Worker. A
 * versioned control reads the state again once after a conflict and retries
 * with a new deterministic idempotency key.
 */

import { APP_PATHS, RequestError, readAppStatus, readChannelRecord, readPage } from './cutover-clients.mjs';
import { CHANNEL_ID, REASONS, idempotencyKey } from './cutover-config.mjs';
import { errorMessage } from './run-context.mjs';

/** Exit codes: `pending` is used by check-first-post only. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, pending: 2 });
/** How long after `notBefore` the first post may take before it is reported instead of awaited (user decision). */
export const FIRST_POST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Characters of generated text the preview prints. */
export const EXCERPT_CHARS = 300;

// A preview fetches every source and calls the AI; Cloudflare itself gives up after about 100 s.
const PREVIEW_TIMEOUT_MS = 5 * 60_000;
const CONFLICT_RETRY_DELAY_MS = 1_000;
const PAGE_SIZE = 100;
const MAX_DELIVERED_PAGES = 50;
const MAX_REJECTED_PAGES = 10;
const MAX_LISTED_PROBLEMS = 10;
const REJECT_REASONS = Object.freeze(['before_cutoff', 'not_tech', 'low_score', 'duplicate']);
const SELECTION_KEYS = Object.freeze(['fetched', 'fresh', 'uncovered', 'relevant', 'ranked', 'enqueued']);
const WORKER_COUNT_KEYS = Object.freeze(['ambiguousOutputs', 'unresolvedTargets', 'activeDeliveries', 'maintenanceDeadLetters', 'requests']);

/**
 * @typedef {object} CutoverContext
 * @property {import('./cutover-config.mjs').CutoverConfig} config
 * @property {ReturnType<typeof import('./run-context.mjs').createReporter>} report
 * @property {ReturnType<typeof import('./cutover-clients.mjs').createWorkerClient>|null} worker
 * @property {ReturnType<typeof import('./cutover-clients.mjs').createAppClient>|null} app
 * @property {() => number} now Epoch milliseconds.
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * Read-only overview of both runtimes. Fails when a read fails or when both
 * channels are unpaused.
 * @param {CutoverContext} ctx
 */
async function commandStatus(ctx) {
  let failures = 0;
  const attempt = async read => {
    try {
      return await read();
    } catch (error) {
      failures += 1;
      ctx.report.fail(errorMessage(error));
      return null;
    }
  };

  ctx.report.section(`Worker (${ctx.worker.url})`);
  const worker = await attempt(() => ctx.worker.status());
  if (worker) describeWorker(ctx, worker);

  ctx.report.section(`App (${ctx.app.origin})`);
  const health = await attempt(() => ctx.app.get(APP_PATHS.health));
  if (health) describeHealth(ctx, health);
  const status = await attempt(async () => readAppStatus(await ctx.app.get(APP_PATHS.status)));
  if (status) describeAppStatus(ctx, status);

  ctx.report.section('Assessment');
  if (!worker || !status) {
    ctx.report.fail('Incomplete: a read failed (see above).');
    return EXIT.failed;
  }
  if (worker.paused === false && status.paused === false) {
    ctx.report.fail(`Both the Worker and the app report ${CHANNEL_ID} unpaused: both could post to the chat. Pause the app now: npm run cutover:rollback -- --confirm`);
    return EXIT.failed;
  }
  ctx.report.info(describeStage(worker, status));
  return failures > 0 ? EXIT.failed : EXIT.ok;
}

/**
 * A4: the preview returns generated content, and nothing is delivered while it runs.
 * @param {CutoverContext} ctx
 */
async function commandPreview(ctx) {
  ctx.report.section('Before');
  const before = await readSnapshot(ctx);
  describeSnapshot(ctx, before);
  if (before.status.paused !== true) {
    ctx.report.fail(`${CHANNEL_ID} is not paused on the app (paused=${before.status.paused}): the A4 preview check belongs before the cutover, while nothing can be delivered.`);
    return EXIT.failed;
  }

  ctx.report.section('Preview');
  ctx.report.info(`POST ${ctx.app.origin}${APP_PATHS.preview}: read-only (fetches the sources and calls the AI, sends nothing). This can take a few minutes.`);
  const preview = await ctx.app.post(APP_PATHS.preview, {}, { timeoutMs: PREVIEW_TIMEOUT_MS });
  const texts = generatedTexts(preview);
  describePreview(ctx, preview, texts);

  ctx.report.section('After');
  const after = await readSnapshot(ctx);
  describeSnapshot(ctx, after);

  ctx.report.section('A4 checks');
  const checks = [
    [texts.length > 0,
      `generated content returned (${texts.length} text${texts.length === 1 ? '' : 's'})`,
      `no generated content (status ${preview?.status ?? '?'}${preview?.reason ? `, ${preview.reason}` : ''}; selection ${formatSelection(preview?.stats?.selection)})`],
    [after.delivered === before.delivered,
      `no delivered items appeared (${before.delivered} before, ${after.delivered} after)`,
      `delivered items changed while previewing: ${before.delivered} → ${after.delivered}`],
    [after.status.paused === true, 'the channel is still paused', `the channel is no longer paused (paused=${after.status.paused})`],
    [after.status.version === before.status.version,
      `delivery-state version unchanged (${before.status.version})`,
      `delivery-state version changed: ${before.status.version} → ${after.status.version}`],
  ];
  let failed = 0;
  for (const [passed, okText, failText] of checks) {
    if (passed) ctx.report.ok(okText);
    else {
      failed += 1;
      ctx.report.fail(failText);
    }
  }
  if (after.runs !== before.runs || after.items !== before.items) {
    ctx.report.warn(`runs ${before.runs} → ${after.runs}, library items ${before.items} → ${after.items}: a preview writes neither, so something else ran meanwhile; check the run history.`);
  } else {
    ctx.report.ok(`run history and library unchanged (${after.runs} runs, ${after.items} library items)`);
  }
  ctx.report.line(failed === 0
    ? 'A4 passed: the preview generated content and nothing was delivered.'
    : `A4 failed: ${failed} check${failed === 1 ? '' : 's'} did not pass.`);
  return failed === 0 ? EXIT.ok : EXIT.failed;
}

/**
 * Pause the Worker channel; idempotent. Exits non-zero unless the Worker
 * reports the channel paused afterwards.
 * @param {CutoverContext} ctx
 */
async function commandPauseWorker(ctx) {
  const startedAt = ctx.now();
  ctx.report.section(`Worker (${ctx.worker.url})`);
  const before = await ctx.worker.status();
  describeWorker(ctx, before);
  if (before.paused) {
    ctx.report.ok(`${CHANNEL_ID} is already paused on the Worker (version ${before.version}); nothing to do.`);
    return EXIT.ok;
  }

  const firstKey = idempotencyKey('workerPause', startedAt);
  ctx.report.section('Plan');
  ctx.report.plan(`1. ${ctx.worker.describeControl('pause', { expectedVersion: before.version, idempotencyKey: firstKey, reason: REASONS.cutover })}`);
  ctx.report.plan(`   On a version conflict: read /status again and retry once with the new version and Idempotency-Key ${firstKey}-v<version>.`);
  ctx.report.plan(`2. GET ${ctx.worker.url}/status again and require paused=true.`);
  if (!confirmed(ctx)) return EXIT.failed;

  ctx.report.section('Pause');
  try {
    await sendVersionedControl(ctx, {
      label: 'Worker pause',
      version: before.version,
      firstKey,
      keyFor: version => idempotencyKey('workerPause', startedAt, version),
      send: ({ expectedVersion, idempotencyKey: key }) => ctx.worker.control('pause', { expectedVersion, idempotencyKey: key, reason: REASONS.cutover }),
      reread: () => ctx.worker.status(),
      isApplied: view => view.paused === true,
      isConflict: error => isConflict(error, 'request_conflict'),
    });
  } catch (error) {
    ctx.report.fail(`${errorMessage(error)}. The command is idempotent: run it again to see the Worker's state.`);
    return EXIT.failed;
  }
  const after = await ctx.worker.status();
  if (after.paused !== true) {
    ctx.report.fail(`STOP: the Worker still reports ${CHANNEL_ID} paused=${after.paused} (version ${after.version}). Do not activate the app; investigate the Worker first.`);
    return EXIT.failed;
  }
  ctx.report.ok(`${CHANNEL_ID} is paused on the Worker (version ${after.version}, runtimeMode ${after.runtimeMode}). Record this version in docs/deployment.md.`);
  ctx.report.line('Next: npm run cutover:activate -- --confirm');
  return EXIT.ok;
}

/**
 * Worker paused → `notBefore` = now → resume the app channel → verify.
 * @param {CutoverContext} ctx
 */
async function commandActivate(ctx) {
  const startedAt = ctx.now();
  ctx.report.section(`Worker (${ctx.worker.url})`);
  const worker = await ctx.worker.status();
  describeWorker(ctx, worker);
  if (worker.paused !== true) {
    ctx.report.fail(`Refused: the Worker reports ${CHANNEL_ID} paused=false, so the app must not be resumed. Pause the Worker first: npm run cutover:pause-worker -- --confirm`);
    return EXIT.failed;
  }
  ctx.report.ok(`the Worker channel is paused (version ${worker.version})`);

  ctx.report.section(`App (${ctx.app.origin})`);
  const status = readAppStatus(await ctx.app.get(APP_PATHS.status));
  const record = readChannelRecord(await ctx.app.get(APP_PATHS.channel));
  describeAppStatus(ctx, status);
  if (!status.enabled) ctx.report.warn(`${CHANNEL_ID} is disabled on the app: it does not run on schedule until it is enabled in the dashboard.`);

  if (status.paused === false) {
    if (!status.notBefore) {
      ctx.report.fail(`Refused: ${CHANNEL_ID} is already unpaused on the app without a notBefore. Pause it (npm run cutover:rollback -- --confirm) and investigate.`);
      return EXIT.failed;
    }
    ctx.report.ok(`${CHANNEL_ID} is already active on the app (notBefore ${status.notBefore}); nothing to resume.`);
    if (!ctx.config.runNow) return EXIT.ok;
    ctx.report.section('Plan');
    ctx.report.plan(`1. ${ctx.app.describe('POST', APP_PATHS.run, {})}`);
    if (!confirmed(ctx)) return EXIT.failed;
    return triggerRun(ctx);
  }
  if (status.paused !== true || status.version === null) {
    ctx.report.fail(`Refused: the app reports no delivery state for ${CHANNEL_ID} (paused=${status.paused}).`);
    return EXIT.failed;
  }

  const keepNotBefore = record.notBefore !== null && !ctx.config.resetNotBefore;
  const notBefore = keepNotBefore ? record.notBefore : new Date(startedAt).toISOString();
  if (keepNotBefore && worker.updatedAt && Date.parse(record.notBefore) < Date.parse(worker.updatedAt)) {
    ctx.report.warn(`The existing notBefore ${record.notBefore} is earlier than the Worker channel's last change (${worker.updatedAt}): articles published in between could repeat posts the Worker made. --reset-not-before moves it to now.`);
  }
  const resume = { idempotencyKey: idempotencyKey('appResume', startedAt, status.version), expectedVersion: status.version, reason: REASONS.cutover };

  ctx.report.section('Plan');
  let step = 0;
  ctx.report.plan(keepNotBefore
    ? `${++step}. Keep notBefore ${record.notBefore} (--reset-not-before moves it to now).`
    : `${++step}. ${ctx.app.describe('PUT', APP_PATHS.channel, { version: record.version, notBefore })}`);
  ctx.report.plan(`${++step}. ${ctx.app.describe('POST', APP_PATHS.control('resume'), resume)}`);
  ctx.report.plan(`   expectedVersion is the delivery-state version from GET ${APP_PATHS.status}, read again first; on a version conflict it is read again and retried once with a new key.`);
  ctx.report.plan(`${++step}. Require paused=false and notBefore on the app, and paused=true on the Worker.`);
  if (ctx.config.runNow) ctx.report.plan(`${++step}. ${ctx.app.describe('POST', APP_PATHS.run, {})}`);
  if (!confirmed(ctx)) return EXIT.failed;

  ctx.report.section('Activate');
  if (!keepNotBefore) {
    const updated = readChannelRecord(await ctx.app.put(APP_PATHS.channel, { version: record.version, notBefore }));
    if (updated.notBefore === null || Date.parse(updated.notBefore) !== Date.parse(notBefore)) {
      ctx.report.fail(`The app did not store notBefore ${notBefore} (it reports ${updated.notBefore ?? 'none'}); nothing was resumed.`);
      return EXIT.failed;
    }
    ctx.report.ok(`notBefore set to ${updated.notBefore} (config version ${updated.version})`);
  }
  const current = readAppStatus(await ctx.app.get(APP_PATHS.status));
  if (current.notBefore === null) {
    ctx.report.fail('The app status shows no notBefore; nothing was resumed.');
    return EXIT.failed;
  }
  if (current.paused !== false) {
    if (current.version === null) {
      ctx.report.fail(`The app reports no delivery state for ${CHANNEL_ID}; nothing was resumed.`);
      return EXIT.failed;
    }
    try {
      await sendVersionedControl(ctx, {
        label: 'App resume',
        version: current.version,
        firstKey: idempotencyKey('appResume', startedAt, current.version),
        keyFor: version => idempotencyKey('appResume', startedAt, version),
        send: params => ctx.app.post(APP_PATHS.control('resume'), { ...params, reason: REASONS.cutover }),
        reread: async () => readAppStatus(await ctx.app.get(APP_PATHS.status)),
        isApplied: view => view.paused === false,
        isConflict: error => isConflict(error, 'version_conflict'),
      });
    } catch (error) {
      ctx.report.fail(`${errorMessage(error)}. notBefore stays ${current.notBefore}. Check the channel with npm run cutover:status, fix the cause, then run activate again (it keeps that notBefore and does not resume twice).`);
      return EXIT.failed;
    }
  }

  const after = readAppStatus(await ctx.app.get(APP_PATHS.status));
  if (after.paused !== false || after.notBefore === null) {
    ctx.report.fail(`The app does not report ${CHANNEL_ID} active (paused=${after.paused}, notBefore ${after.notBefore ?? 'not set'}).`);
    return EXIT.failed;
  }
  ctx.report.ok(`${CHANNEL_ID} is active on the app (delivery-state version ${after.version}, notBefore ${after.notBefore})`);
  const workerAfter = await ctx.worker.status();
  if (workerAfter.paused !== true) {
    ctx.report.fail(`DANGER: the Worker now reports ${CHANNEL_ID} paused=false while the app is active. Pause the app now: npm run cutover:rollback -- --confirm`);
    return EXIT.failed;
  }
  ctx.report.ok(`the Worker channel is still paused (version ${workerAfter.version})`);
  if (ctx.config.runNow) {
    const code = await triggerRun(ctx);
    if (code !== EXIT.ok) return code;
  }
  ctx.report.line(`Cutover instant (notBefore): ${after.notBefore}. Next: poll npm run cutover:check about hourly, for up to 24 h.`);
  return EXIT.ok;
}

/**
 * A5, one-shot: 0 when a post is delivered with a message ID and none was
 * published before `notBefore`; 2 while nothing is delivered (inside the
 * window); 1 on a violation or once the window has passed.
 * @param {CutoverContext} ctx
 */
async function commandCheckFirstPost(ctx) {
  const now = ctx.now();
  const problems = [];

  ctx.report.section(`Worker (${ctx.worker.url})`);
  const worker = await ctx.worker.status();
  describeWorker(ctx, worker);
  if (worker.paused !== true) problems.push(`the Worker reports ${CHANNEL_ID} paused=false: both runtimes could post to the chat`);

  ctx.report.section(`App (${ctx.app.origin})`);
  const status = readAppStatus(await ctx.app.get(APP_PATHS.status));
  describeAppStatus(ctx, status);
  const cutoff = status.notBefore === null ? NaN : Date.parse(status.notBefore);
  if (!Number.isFinite(cutoff)) problems.push('notBefore is not set: the cutover has not been activated (npm run cutover:activate -- --confirm)');
  if (status.paused !== false) problems.push(`${CHANNEL_ID} is paused on the app (paused=${status.paused}): nothing will be posted`);
  if (!status.enabled) problems.push(`${CHANNEL_ID} is disabled on the app: nothing will be posted`);
  if (status.mutationState === 'blocked_ambiguous') {
    problems.push('the app channel is blocked by an ambiguous output (mutationState=blocked_ambiguous): reconcile it in the dashboard');
  }
  const ambiguous = await contentTotal(ctx, { status: 'ambiguous' });
  if (ambiguous > 0) problems.push(`${ambiguous} library item(s) are ambiguous (a post may or may not have gone out): reconcile them in the dashboard`);

  ctx.report.section('Delivered posts');
  const delivered = await listContent(ctx, { status: 'delivered', dateField: 'delivered' }, MAX_DELIVERED_PAGES);
  if (!delivered.complete) problems.push(`only ${delivered.items.length} of ${delivered.total} delivered items could be checked; check the rest in the dashboard`);
  const early = Number.isFinite(cutoff) ? delivered.items.filter(item => publishedBefore(item, cutoff)) : [];
  for (const item of early.slice(0, MAX_LISTED_PROBLEMS)) {
    problems.push(`delivered although published before notBefore: ${describeItem(item)}`);
  }
  if (early.length > MAX_LISTED_PROBLEMS) problems.push(`… and ${early.length - MAX_LISTED_PROBLEMS} more delivered item(s) published before notBefore`);
  const posted = delivered.items.filter(item => typeof item?.messageId === 'string' && item.messageId.trim() !== '');
  ctx.report.line(`${delivered.total} delivered item(s), ${posted.length} with a Telegram message ID; ${early.length} published before notBefore; ${ambiguous} ambiguous.`);
  if (delivered.items.length > posted.length) {
    ctx.report.warn(`${delivered.items.length - posted.length} delivered item(s) have no message ID.`);
  }

  if (problems.length > 0) {
    ctx.report.section('Result');
    for (const problem of problems) ctx.report.fail(problem);
    ctx.report.line(`A5 not met: ${problems.length} problem${problems.length === 1 ? '' : 's'}. Roll back if needed: npm run cutover:rollback -- --confirm`);
    return EXIT.failed;
  }
  if (posted.length > 0) {
    const first = earliestDelivered(posted);
    ctx.report.section('Result');
    ctx.report.ok(`A5 met: the Worker is paused, the app delivered ${posted.length} post(s), and none was published before notBefore ${status.notBefore}.`);
    ctx.report.line(`First delivery: ${describeItem(first)}`);
    ctx.report.line(`For docs/deployment.md: cutover (notBefore) ${status.notBefore}; Worker channel version ${worker.version}; first delivery ${first.deliveryId ?? '?'}, message ${first.messageId}.`);
    return EXIT.ok;
  }

  // Nothing delivered yet: the scan numbers (the last run's sources and selection are in the App section).
  ctx.report.section('Scan since notBefore');
  const runs = await runsSince(ctx, cutoff);
  ctx.report.line(`runs since notBefore: ${runs.count}${runs.more ? '+' : ''} (${formatTally(runs.byStatus, [])})`);
  const rejected = await rejectedSince(ctx, status.notBefore);
  ctx.report.line(`items rejected since notBefore: ${formatTally(rejected.byReason, REJECT_REASONS)}${rejected.complete ? '' : ` (counted ${rejected.counted} of ${rejected.total})`}`);
  ctx.report.section('Result');
  const elapsedMs = now - cutoff;
  const hours = (elapsedMs / 3_600_000).toFixed(1);
  if (elapsedMs >= FIRST_POST_WINDOW_MS) {
    ctx.report.fail(`Nothing delivered ${hours} h after notBefore: the 24 h window has passed. Report the scan numbers above to the user; do not move notBefore.`);
    return EXIT.failed;
  }
  ctx.report.info(`Nothing delivered yet, ${hours} h after notBefore (window 24 h). Check again later.`);
  return EXIT.pending;
}

/**
 * Pause the app channel; with --resume-worker, then resume the Worker channel.
 * @param {CutoverContext} ctx
 */
async function commandRollback(ctx) {
  const startedAt = ctx.now();
  ctx.report.section(`App (${ctx.app.origin})`);
  const status = readAppStatus(await ctx.app.get(APP_PATHS.status));
  describeAppStatus(ctx, status);
  if (status.paused === null || status.version === null) {
    ctx.report.fail(`The app reports no delivery state for ${CHANNEL_ID}; nothing can be paused through the API.`);
    return EXIT.failed;
  }

  let worker = null;
  if (ctx.config.resumeWorker) {
    ctx.report.section(`Worker (${ctx.worker.url})`);
    worker = await ctx.worker.status();
    describeWorker(ctx, worker);
    if (worker.runtimeMode !== 'active' || worker.mutationState !== 'free') {
      ctx.report.warn(`The Worker reports runtimeMode ${worker.runtimeMode} and mutationState ${worker.mutationState ?? '?'}. In bootstrap mode it refuses /control/resume (only pause is accepted), and a blocked_ambiguous channel holds delivery: the Worker posts again only after an active-mode redeploy and reconciliation of the ambiguous item, which needs a user decision.`);
    }
  }

  const appPause = status.paused
    ? null
    : { idempotencyKey: idempotencyKey('appPause', startedAt, status.version), expectedVersion: status.version, reason: REASONS.rollback };
  const workerResume = worker && worker.paused
    ? { expectedVersion: worker.version, idempotencyKey: idempotencyKey('workerResume', startedAt, worker.version), reason: REASONS.rollback }
    : null;
  ctx.report.section('Plan');
  let step = 0;
  if (appPause) {
    ctx.report.plan(`${++step}. ${ctx.app.describe('POST', APP_PATHS.control('pause'), appPause)}`);
    ctx.report.plan('   Then require paused=true on the app before anything else.');
  } else {
    ctx.report.plan(`${++step}. The app channel is already paused (version ${status.version}); nothing to pause.`);
  }
  if (worker) {
    ctx.report.plan(workerResume
      ? `${++step}. ${ctx.worker.describeControl('resume', workerResume)}`
      : `${++step}. The Worker channel is already unpaused; nothing to resume.`);
  }
  if (!appPause && !workerResume) {
    ctx.report.ok('Nothing to change.');
    return EXIT.ok;
  }
  if (!confirmed(ctx)) return EXIT.failed;

  ctx.report.section('Rollback');
  if (appPause) {
    await sendVersionedControl(ctx, {
      label: 'App pause',
      version: status.version,
      firstKey: appPause.idempotencyKey,
      keyFor: version => idempotencyKey('appPause', startedAt, version),
      send: params => ctx.app.post(APP_PATHS.control('pause'), { ...params, reason: REASONS.rollback }),
      reread: async () => readAppStatus(await ctx.app.get(APP_PATHS.status)),
      isApplied: view => view.paused === true,
      isConflict: error => isConflict(error, 'version_conflict'),
    });
  }
  const appAfter = readAppStatus(await ctx.app.get(APP_PATHS.status));
  if (appAfter.paused !== true) {
    ctx.report.fail(`STOP: the app still reports ${CHANNEL_ID} paused=${appAfter.paused}; the Worker was not touched.`);
    return EXIT.failed;
  }
  ctx.report.ok(`${CHANNEL_ID} is paused on the app (delivery-state version ${appAfter.version})`);
  if (!workerResume) return EXIT.ok;

  try {
    await sendVersionedControl(ctx, {
      label: 'Worker resume',
      version: workerResume.expectedVersion,
      firstKey: workerResume.idempotencyKey,
      keyFor: version => idempotencyKey('workerResume', startedAt, version),
      send: ({ expectedVersion, idempotencyKey: key }) => ctx.worker.control('resume', { expectedVersion, idempotencyKey: key, reason: REASONS.rollback }),
      reread: () => ctx.worker.status(),
      isApplied: view => view.paused === false,
      isConflict: error => isConflict(error, 'request_conflict'),
    });
  } catch (error) {
    if (error instanceof RequestError && error.code === 'runtime_not_active') {
      ctx.report.fail(`The Worker refused the resume: it runs in ${worker.runtimeMode} mode, which accepts only pause. Its channel stays paused; the app channel is paused too, so nothing posts.`);
      return EXIT.failed;
    }
    throw error;
  }
  const workerAfter = await ctx.worker.status();
  if (workerAfter.paused !== false) {
    ctx.report.fail(`The Worker still reports ${CHANNEL_ID} paused=${workerAfter.paused} (version ${workerAfter.version}).`);
    return EXIT.failed;
  }
  ctx.report.ok(`${CHANNEL_ID} is resumed on the Worker (version ${workerAfter.version}); it posts only in active runtime mode (now ${workerAfter.runtimeMode}).`);
  return EXIT.ok;
}

/** The handler of each command (see `COMMANDS` in cutover-config.mjs). */
export const COMMAND_HANDLERS = Object.freeze({
  status: commandStatus,
  preview: commandPreview,
  'pause-worker': commandPauseWorker,
  activate: commandActivate,
  'check-first-post': commandCheckFirstPost,
  rollback: commandRollback,
});

/**
 * Send a versioned operator control. On a version conflict, read the state
 * once more: stop if another request already applied the change, otherwise
 * retry once with the new version and its own deterministic key.
 * @param {CutoverContext} ctx
 * @param {{
 *   label: string,
 *   version: number,
 *   firstKey: string,
 *   keyFor: (version: number) => string,
 *   send: (params: { expectedVersion: number, idempotencyKey: string }) => Promise<Record<string, unknown>>,
 *   reread: () => Promise<{ paused: boolean|null, version: number|null }>,
 *   isApplied: (view: { paused: boolean|null, version: number|null }) => boolean,
 *   isConflict: (error: unknown) => boolean,
 * }} options
 */
async function sendVersionedControl(ctx, { label, version, firstKey, keyFor, send, reread, isApplied, isConflict: conflicted }) {
  try {
    reportControl(ctx, label, await send({ expectedVersion: version, idempotencyKey: firstKey }));
    return;
  } catch (error) {
    if (!conflicted(error)) throw error;
    ctx.report.warn(`${label}: conflict at version ${version} (${errorMessage(error)}); reading the state again for one retry.`);
  }
  await ctx.sleep(CONFLICT_RETRY_DELAY_MS);
  const current = await reread();
  if (isApplied(current)) {
    ctx.report.info(`${label}: already applied by another request (version ${current.version}).`);
    return;
  }
  if (!Number.isSafeInteger(current.version)) throw new Error(`${label}: the state has no version to retry with.`);
  const key = keyFor(current.version);
  ctx.report.info(`${label}: retrying with expectedVersion ${current.version} and Idempotency-Key ${key}.`);
  reportControl(ctx, label, await send({ expectedVersion: current.version, idempotencyKey: key }));
}

function reportControl(ctx, label, result) {
  const status = typeof result?.status === 'string' ? result.status : 'accepted';
  ctx.report.ok(`${label}: ${status}${result?.replayed === true ? ' (replay of an earlier identical request)' : ''}`);
}

function isConflict(error, code) {
  return error instanceof RequestError && error.status === 409 && error.code === code;
}

function confirmed(ctx) {
  if (ctx.config.confirm) return true;
  ctx.report.fail('Refused: nothing was changed. Re-run with --confirm to apply the plan above.');
  return false;
}

async function triggerRun(ctx) {
  try {
    const queued = await ctx.app.post(APP_PATHS.run, {});
    ctx.report.ok(`manual run queued (run ${queued.runId ?? '?'}, position ${queued.position ?? '?'})`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof RequestError && error.code === 'channel_busy') {
      ctx.report.warn('A run is already running or queued; no second run was queued.');
      return EXIT.ok;
    }
    throw error;
  }
}

async function readSnapshot(ctx) {
  const status = readAppStatus(await ctx.app.get(APP_PATHS.status));
  const delivered = await contentTotal(ctx, { status: 'delivered' });
  const items = await contentTotal(ctx, {});
  const runs = readPage(await ctx.app.get(APP_PATHS.runs, { limit: 1 }), 'runs').total;
  return { status, delivered, items, runs };
}

async function contentTotal(ctx, query) {
  return readPage(await ctx.app.get(APP_PATHS.content, { channelId: CHANNEL_ID, ...query, limit: 1 }), 'items').total;
}

/** Every page of a library listing, up to `maxPages`. */
async function listContent(ctx, query, maxPages) {
  const items = [];
  let total = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const listing = readPage(await ctx.app.get(APP_PATHS.content, {
      channelId: CHANNEL_ID, ...query, limit: PAGE_SIZE, offset: items.length,
    }), 'items');
    total = listing.total;
    items.push(...listing.entries);
    if (listing.entries.length === 0 || items.length >= total) return { items, total, complete: true };
  }
  return { items, total, complete: items.length >= total };
}

async function runsSince(ctx, cutoff) {
  const { entries } = readPage(await ctx.app.get(APP_PATHS.runs, { limit: PAGE_SIZE }), 'runs');
  const recent = entries.filter(run => Date.parse(run?.startedAt) >= cutoff);
  return {
    count: recent.length,
    more: recent.length === PAGE_SIZE,
    byStatus: tally(recent.map(run => (typeof run?.status === 'string' ? run.status : 'unknown'))),
  };
}

async function rejectedSince(ctx, notBefore) {
  const listing = await listContent(ctx, { status: 'rejected', dateField: 'seen', from: notBefore }, MAX_REJECTED_PAGES);
  return {
    byReason: tally(listing.items.map(item => (typeof item?.rejectReason === 'string' ? item.rejectReason : 'unknown'))),
    complete: listing.complete,
    counted: listing.items.length,
    total: listing.total,
  };
}

// Same rule as the app's cutover filter (src/app/runtime/not-before.js): a
// missing or unreadable publishedAt cannot prove an article is old.
function publishedBefore(item, cutoff) {
  const value = item?.publishedAt;
  if (value === null || value === undefined || value === '') return false;
  const time = Date.parse(String(value));
  return Number.isFinite(time) && time < cutoff;
}

function earliestDelivered(items) {
  const time = item => {
    const value = Date.parse(item?.deliveredAt);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return [...items].sort((left, right) => time(left) - time(right))[0];
}

/** Generated text of a preview: `content` (digest) and each item's `hook` (drip). */
function generatedTexts(preview) {
  const texts = [];
  if (typeof preview?.content === 'string' && preview.content.trim() !== '') texts.push({ title: null, text: preview.content });
  for (const item of Array.isArray(preview?.items) ? preview.items : []) {
    if (typeof item?.hook === 'string' && item.hook.trim() !== '') {
      texts.push({ title: typeof item.title === 'string' ? item.title : null, text: item.hook });
    }
  }
  return texts;
}

function describeWorker(ctx, worker) {
  ctx.report.line(`runtimeMode ${worker.runtimeMode}; ${CHANNEL_ID} paused=${worker.paused}, version ${worker.version}, mutationState ${worker.mutationState ?? '?'}${worker.updatedAt ? `, updated ${worker.updatedAt}` : ''}`);
  const counts = WORKER_COUNT_KEYS.filter(key => key in worker.counts).map(key => `${key} ${worker.counts[key]}`);
  if (counts.length > 0) ctx.report.line(`counts: ${counts.join(', ')}`);
  if (worker.queue) {
    ctx.report.line(`queue ${worker.queue.publishingDay ?? '-'}: ${worker.queue.total ?? '?'} total, ${worker.queue.remaining ?? '?'} remaining, ${worker.queue.blocked ?? '?'} blocked`);
  }
  if (worker.lastRequest) {
    const request = worker.lastRequest;
    ctx.report.line(`last request: ${request.triggerType ?? '?'} ${request.state ?? '?'}/${request.outcome ?? '-'}${request.updatedAt ? `, updated ${request.updatedAt}` : ''}`);
  }
}

function describeHealth(ctx, health) {
  const runtime = health?.runtime ?? {};
  const lease = runtime.leased === true
    ? `runtime lease held${runtime.leaseHolder?.self === true ? ' by the answering instance' : ''}`
    : 'runtime lease NOT held';
  ctx.report.line(`/api/health: ${health?.status ?? '?'}, version ${health?.version ?? '?'}, ${lease}, channelCount ${health?.channelCount ?? '?'}`);
}

function describeAppStatus(ctx, status) {
  ctx.report.line(`${CHANNEL_ID}: paused=${status.paused}, version ${status.version ?? '?'} (delivery state), configVersion ${status.configVersion ?? '?'}, `
    + `cutoverRequired=${status.cutoverRequired}, notBefore ${status.notBefore ?? 'not set'}, mutationState ${status.mutationState ?? '?'}, `
    + `unresolved ${status.unresolvedCount ?? '?'}${status.enabled ? '' : ', DISABLED'}`);
  const queue = status.queue;
  if (queue) {
    ctx.report.line(`queue ${queue.date ?? '-'}: ${queue.total ?? '?'} total, ${queue.remaining ?? '?'} remaining, ${queue.blocked ?? '?'} blocked, ${queue.delivered ?? '?'} delivered`);
  }
  ctx.report.line(`last run: ${formatRun(status.lastRun)}`);
}

function describeSnapshot(ctx, snapshot) {
  ctx.report.line(`${CHANNEL_ID}: paused=${snapshot.status.paused}, version ${snapshot.status.version ?? '?'} (delivery state); `
    + `${snapshot.delivered} delivered, ${snapshot.items} library items, ${snapshot.runs} runs`);
}

function describePreview(ctx, preview, texts) {
  const items = Array.isArray(preview?.items) ? preview.items.length : 0;
  ctx.report.line(`status ${preview?.status ?? '?'}${preview?.reason ? ` (${preview.reason})` : ''}, mode ${preview?.mode ?? '?'}, `
    + `publishing day ${preview?.publishingDay ?? '-'}, ${items} item(s), articles ${preview?.stats?.articles ?? '?'}`);
  ctx.report.line(`sources: ${formatSourceHealth(preview?.sourceHealth)}; selection: ${formatSelection(preview?.stats?.selection)}`);
  const usage = preview?.aiUsage;
  if (usage && typeof usage === 'object') {
    ctx.report.line(`AI calls: ${usage.succeeded ?? '?'} succeeded of ${usage.attempted ?? '?'}; tokens in ${usage.inputTokens ?? '?'}, out ${usage.outputTokens ?? '?'}`);
  }
  const [first] = texts;
  if (!first) return;
  const characters = Array.from(first.text);
  const excerpt = characters.slice(0, EXCERPT_CHARS).join('');
  ctx.report.line(`Excerpt${first.title ? ` of "${first.title.slice(0, 160)}"` : ''} (first ${Math.min(EXCERPT_CHARS, characters.length)} of ${characters.length} characters):`);
  for (const line of excerpt.split(/\r?\n/)) ctx.report.line(`    | ${line}`);
}

function describeStage(worker, status) {
  if (worker.paused === false) {
    return 'Before the cutover: the Worker channel is unpaused and the app channel paused. Next: npm run cutover:preview, then npm run cutover:pause-worker -- --confirm';
  }
  if (status.paused === true) {
    return 'Both channels are paused, so nothing posts. Next: npm run cutover:activate -- --confirm';
  }
  if (status.paused === false) {
    return `Cut over: the app is the only active engine (notBefore ${status.notBefore ?? 'not set'}). Check: npm run cutover:check`;
  }
  return `The app has no delivery state for ${CHANNEL_ID} yet.`;
}

function describeItem(item) {
  const title = typeof item?.title === 'string' ? item.title.slice(0, 160) : '(untitled)';
  return `"${title}" (delivery ${item?.deliveryId ?? '?'}, message ${item?.messageId ?? 'none'}, published ${item?.publishedAt ?? 'unknown'}, delivered ${item?.deliveredAt ?? '?'})`;
}

function formatRun(run) {
  if (!run) return 'none';
  const outputs = Number.isSafeInteger(run.outputsTotal) ? `; outputs ${run.outputsSucceeded ?? 0}/${run.outputsTotal}` : '';
  return `${run.status ?? '?'}${run.reason ? ` (${run.reason})` : ''}, ${run.triggerType ?? '?'}, started ${run.startedAt ?? '?'}; `
    + `sources ${formatSourceHealth(run.sourceHealth)}; selection ${formatSelection(run.selection)}${outputs}${run.error ? `; error: ${run.error}` : ''}`;
}

function formatSourceHealth(health) {
  if (!health || typeof health !== 'object') return 'n/a';
  return `${health.total ?? '?'} total, ${health.healthy ?? '?'} healthy, ${health.failed ?? '?'} failed, ${health.unknown ?? '?'} unknown${health.degraded ? ' (degraded)' : ''}`;
}

function formatSelection(selection) {
  if (!selection || typeof selection !== 'object') return 'n/a';
  const parts = SELECTION_KEYS.filter(key => Number.isSafeInteger(selection[key])).map(key => `${key} ${selection[key]}`);
  return parts.length > 0 ? parts.join(', ') : 'n/a';
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatTally(counts, order) {
  const keys = [...order.filter(key => counts.has(key)), ...[...counts.keys()].filter(key => !order.includes(key)).sort()];
  return keys.length > 0 ? keys.map(key => `${key} ${counts.get(key)}`).join(', ') : 'none';
}
