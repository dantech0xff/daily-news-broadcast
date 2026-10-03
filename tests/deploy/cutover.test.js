import test from 'node:test';
import assert from 'node:assert/strict';

import { idempotencyKey, readCutoverConfig } from '../../scripts/deploy/cutover-config.mjs';
import { EXCERPT_CHARS, FIRST_POST_WINDOW_MS } from '../../scripts/deploy/cutover-steps.mjs';
import {
  CUTOVER,
  CUTOVER_SECRETS,
  contentItem,
  createFakeCutover,
  cutoverEnv,
  dripPreview,
  runCutover,
} from './helpers/fake-cutover.js';

const NOT_BEFORE = CUTOVER.now;
const LATER = '2026-10-03T15:00:00.000Z';
const APP_ORIGIN = `https://${CUTOVER.hostname}`;

const isMutation = call => call.method !== 'GET';
const workerPosts = calls => calls.filter(call => call.service === 'worker' && call.method === 'POST');
const appMutations = calls => calls.filter(call => call.service === 'app' && isMutation(call));

function assertNoSecrets(text) {
  for (const secret of CUTOVER_SECRETS) assert.equal(text.includes(secret), false, 'a secret value was printed');
}

/** Both runtimes after a successful cutover: Worker paused, app channel active since NOT_BEFORE. */
function activeFake({ content = [], runs = [], lastRun = null, worker = {} } = {}) {
  const fake = createFakeCutover({ worker: { paused: true, version: 544, ...worker } });
  Object.assign(fake.state.app.record, { notBefore: NOT_BEFORE, version: 3 });
  Object.assign(fake.state.app.delivery, { paused: false, version: 8 });
  Object.assign(fake.state.app, { content, runs, lastRun });
  return fake;
}

function deliveredItem(overrides = {}) {
  return contentItem({
    status: 'delivered',
    deliveryId: 'delivery-1',
    messageId: '1600',
    publishedAt: '2026-10-03T12:30:00.000Z',
    deliveredAt: '2026-10-03T13:00:05.000Z',
    ...overrides,
  });
}

test('pause-worker pauses the Worker channel with the operator secret and a deterministic key, then verifies it', async () => {
  const fake = createFakeCutover();
  const result = await runCutover(['pause-worker', '--confirm'], { fake });
  assert.equal(result.code, 0, result.output);

  const posts = workerPosts(result.calls);
  assert.equal(posts.length, 1);
  const [pause] = posts;
  assert.equal(pause.url, `${CUTOVER.workerUrl}/control/pause`);
  assert.equal(pause.headers.authorization, `Bearer ${CUTOVER.operatorSecret}`);
  assert.equal(pause.headers['content-type'], 'application/json');
  assert.equal(pause.headers['idempotency-key'], 'cutover-pause-telegram-main-20261003');
  assert.deepEqual(pause.body, { channelId: 'telegram-main', expectedVersion: 543, reason: 'Cutover to Dokploy' });

  // The version is read before the pause and the result verified after it, both with the trigger secret.
  const reads = result.calls.filter(call => call.path === '/status');
  assert.equal(reads.length, 2);
  for (const read of reads) assert.equal(read.headers.authorization, `Bearer ${CUTOVER.triggerSecret}`);
  assert.ok(result.calls.indexOf(reads[0]) < result.calls.indexOf(pause));
  assert.ok(result.calls.indexOf(pause) < result.calls.indexOf(reads[1]));
  assert.equal(result.calls.some(call => call.service === 'app'), false, 'pause-worker never talks to the app');

  assert.equal(fake.state.worker.paused, true);
  assert.match(result.stdout, /telegram-main is paused on the Worker \(version 544, runtimeMode bootstrap\)/);
  assertNoSecrets(result.output);
});

test('pause-worker is idempotent: a paused Worker channel is left alone', async () => {
  const fake = createFakeCutover();
  assert.equal((await runCutover(['pause-worker', '--confirm'], { fake })).code, 0);
  for (const argv of [['pause-worker', '--confirm'], ['pause-worker']]) {
    const result = await runCutover(argv, { fake });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(workerPosts(result.calls), []);
    assert.match(result.stdout, /already paused on the Worker \(version 544\); nothing to do/);
  }
  assert.equal(fake.state.worker.version, 544);
});

test('pause-worker reads the version again and retries once with a new key after a version conflict', async () => {
  const fake = createFakeCutover({
    worker: {
      beforeControl: (worker, { attempt }) => {
        if (attempt === 1) worker.version += 1;
      },
    },
  });
  const result = await runCutover(['pause-worker', '--confirm'], { fake });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(workerPosts(result.calls).map(call => [call.body.expectedVersion, call.headers['idempotency-key']]), [
    [543, 'cutover-pause-telegram-main-20261003'],
    [544, 'cutover-pause-telegram-main-20261003-v544'],
  ]);
  assert.equal(result.sleeps.length, 1, 'one short wait before reading again');
  assert.match(result.stderr, /Worker pause: conflict at version 543/);
  assert.equal(fake.state.worker.paused, true);
});

test('pause-worker retries only once: a second conflict fails without a third attempt', async () => {
  const fake = createFakeCutover({
    worker: {
      beforeControl: worker => {
        worker.version += 1;
      },
    },
  });
  const result = await runCutover(['pause-worker', '--confirm'], { fake });
  assert.equal(result.code, 1);
  assert.equal(workerPosts(result.calls).length, 2);
  assert.match(result.stderr, /HTTP 409: request_conflict/);
  assert.equal(fake.state.worker.paused, false);
});

test('pause-worker stops when the Worker still reports the channel unpaused afterwards', async () => {
  const fake = createFakeCutover({ worker: { ignoreControls: true } });
  const result = await runCutover(['pause-worker', '--confirm'], { fake });
  assert.equal(result.code, 1);
  assert.equal(workerPosts(result.calls).length, 1);
  assert.match(result.stderr, /STOP: the Worker still reports telegram-main paused=false/);
  assert.match(result.stderr, /Do not activate the app/);
});

test('activate refuses while the Worker channel is not paused', async () => {
  const fake = createFakeCutover();
  const result = await runCutover(['activate', '--confirm'], { fake });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls.filter(isMutation), []);
  assert.equal(result.calls.some(call => call.service === 'app'), false, 'nothing on the app is read or changed');
  assert.match(result.stderr, /Refused: the Worker reports telegram-main paused=false/);
  assert.match(result.stderr, /npm run cutover:pause-worker -- --confirm/);
  assert.equal(fake.state.app.record.notBefore, null);
  assert.equal(fake.state.app.delivery.paused, true);
});

test('activate sets notBefore before resuming, sending Origin, JSON, and the service token on every mutation', async () => {
  const fake = createFakeCutover({ worker: { paused: true, version: 544 } });
  const result = await runCutover(['activate', '--confirm', '--run-now'], { fake });
  assert.equal(result.code, 0, result.output);

  const mutations = appMutations(result.calls);
  assert.deepEqual(mutations.map(call => `${call.method} ${call.path}`), [
    'PUT /api/channels/telegram-main',
    'POST /api/channels/telegram-main/control/resume',
    'POST /api/channels/telegram-main/run',
  ]);
  for (const call of mutations) {
    assert.equal(call.headers.origin, APP_ORIGIN);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['cf-access-client-id'], CUTOVER.clientId);
    assert.equal(call.headers['cf-access-client-secret'], CUTOVER.clientSecret);
    assert.equal(call.headers.authorization, undefined);
  }
  const [put, resume, run] = mutations;
  // The config version goes with the update; the delivery-state version with the resume.
  assert.deepEqual(put.body, { version: 2, notBefore: CUTOVER.now });
  assert.deepEqual(resume.body, { idempotencyKey: 'cutover-resume-telegram-main-20261003-v7', expectedVersion: 7, reason: 'Cutover to Dokploy' });
  assert.deepEqual(run.body, {});

  // The Worker is checked before anything changes and again after the resume; it is never changed.
  const workerCalls = result.calls.filter(call => call.service === 'worker');
  assert.ok(workerCalls.every(call => call.method === 'GET'));
  assert.ok(result.calls.indexOf(workerCalls[0]) < result.calls.indexOf(put));
  assert.ok(result.calls.indexOf(workerCalls.at(-1)) > result.calls.indexOf(resume));

  assert.equal(fake.state.app.record.notBefore, CUTOVER.now);
  assert.equal(fake.state.app.delivery.paused, false);
  assert.match(result.stdout, /Cutover instant \(notBefore\): 2026-10-03T12:00:00\.000Z/);
  assertNoSecrets(result.output);
});

test('activate keeps an existing notBefore unless --reset-not-before is passed', async () => {
  const keep = createFakeCutover({ worker: { paused: true, version: 544 } });
  keep.state.app.record.notBefore = '2026-10-03T11:30:00.000Z';
  const kept = await runCutover(['activate', '--confirm'], { fake: keep });
  assert.equal(kept.code, 0, kept.output);
  assert.deepEqual(appMutations(kept.calls).map(call => call.path), ['/api/channels/telegram-main/control/resume']);
  assert.equal(keep.state.app.record.notBefore, '2026-10-03T11:30:00.000Z');
  assert.doesNotMatch(kept.stderr, /earlier than the Worker channel's last change/);

  const reset = createFakeCutover({ worker: { paused: true, version: 544 } });
  reset.state.app.record.notBefore = '2026-10-03T11:30:00.000Z';
  const replaced = await runCutover(['activate', '--confirm', '--reset-not-before'], { fake: reset });
  assert.equal(replaced.code, 0, replaced.output);
  assert.deepEqual(appMutations(replaced.calls)[0].body, { version: 2, notBefore: CUTOVER.now });
  assert.equal(reset.state.app.record.notBefore, CUTOVER.now);

  // A notBefore older than the Worker's pause is kept but flagged.
  const stale = createFakeCutover({ worker: { paused: true, version: 544 } });
  stale.state.app.record.notBefore = '2026-10-01T00:00:00.000Z';
  const warned = await runCutover(['activate'], { fake: stale });
  assert.equal(warned.code, 1, 'refused without --confirm');
  assert.match(warned.stderr, /notBefore 2026-10-01T00:00:00\.000Z is earlier than the Worker channel's last change/);
});

test('activate is a no-op once the app channel is active', async () => {
  const fake = activeFake();
  const result = await runCutover(['activate', '--confirm'], { fake });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutation), []);
  assert.match(result.stdout, /already active on the app \(notBefore 2026-10-03T12:00:00\.000Z\)/);
});

test('a failed resume keeps notBefore, and running activate again resumes without moving it', async () => {
  const fake = createFakeCutover({ worker: { paused: true, version: 544 } });
  fake.state.app.beforeControl = () => ({
    status: 422,
    body: { error: 'missing_credential', message: 'Kênh thiếu credential bắt buộc.', details: { fields: ['telegram.botTokenCredentialId', 'ai.apiKeyCredentialId'] } },
  });
  const failed = await runCutover(['activate', '--confirm'], { fake });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /HTTP 422: missing_credential; fields: telegram\.botTokenCredentialId, ai\.apiKeyCredentialId/);
  assert.match(failed.stderr, /assign the channel credentials in the dashboard first/);
  assert.match(failed.stderr, /notBefore stays 2026-10-03T12:00:00\.000Z/);
  assert.equal(fake.state.app.record.notBefore, CUTOVER.now);
  assert.equal(fake.state.app.delivery.paused, true);

  fake.state.app.beforeControl = null;
  const again = await runCutover(['activate', '--confirm'], { fake, now: '2026-10-03T12:30:00.000Z' });
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(appMutations(again.calls).map(call => call.path), ['/api/channels/telegram-main/control/resume']);
  assert.equal(fake.state.app.record.notBefore, CUTOVER.now);
  assert.equal(fake.state.app.delivery.paused, false);
});

test('idempotency keys are deterministic per UTC day and version', async () => {
  // 23:30 UTC on 3 October is already 4 October in Asia/Singapore; keys follow the UTC day.
  const lateUtc = Date.parse('2026-10-03T23:30:00.000Z');
  assert.equal(idempotencyKey('workerPause', lateUtc), 'cutover-pause-telegram-main-20261003');
  assert.equal(idempotencyKey('workerPause', lateUtc, 544), 'cutover-pause-telegram-main-20261003-v544');
  assert.equal(idempotencyKey('appResume', lateUtc, 7), 'cutover-resume-telegram-main-20261003-v7');
  assert.equal(idempotencyKey('appPause', lateUtc, 8), 'cutover-rollback-pause-telegram-main-20261003-v8');
  assert.equal(idempotencyKey('workerResume', lateUtc, 545), 'cutover-rollback-resume-telegram-main-20261003-v545');
  assert.equal(idempotencyKey('appResume', Date.parse('2026-10-04T00:00:00.000Z'), 7), 'cutover-resume-telegram-main-20261004-v7');
  assert.throws(() => idempotencyKey('toString', lateUtc), TypeError);
  assert.throws(() => idempotencyKey('appResume', lateUtc, 0), TypeError);

  // Plans printed at different times of the same UTC day show the same key.
  const fake = createFakeCutover();
  const keyOf = text => /Idempotency-Key: (\S+);/.exec(text)?.[1];
  const morning = await runCutover(['pause-worker'], { fake, now: '2026-10-03T00:00:01.000Z' });
  const night = await runCutover(['pause-worker'], { fake, now: '2026-10-03T23:59:59.000Z' });
  assert.equal(keyOf(morning.stdout), 'cutover-pause-telegram-main-20261003');
  assert.equal(keyOf(night.stdout), keyOf(morning.stdout));
});

test('check-first-post exits 2 while nothing is delivered and reports the scan numbers', async () => {
  const fake = activeFake({
    lastRun: {
      id: 'run-3', triggerType: 'scheduled', status: 'success', reason: null,
      startedAt: '2026-10-03T14:00:00.000Z', finishedAt: '2026-10-03T14:01:00.000Z',
      outputsTotal: 0, outputsSucceeded: 0, outputsFailed: 0, error: null,
      selection: { fetched: 120, fresh: 40, uncovered: 40, relevant: 0, ranked: 0, enqueued: 0 },
      sourceHealth: { total: 25, healthy: 23, failed: 1, unknown: 1, degraded: false },
    },
    runs: [
      { id: 'run-3', status: 'success', startedAt: '2026-10-03T14:00:00.000Z' },
      { id: 'run-2', status: 'success', startedAt: '2026-10-03T13:00:00.000Z' },
      { id: 'run-1', status: 'skipped', startedAt: '2026-10-03T11:00:00.000Z' },
    ],
    content: [
      contentItem({ status: 'rejected', rejectReason: 'before_cutoff', publishedAt: '2026-10-02T08:00:00.000Z', lastSeenAt: '2026-10-03T14:00:00.000Z' }),
      contentItem({ status: 'rejected', rejectReason: 'before_cutoff', publishedAt: '2026-10-01T08:00:00.000Z', lastSeenAt: '2026-10-03T13:00:00.000Z' }),
      contentItem({ status: 'rejected', rejectReason: 'not_tech', lastSeenAt: '2026-10-03T14:00:00.000Z' }),
      // Seen only before the cutover: not counted.
      contentItem({ status: 'rejected', rejectReason: 'before_cutoff', lastSeenAt: '2026-10-03T10:00:00.000Z' }),
      contentItem({ status: 'queued', publishedAt: '2026-10-03T13:30:00.000Z' }),
    ],
  });
  const result = await runCutover(['check-first-post'], { fake, now: LATER });
  assert.equal(result.code, 2, result.output);
  assert.match(result.stdout, /0 delivered item\(s\), 0 with a Telegram message ID/);
  assert.match(result.stdout, /last run: success, scheduled, started 2026-10-03T14:00:00\.000Z; sources 25 total, 23 healthy, 1 failed, 1 unknown; selection fetched 120, fresh 40/);
  assert.match(result.stdout, /runs since notBefore: 2 \(success 2\)/);
  assert.match(result.stdout, /items rejected since notBefore: before_cutoff 2, not_tech 1/);
  assert.match(result.stdout, /Nothing delivered yet, 3\.0 h after notBefore \(window 24 h\)/);
  assert.deepEqual(result.calls.filter(isMutation), []);
});

test('check-first-post exits 0 once a post is delivered with a message ID and none predates notBefore', async () => {
  const fake = activeFake({
    content: [
      deliveredItem({ deliveryId: 'delivery-2', messageId: '1601', title: 'Second', deliveredAt: '2026-10-03T14:00:05.000Z' }),
      // No publishedAt: kept by the cutover filter, so allowed.
      deliveredItem({ deliveryId: 'delivery-1', messageId: '1600', title: 'First', publishedAt: null, deliveredAt: '2026-10-03T13:00:05.000Z' }),
      contentItem({ status: 'rejected', rejectReason: 'before_cutoff', publishedAt: '2026-10-01T00:00:00.000Z' }),
    ],
  });
  const result = await runCutover(['check-first-post'], { fake, now: LATER });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /A5 met: the Worker is paused, the app delivered 2 post\(s\)/);
  assert.match(result.stdout, /First delivery: "First" \(delivery delivery-1, message 1600, published unknown/);
  assert.match(result.stdout, /Worker channel version 544; first delivery delivery-1, message 1600/);
  assert.deepEqual(result.calls.filter(isMutation), []);
});

test('check-first-post exits 1 when a delivered post was published before notBefore', async () => {
  const fake = activeFake({
    content: [
      deliveredItem(),
      deliveredItem({ deliveryId: 'delivery-0', messageId: '1599', title: 'Old news', publishedAt: '2026-10-02T09:00:00.000Z', deliveredAt: '2026-10-03T13:00:04.000Z' }),
    ],
  });
  const result = await runCutover(['check-first-post'], { fake, now: LATER });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /delivered although published before notBefore: "Old news" \(delivery delivery-0, message 1599, published 2026-10-02T09:00:00\.000Z/);
  assert.match(result.stdout, /2 delivered item\(s\), 2 with a Telegram message ID; 1 published before notBefore/);
});

test('check-first-post exits 1 on the other violations even when a valid post exists', async () => {
  const cases = [
    ['the Worker is unpaused', fake => { fake.state.worker.paused = false; }, /the Worker reports telegram-main paused=false/],
    ['an ambiguous output', fake => { fake.state.app.content.push(contentItem({ status: 'ambiguous', deliveryId: 'delivery-9' })); }, /1 library item\(s\) are ambiguous/],
    ['a channel blocked by ambiguity', fake => { fake.state.app.delivery.mutationState = 'blocked_ambiguous'; }, /blocked by an ambiguous output/],
    ['the app channel paused again', fake => { fake.state.app.delivery.paused = true; }, /telegram-main is paused on the app/],
    ['no notBefore', fake => { fake.state.app.record.notBefore = null; }, /notBefore is not set/],
  ];
  for (const [name, change, pattern] of cases) {
    const fake = activeFake({ content: [deliveredItem()] });
    change(fake);
    const result = await runCutover(['check-first-post'], { fake, now: LATER });
    assert.equal(result.code, 1, `${name}: ${result.output}`);
    assert.match(result.stderr, pattern, name);
    assert.match(result.stdout, /A5 not met/, name);
  }
});

test('check-first-post exits 1 once the 24 hour window passes without a delivery', async () => {
  const cutoff = Date.parse(NOT_BEFORE);
  const inside = await runCutover(['check-first-post'], { fake: activeFake(), now: new Date(cutoff + FIRST_POST_WINDOW_MS - 60_000).toISOString() });
  assert.equal(inside.code, 2, inside.output);

  const after = await runCutover(['check-first-post'], { fake: activeFake(), now: new Date(cutoff + FIRST_POST_WINDOW_MS).toISOString() });
  assert.equal(after.code, 1, after.output);
  assert.match(after.stderr, /Nothing delivered 24\.0 h after notBefore: the 24 h window has passed/);
  assert.match(after.stderr, /do not move notBefore/);
});

test('preview passes when it generates content, nothing is delivered, and the channel stays paused', async () => {
  const fake = createFakeCutover();
  const result = await runCutover(['preview'], { fake });
  assert.equal(result.code, 0, result.output);

  const mutations = appMutations(result.calls);
  assert.equal(mutations.length, 1);
  const [preview] = mutations;
  assert.equal(preview.path, '/api/channels/telegram-main/preview');
  assert.deepEqual(preview.body, {});
  assert.equal(preview.headers.origin, APP_ORIGIN);
  assert.equal(preview.headers['content-type'], 'application/json');
  assert.equal(result.calls.some(call => call.service === 'worker'), false);

  // Drip previews carry the generated text in the items' hooks; only an excerpt is printed.
  const { hook } = fake.state.app.preview.items[0];
  assert.ok(hook.length > EXCERPT_CHARS);
  assert.ok(result.stdout.includes(hook.slice(0, EXCERPT_CHARS)));
  assert.equal(result.stdout.includes(hook.slice(0, EXCERPT_CHARS + 1)), false);
  assert.match(result.stdout, /no delivered items appeared \(0 before, 0 after\)/);
  assert.match(result.stdout, /delivery-state version unchanged \(7\)/);
  assert.match(result.stdout, /A4 passed/);

  // A digest preview carries it in `content`.
  const digest = createFakeCutover();
  digest.state.app.preview = { ...dripPreview([]), mode: 'digest', content: 'Bản tin công nghệ hôm nay.' };
  const digestResult = await runCutover(['preview'], { fake: digest });
  assert.equal(digestResult.code, 0, digestResult.output);
  assert.match(digestResult.stdout, /\| Bản tin công nghệ hôm nay\./);
});

test('preview fails when an item is delivered meanwhile, nothing is generated, or the channel is not paused', async () => {
  const delivering = createFakeCutover();
  delivering.state.app.onPreview = app => {
    app.content.push(deliveredItem());
  };
  const delivered = await runCutover(['preview'], { fake: delivering });
  assert.equal(delivered.code, 1);
  assert.match(delivered.stderr, /delivered items changed while previewing: 0 → 1/);
  assert.match(delivered.stdout, /A4 failed/);

  const empty = createFakeCutover();
  empty.state.app.preview = dripPreview([]);
  const nothing = await runCutover(['preview'], { fake: empty });
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /no generated content \(status dry_run; selection fetched 120/);

  const active = activeFake();
  const refused = await runCutover(['preview'], { fake: active });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.calls.filter(isMutation), [], 'the preview is not requested');
  assert.match(refused.stderr, /not paused on the app \(paused=false\)/);

  const missing = createFakeCutover();
  missing.state.app.onPreview = () => ({ status: 422, body: { error: 'missing_credential', details: { fields: ['telegram.chatIdCredentialId'] } } });
  const unassigned = await runCutover(['preview'], { fake: missing });
  assert.equal(unassigned.code, 1);
  assert.match(unassigned.stderr, /missing_credential; fields: telegram\.chatIdCredentialId \(assign the channel credentials in the dashboard first\)/);
});

test('rollback pauses the app channel with a versioned key and leaves the Worker alone', async () => {
  const fake = activeFake();
  const result = await runCutover(['rollback', '--confirm'], { fake });
  assert.equal(result.code, 0, result.output);
  const mutations = appMutations(result.calls);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, '/api/channels/telegram-main/control/pause');
  assert.equal(mutations[0].headers.origin, APP_ORIGIN);
  assert.deepEqual(mutations[0].body, {
    idempotencyKey: 'cutover-rollback-pause-telegram-main-20261003-v8',
    expectedVersion: 8,
    reason: 'Rollback of the Dokploy cutover',
  });
  assert.equal(result.calls.some(call => call.service === 'worker'), false);
  assert.equal(fake.state.app.delivery.paused, true);

  const again = await runCutover(['rollback', '--confirm'], { fake });
  assert.equal(again.code, 0);
  assert.deepEqual(again.calls.filter(isMutation), []);
  assert.match(again.stdout, /Nothing to change/);
});

test('rollback --resume-worker pauses the app first and reports that a bootstrap Worker refuses the resume', async () => {
  const fake = activeFake();
  const result = await runCutover(['rollback', '--confirm', '--resume-worker'], { fake });
  assert.equal(result.code, 1, result.output);
  const appPause = result.calls.find(call => call.service === 'app' && call.path.endsWith('/control/pause'));
  const workerResume = result.calls.find(call => call.service === 'worker' && call.path === '/control/resume');
  assert.ok(appPause && workerResume);
  assert.ok(result.calls.indexOf(appPause) < result.calls.indexOf(workerResume), 'the app is paused before the Worker is touched');
  assert.equal(workerResume.headers.authorization, `Bearer ${CUTOVER.operatorSecret}`);
  assert.equal(workerResume.headers['idempotency-key'], 'cutover-rollback-resume-telegram-main-20261003-v544');
  assert.deepEqual(workerResume.body, { channelId: 'telegram-main', expectedVersion: 544, reason: 'Rollback of the Dokploy cutover' });
  assert.match(result.stderr, /In bootstrap mode it refuses \/control\/resume/);
  assert.match(result.stderr, /The Worker refused the resume: it runs in bootstrap mode/);
  assert.equal(fake.state.app.delivery.paused, true);
  assert.equal(fake.state.worker.paused, true);

  const active = activeFake({ worker: { runtimeMode: 'active', mutationState: 'free' } });
  const resumed = await runCutover(['rollback', '--confirm', '--resume-worker'], { fake: active });
  assert.equal(resumed.code, 0, resumed.output);
  assert.doesNotMatch(resumed.stderr, /bootstrap mode/);
  assert.equal(active.state.app.delivery.paused, true);
  assert.equal(active.state.worker.paused, false);
});

test('rollback never touches the Worker unless the app reports its channel paused', async () => {
  const fake = activeFake({ worker: { runtimeMode: 'active', mutationState: 'free' } });
  fake.state.app.ignoreControls = true;
  const result = await runCutover(['rollback', '--confirm', '--resume-worker'], { fake });
  assert.equal(result.code, 1, result.output);
  assert.equal(appMutations(result.calls).length, 1, 'the app pause was sent');
  assert.deepEqual(workerPosts(result.calls), [], 'the Worker resume was not sent');
  assert.match(result.stderr, /STOP: the app still reports telegram-main paused=false; the Worker was not touched/);
  assert.equal(fake.state.worker.paused, true);
});

test('activate fails when the app does not report the channel active after the resume', async () => {
  const fake = createFakeCutover({ worker: { paused: true, version: 544 } });
  fake.state.app.ignoreControls = true;
  const result = await runCutover(['activate', '--confirm', '--run-now'], { fake });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /The app does not report telegram-main active \(paused=true/);
  assert.equal(appMutations(result.calls).some(call => call.path.endsWith('/run')), false, 'no manual run on a paused channel');
});

test('activate raises the alarm when the Worker is no longer paused once the app is active', async () => {
  const fake = createFakeCutover({ worker: { paused: true, version: 544 } });
  fake.state.app.beforeControl = () => {
    fake.state.worker.paused = false;
  };
  const result = await runCutover(['activate', '--confirm', '--run-now'], { fake });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /DANGER: the Worker now reports telegram-main paused=false while the app is active/);
  assert.match(result.stderr, /npm run cutover:rollback -- --confirm/);
  assert.equal(appMutations(result.calls).some(call => call.path.endsWith('/run')), false, 'no manual run');
});

test('every command that changes state prints its plan and refuses without --confirm', async () => {
  const cases = [
    [['pause-worker'], () => createFakeCutover(), /POST https:\/\/news-engine\.dan-tran\.workers\.dev\/control\/pause authenticated with OPERATOR_SECRET/],
    [['activate'], () => createFakeCutover({ worker: { paused: true, version: 544 } }), /PUT https:\/\/radar\.example\.test\/api\/channels\/telegram-main with the service token/],
    [['activate', '--run-now'], () => activeFake(), /POST https:\/\/radar\.example\.test\/api\/channels\/telegram-main\/run/],
    [['rollback'], () => activeFake(), /POST https:\/\/radar\.example\.test\/api\/channels\/telegram-main\/control\/pause/],
    [['rollback', '--resume-worker'], () => createFakeCutover({ worker: { paused: true, version: 544, runtimeMode: 'active', mutationState: 'free' } }), /POST https:\/\/news-engine\.dan-tran\.workers\.dev\/control\/resume/],
  ];
  for (const [argv, makeFake, planPattern] of cases) {
    const fake = makeFake();
    const result = await runCutover(argv, { fake });
    const name = argv.join(' ');
    assert.equal(result.code, 1, `${name}: ${result.output}`);
    assert.deepEqual(result.calls.filter(isMutation), [], `${name} changed nothing`);
    assert.match(result.stdout, /== Plan ==/, name);
    assert.match(result.stdout, planPattern, name);
    assert.match(result.stderr, /Refused: nothing was changed\. Re-run with --confirm/, name);
    assertNoSecrets(result.output);
  }
});

test('status shows both runtimes and fails when both channels are unpaused', async () => {
  const fake = createFakeCutover();
  const result = await runCutover(['status'], { fake });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /runtimeMode bootstrap; telegram-main paused=false, version 543, mutationState blocked_ambiguous/);
  assert.match(result.stdout, /counts: ambiguousOutputs 1, unresolvedTargets 34/);
  assert.match(result.stdout, /\/api\/health: ok, version test, runtime lease held by the answering instance, channelCount 1/);
  assert.match(result.stdout, /telegram-main: paused=true, version 7 \(delivery state\), configVersion 2, cutoverRequired=true, notBefore not set/);
  assert.match(result.stdout, /Before the cutover/);
  assert.deepEqual(result.calls.filter(isMutation), []);

  fake.state.app.delivery.paused = false;
  const both = await runCutover(['status'], { fake });
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Both the Worker and the app report telegram-main unpaused/);
});

test('a service token refused by Access is reported without following the redirect', async () => {
  const fake = createFakeCutover();
  const wrongSecret = 'wrong-client-secret-0000';
  const result = await runCutover(['status'], { fake, env: cutoverEnv({ CF_ACCESS_CLIENT_SECRET: wrongSecret }) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 302: redirected to radar-team\.cloudflareaccess\.com \(Cloudflare Access did not accept the service token/);
  assert.equal(result.calls.some(call => call.url.includes('cloudflareaccess.com')), false);
  assert.equal(result.output.includes(wrongSecret), false);
});

test('secrets go only to their own service and never reach the output, even when a service echoes them', async () => {
  const fake = createFakeCutover();
  const outputs = [];
  const flow = [
    ['status'], ['preview'], ['pause-worker'], ['pause-worker', '--confirm'], ['activate'],
    ['activate', '--confirm', '--run-now'], ['status'], ['check-first-post'], ['rollback'],
    ['rollback', '--confirm', '--resume-worker'],
  ];
  for (const argv of flow) outputs.push((await runCutover(argv, { fake })).output);

  for (const call of fake.calls) {
    if (call.service === 'worker') {
      const expected = call.path === '/status' ? CUTOVER.triggerSecret : CUTOVER.operatorSecret;
      assert.equal(call.headers.authorization, `Bearer ${expected}`);
      assert.equal(call.headers['cf-access-client-secret'], undefined);
    } else {
      assert.equal(call.service, 'app');
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers['cf-access-client-secret'], CUTOVER.clientSecret);
    }
    assert.equal(call.redirect, 'manual', 'redirects are never followed');
    for (const secret of CUTOVER_SECRETS) assert.equal(call.url.includes(secret), false);
  }

  const workerEcho = createFakeCutover({
    worker: { failWith: { status: 500, body: { error: `upstream rejected Bearer ${CUTOVER.operatorSecret} and ${CUTOVER.triggerSecret}` } } },
  });
  const echoed = await runCutover(['pause-worker', '--confirm'], { fake: workerEcho });
  assert.equal(echoed.code, 1);
  assert.match(echoed.stderr, /\[REDACTED\]/);
  outputs.push(echoed.output);

  const appEcho = createFakeCutover();
  appEcho.state.app.onPreview = () => ({ status: 500, body: { error: `token ${CUTOVER.clientSecret} was rejected` } });
  const appEchoed = await runCutover(['preview'], { fake: appEcho });
  assert.equal(appEchoed.code, 1);
  outputs.push(appEchoed.output);

  for (const output of outputs) assertNoSecrets(output);
});

test('configuration problems name variables only and stop before any request', async () => {
  const cases = [
    [['pause-worker'], cutoverEnv({ OPERATOR_SECRET: undefined }), /Missing environment variables: OPERATOR_SECRET\./],
    [['preview'], cutoverEnv({ APP_HOSTNAME: '', CF_ACCESS_CLIENT_SECRET: '  ' }), /Missing environment variables: APP_HOSTNAME, CF_ACCESS_CLIENT_SECRET\./],
    [['rollback', '--resume-worker'], cutoverEnv({ TRIGGER_SECRET: '' }), /Missing environment variables: TRIGGER_SECRET\./],
    [['status'], cutoverEnv({ WORKER_URL: 'http://news-engine.dan-tran.workers.dev' }), /WORKER_URL must be an https URL/],
    [['pause-worker'], cutoverEnv({ OPERATOR_SECRET: CUTOVER.triggerSecret }), /TRIGGER_SECRET and OPERATOR_SECRET must be different values/],
    [['status'], cutoverEnv({ APP_HOSTNAME: 'https://radar.example.test/' }), /APP_HOSTNAME must be a fully qualified hostname/],
    [['status'], cutoverEnv({ CF_ACCESS_CLIENT_SECRET: 'two words' }), /CF_ACCESS_CLIENT_SECRET must contain only visible ASCII/],
    [['status', '--confirm'], cutoverEnv(), /--confirm is not an option of the status command/],
    [['rollback', '--run-now'], cutoverEnv(), /--run-now is not an option of the rollback command/],
    [['launch'], cutoverEnv(), /Unknown command; use one of: status, preview, pause-worker, activate, check-first-post, rollback/],
  ];
  for (const [argv, env, pattern] of cases) {
    const fake = createFakeCutover();
    const result = await runCutover(argv, { fake, env });
    const name = argv.join(' ');
    assert.equal(result.code, 1, `${name}: ${result.output}`);
    assert.match(result.stderr, pattern, name);
    assert.deepEqual(result.calls, [], `${name} made no request`);
    assertNoSecrets(result.output);
  }

  const unknownFlag = await runCutover(['status', '--force'], { fake: createFakeCutover() });
  assert.equal(unknownFlag.code, 1);
  assert.match(unknownFlag.stderr, /Unknown option '--force'/);

  // A secret pasted as an extra argument is not echoed.
  const pasted = await runCutover(['status', CUTOVER.operatorSecret], { fake: createFakeCutover() });
  assert.equal(pasted.code, 1);
  assert.match(pasted.stderr, /Expected one command, got 2 arguments/);
  assertNoSecrets(pasted.output);
});

test('the parsed config keeps secrets out of serialization and defaults to the production Worker', () => {
  const { config, problems } = readCutoverConfig(cutoverEnv(), { command: 'status', flags: {} });
  assert.deepEqual(problems, []);
  assert.equal(config.worker.url, 'https://news-engine.dan-tran.workers.dev');
  assert.equal(config.worker.triggerSecret, CUTOVER.triggerSecret);
  assert.equal(config.worker.operatorSecret, null, 'read-only commands never hold the operator secret');
  assert.equal(config.app.origin, APP_ORIGIN);
  assertNoSecrets(JSON.stringify(config));

  const local = readCutoverConfig(cutoverEnv({ WORKER_URL: 'http://localhost:8787/' }), { command: 'pause-worker', flags: { confirm: true } });
  assert.deepEqual(local.problems, []);
  assert.equal(local.config.worker.url, 'http://localhost:8787');
  assert.equal(local.config.worker.operatorSecret, CUTOVER.operatorSecret);
  assert.equal(local.config.app, null, 'pause-worker needs no app settings');
  assert.equal(local.config.confirm, true);
});
