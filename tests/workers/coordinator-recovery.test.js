import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { OutputPlugin } from '../../src/core/contracts.js';
import { buildOutputTopology, opaqueId } from '../../src/core/delivery.js';

const ARTICLE = Object.freeze({
  id: 'fixture-article',
  title: 'Offline Durable Object fixture',
  url: 'https://example.invalid/articles/fixture',
  content: 'Deterministic fixture content.',
  source: 'workers-fixture',
});

const OUTPUT = Object.freeze({
  id: 'recording-output',
  deliveryKey: 'recording-output:offline-destination',
});

function coordinator(name) {
  return env.NEWS_COORDINATOR.getByName(name);
}

async function prepareReadyDelivery(instance, channelId, requestId) {
  await instance._ensureIdentity(channelId);
  const machine = instance._machine(channelId);
  const delivery = await machine.prepareDelivery({
    requestId,
    mode: 'drip',
    publishingDay: '2026-07-20',
    articles: [{ ...ARTICLE, id: `${ARTICLE.id}-${requestId}` }],
    outputs: [OUTPUT],
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId });
  expect(generation.status).toBe('claimed');
  await machine.commitGeneration(generation.attempt.attemptId, { content: `digest:${requestId}` });
  return { deliveryId: delivery.deliveryId, machine };
}

async function seedCommittedMigration(instance, channelId, output) {
  const topology = await buildOutputTopology([output]);
  await instance.store.transact(tx => tx.put('migration_state', `migration:${channelId}`, {
    migrationId: `migration:${channelId}`,
    channelId,
    sourceFingerprint: 'offline-source-fingerprint',
    destinationFingerprint: topology.fingerprint,
    state: 'committed',
    importedAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  return topology;
}

async function ensurePaused(instance, channelId, idempotencyKey) {
  const machine = instance._machine(channelId);
  const channel = await machine.getChannelState();
  if (!channel.paused) {
    await machine.setPaused(true, {
      expectedVersion: channel.version,
      idempotencyKey,
      operatorId: 'fixture-operator',
      reason: 'offline canary pause fixture',
    });
  }
}

describe('ChannelDeliveryCoordinator concurrency and recovery', () => {
  it('bootstrap coordinator permits only the idempotent pause control', async () => {
    const channelId = 'bootstrap-pause-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const channel = await machine.getChannelState();
      const previousMode = instance.env.NEWS_RUNTIME_MODE;
      instance.env.NEWS_RUNTIME_MODE = 'bootstrap';
      try {
        const paused = await instance.control({
          action: 'pause',
          channelId,
          expectedVersion: channel.version,
          idempotencyKey: 'bootstrap-pause-control',
          operatorId: 'fixture-operator',
          reason: 'verify hard-paused bootstrap',
        });
        expect(paused).toMatchObject({ status: 'paused', channel: { paused: true } });
        await expect(instance.control({
          action: 'resume',
          channelId,
          expectedVersion: paused.channel.version,
          idempotencyKey: 'bootstrap-resume-control',
          operatorId: 'fixture-operator',
          reason: 'must remain blocked',
        })).rejects.toThrow(/bootstrap.*resume/i);
      } finally {
        instance.env.NEWS_RUNTIME_MODE = previousMode;
      }
    });
  });

  it('rejects malformed control versions before state-machine dispatch', async () => {
    const channelId = 'invalid-control-version-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      for (const [ordinal, expectedVersion] of ['abc', 1.5, Number.MAX_SAFE_INTEGER + 1, undefined].entries()) {
        await expect(instance.control({
          action: 'pause',
          channelId,
          expectedVersion,
          idempotencyKey: `invalid-control-version-${ordinal}`,
          operatorId: 'fixture-operator',
          reason: 'reject malformed operator version',
        })).rejects.toThrow(/expectedVersion must be a positive integer/i);
      }
    });
  });

  it('rejects a late legacy migration result after channel version drift', async () => {
    const channelId = 'migration-version-race-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const initialChannel = await machine.getChannelState();
      await machine.setPaused(true, {
        expectedVersion: initialChannel.version,
        idempotencyKey: 'migration-race-initial-pause',
        operatorId: 'fixture-operator',
        reason: 'prepare paused migration race fixture',
      });
      const migrationChannel = await machine.getChannelState();
      const previousMode = instance.env.NEWS_RUNTIME_MODE;
      const previousCache = instance.env.NEWS_CACHE;
      const previousFindChannel = instance._findChannel;
      const previousTransact = instance.store.transact;
      const transact = previousTransact.bind(instance.store);
      const topology = await buildOutputTopology([OUTPUT]);
      const migrationId = await opaqueId('legacy-migration-id', channelId, 'v2');
      const sourceFingerprint = await opaqueId('legacy-migration', '[]');
      const operatorActionId = await opaqueId('operator-action', channelId, 'migration-race-late');
      let injectedRace = false;
      let transactionCount = 0;
      instance.env.NEWS_RUNTIME_MODE = 'active';
      instance.env.NEWS_CACHE = {
        async list() { return { keys: [], list_complete: true }; },
        async get() { return null; },
      };
      instance.store.transact = async callback => {
        transactionCount += 1;
        if (transactionCount === 2 && !injectedRace) {
          injectedRace = true;
          const now = new Date().toISOString();
          await transact(tx => {
            tx.put('migration_state', migrationId, {
              migrationId,
              channelId,
              sourceFingerprint,
              destinationFingerprint: topology.fingerprint,
              state: 'committed',
              importedAt: now,
              counts: {
                keys: 0,
                seen: 0,
                digests: 0,
                queues: 0,
                importedQueueItems: 0,
                duplicateQueueItems: 0,
              },
              updatedAt: now,
            }, { expectedVersion: 0 });
            const currentChannel = tx.get('channel_state', channelId);
            tx.put('channel_state', channelId, {
              ...currentChannel,
              updatedAt: now,
            }, { expectedVersion: currentChannel.version });
          });
        }
        return transact(callback);
      };
      instance._findChannel = () => ({ id: channelId, outputs: [OUTPUT] });
      try {
        await expect(instance.control({
          action: 'migrate-legacy',
          channelId,
          expectedVersion: migrationChannel.version,
          idempotencyKey: 'migration-race-late',
          operatorId: 'fixture-operator',
          reason: 'late migration must retain the original version guard',
        })).rejects.toThrow(/Legacy migration version conflict/i);
        expect(await instance.store.get('operator_actions', operatorActionId)).toBeNull();
      } finally {
        instance.env.NEWS_RUNTIME_MODE = previousMode;
        instance.env.NEWS_CACHE = previousCache;
        instance._findChannel = previousFindChannel;
        instance.store.transact = previousTransact;
      }
    });
  });

  it('replays an exact migration committed concurrently before applying the stale version guard', async () => {
    const channelId = 'migration-idempotency-race-channel';
    const idempotencyKey = 'migration-idempotency-race';
    const operatorId = 'fixture-operator';
    const reason = 'concurrent exact migration must replay the committed audit';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const initialChannel = await machine.getChannelState();
      await machine.setPaused(true, {
        expectedVersion: initialChannel.version,
        idempotencyKey: 'migration-idempotency-initial-pause',
        operatorId,
        reason: 'prepare paused idempotency race fixture',
      });
      const migrationChannel = await machine.getChannelState();
      const previousMode = instance.env.NEWS_RUNTIME_MODE;
      const previousCache = instance.env.NEWS_CACHE;
      const previousFindChannel = instance._findChannel;
      const previousTransact = instance.store.transact;
      const transact = previousTransact.bind(instance.store);
      const topology = await buildOutputTopology([OUTPUT]);
      const migrationId = await opaqueId('legacy-migration-id', channelId, 'v2');
      const sourceFingerprint = await opaqueId('legacy-migration', '[]');
      const operatorActionId = await opaqueId('operator-action', channelId, idempotencyKey);
      const reasonHash = await opaqueId('operator-reason', channelId, reason);
      const payloadFingerprint = await opaqueId(
        'operator-action-payload',
        'migrate-legacy',
        migrationChannel.version,
        operatorId,
        reasonHash,
      );
      let injectedRace = false;
      let transactionCount = 0;
      let committedResult;
      instance.env.NEWS_RUNTIME_MODE = 'active';
      instance.env.NEWS_CACHE = {
        async list() { return { keys: [], list_complete: true }; },
        async get() { return null; },
      };
      instance.store.transact = async callback => {
        transactionCount += 1;
        if (transactionCount === 2 && !injectedRace) {
          injectedRace = true;
          const now = new Date().toISOString();
          await transact(tx => {
            const committed = tx.put('migration_state', migrationId, {
              migrationId,
              channelId,
              sourceFingerprint,
              destinationFingerprint: topology.fingerprint,
              state: 'committed',
              importedAt: now,
              counts: {
                keys: 0,
                seen: 0,
                digests: 0,
                queues: 0,
                importedQueueItems: 0,
                duplicateQueueItems: 0,
              },
              updatedAt: now,
            }, { expectedVersion: 0 });
            committedResult = {
              status: 'committed',
              migrationId,
              sourceFingerprint,
              destinationFingerprint: topology.fingerprint,
              counts: committed.counts,
              importedAt: now,
              version: committed.version,
            };
            tx.put('operator_actions', operatorActionId, {
              actionId: operatorActionId,
              action: 'migrate-legacy',
              channelId,
              migrationId,
              operatorId,
              reasonHash,
              payloadFingerprint,
              state: 'minimized',
              result: committedResult,
              createdAt: now,
              updatedAt: now,
            }, { expectedVersion: 0 });
            const currentChannel = tx.get('channel_state', channelId);
            tx.put('channel_state', channelId, {
              ...currentChannel,
              updatedAt: now,
            }, { expectedVersion: currentChannel.version });
          });
        }
        return transact(callback);
      };
      instance._findChannel = () => ({ id: channelId, outputs: [OUTPUT] });
      try {
        const replay = await instance.control({
          action: 'migrate-legacy',
          channelId,
          expectedVersion: migrationChannel.version,
          idempotencyKey,
          operatorId,
          reason,
        });
        expect(replay).toEqual(committedResult);
        expect((await instance.store.get('operator_actions', operatorActionId)).version).toBe(1);
      } finally {
        instance.env.NEWS_RUNTIME_MODE = previousMode;
        instance.env.NEWS_CACHE = previousCache;
        instance._findChannel = previousFindChannel;
        instance.store.transact = previousTransact;
      }
    });
  });

  it('pausing coalesces accepted work and classifies later paused requests by trigger authority', async () => {
    const channelId = 'paused-request-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const now = '2026-07-20T00:00:00.000Z';
      await instance.store.transact(tx => {
        for (const [requestId, triggerType] of [
          ['accepted-scheduled', 'scheduled'],
          ['accepted-manual', 'manual'],
        ]) {
          tx.put('requests', requestId, {
            requestId,
            channelId,
            triggerType,
            force: false,
            state: 'accepted',
            outcome: null,
            reason: null,
            result: null,
            createdAt: now,
            updatedAt: now,
          }, { expectedVersion: 0 });
        }
      });
      const channel = await machine.getChannelState();
      await instance.control({
        action: 'pause',
        channelId,
        expectedVersion: channel.version,
        idempotencyKey: 'pause-and-coalesce',
        operatorId: 'fixture-operator',
        reason: 'offline pause behavior fixture',
      });

      expect(await instance.store.get('requests', 'accepted-scheduled')).toMatchObject({
        state: 'completed',
        outcome: 'skipped',
        reason: 'skipped_paused',
      });
      expect(await instance.store.get('requests', 'accepted-manual')).toMatchObject({
        state: 'blocked',
        outcome: 'skipped',
        reason: 'blocked_paused',
      });

      const scheduled = await instance.acceptRequest({
        requestId: 'later-scheduled',
        channelId,
        triggerType: 'scheduled',
        requestedAt: now,
      });
      const manual = await instance.acceptRequest({
        requestId: 'later-manual',
        channelId,
        triggerType: 'manual',
        requestedAt: now,
      });
      expect(scheduled).toMatchObject({ state: 'completed', reason: 'skipped_paused' });
      expect(manual).toMatchObject({ state: 'blocked', reason: 'blocked_paused' });
    });
  });

  it('grants one output mutation lease across competing claims', async () => {
    const channelId = 'concurrent-claim-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'request-concurrent');
      const claims = await Promise.all([
        machine.claimNextOutput(deliveryId, { requestId: 'request-concurrent-a' }),
        machine.claimNextOutput(deliveryId, { requestId: 'request-concurrent-b' }),
      ]);

      expect(claims.filter(result => result.status === 'claimed')).toHaveLength(1);
      expect(claims.filter(result => result.reason === 'channel_busy')).toHaveLength(1);

      const claimed = claims.find(result => result.status === 'claimed');
      const channel = await machine.getChannelState();
      const output = (await machine.listOutputs(deliveryId))[0];
      expect(channel).toMatchObject({
        mutationState: 'active',
        activeOutputAttemptId: claimed.attempt.attemptId,
      });
      expect(output).toMatchObject({
        state: 'attempting',
        activeAttemptId: claimed.attempt.attemptId,
        attemptCount: 1,
      });
    });
  });

  it('recovers an expired generation claim without calling a provider', async () => {
    const channelId = 'stale-generation-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const delivery = await machine.prepareDelivery({
        requestId: 'request-stale-generation',
        mode: 'digest',
        publishingDay: '2026-07-20',
        articles: [{ ...ARTICLE, id: 'stale-generation-article' }],
        outputs: [OUTPUT],
      });
      const claim = await machine.claimGeneration(delivery.deliveryId, {
        requestId: 'request-stale-generation',
      });
      await instance.store.transact(tx => {
        const attempt = tx.get('attempts', claim.attempt.attemptId);
        tx.put('attempts', attempt.attemptId, {
          ...attempt,
          deadlineAt: '2026-07-19T00:00:00.000Z',
        }, { expectedVersion: attempt.version });
      });

      expect(await machine.recoverStaleAttempts()).toEqual({
        generationExpired: 1,
        outputAmbiguous: 0,
        maintenanceRecovered: 0,
      });
      expect(await machine.getAttempt(claim.attempt.attemptId)).toMatchObject({
        state: 'generation_expired',
      });
      expect(await machine.getDelivery(delivery.deliveryId)).toMatchObject({
        state: 'generation_retry_pending',
        activeGenerationAttemptId: null,
      });
    });
  });

  it('uses a real Durable Object alarm to make an expired output attempt ambiguous', async () => {
    const channelId = 'stale-output-alarm-channel';
    const stub = coordinator(channelId);
    let attemptId;
    let deliveryId;

    await runInDurableObject(stub, async (instance, state) => {
      const prepared = await prepareReadyDelivery(instance, channelId, 'request-stale-output');
      deliveryId = prepared.deliveryId;
      const claim = await prepared.machine.claimNextOutput(deliveryId, {
        requestId: 'request-stale-output',
      });
      expect(claim.status).toBe('claimed');
      attemptId = claim.attempt.attemptId;

      await instance.store.transact(tx => {
        const attempt = tx.get('attempts', attemptId);
        tx.put('attempts', attemptId, {
          ...attempt,
          deadlineAt: '2026-07-19T00:00:00.000Z',
        }, { expectedVersion: attempt.version });
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async instance => {
      const machine = instance._machine(channelId);
      expect(await machine.getAttempt(attemptId)).toMatchObject({ state: 'ambiguous' });
      expect((await machine.listOutputs(deliveryId))[0]).toMatchObject({
        state: 'needs_reconciliation',
        retryDisposition: 'manual',
        sanitizedError: 'attempt deadline expired',
      });
      expect(await machine.getDelivery(deliveryId)).toMatchObject({ state: 'needs_reconciliation' });
      expect(await machine.getChannelState()).toMatchObject({
        mutationState: 'blocked_ambiguous',
        activeOutputAttemptId: attemptId,
      });
    });
  });

  it('requeues an expired running request so eviction cannot strand it forever', async () => {
    const channelId = 'stale-running-request-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      await instance.store.transact(tx => tx.put('requests', 'stale-running-request', {
        requestId: 'stale-running-request',
        channelId,
        triggerType: 'manual',
        force: false,
        state: 'running',
        runAttemptId: 'evicted-run-attempt',
        startedAt: '2026-07-19T00:00:00.000Z',
        deadlineAt: '2026-07-19T00:00:01.000Z',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      }, { expectedVersion: 0 }));

      const resumed = [];
      instance.runRequest = async requestId => { resumed.push(requestId); };
      await instance.alarm();

      expect(resumed).toEqual(['stale-running-request']);
      expect(await instance.store.get('requests', 'stale-running-request')).toMatchObject({
        state: 'accepted',
        runAttemptId: null,
        deadlineAt: null,
        recoveryCount: 1,
      });
    });
  });

  it('alarms durably resume a ready delivery after mutation-lease contention', async () => {
    const channelId = 'ready-alarm-resume-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await prepareReadyDelivery(instance, channelId, 'request-ready-alarm');
      const accepted = [];
      instance.acceptRequest = async request => { accepted.push(request); return request; };
      await instance.alarm();
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ channelId, triggerType: 'alarm', force: false });
    });
  });

  it('maintenance mirrors use the same channel-prefixed KV namespace as normal delivery', async () => {
    const channelId = 'maintenance-prefix-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'request-maintenance-prefix');
      const output = await machine.claimNextOutput(deliveryId, { requestId: 'request-maintenance-prefix' });
      await machine.commitOutput(output.attempt.attemptId, {
        success: true,
        messageId: 'maintenance-prefix-message',
        meta: { deliveryState: 'success', retryDisposition: 'never' },
      });
      const row = (await machine.listOutbox())[0];
      await instance._drainMaintenance(machine);
      expect(await env.NEWS_CACHE.get(`news:${channelId}:${row.targetKey}`)).toBe(row.targetValue);
      expect(await env.NEWS_CACHE.get(row.targetKey)).toBeNull();
    });
  });

  it('does not repeat an operator output mutation when its idempotency key is replayed', async () => {
    const channelId = 'operator-retry-replay-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'request-operator-retry');
      const first = await machine.claimNextOutput(deliveryId, { requestId: 'request-operator-retry' });
      await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'unknown provider outcome' });
      const blocked = await machine.getOutput(deliveryId, first.output.outputKey);
      const calls = [];
      instance._findChannel = () => ({
        id: channelId,
        outputs: [{
          id: OUTPUT.id,
          deliveryKey: OUTPUT.deliveryKey,
          maxLength: 20,
          async send(content, options) {
            calls.push({ content, options });
            return {
              success: true,
              messageId: 'operator-retry-message',
              meta: { deliveryState: 'success', retryDisposition: 'never' },
            };
          },
        }],
      });
      const action = {
        action: 'retry-output',
        channelId,
        deliveryId,
        outputKey: first.output.outputKey,
        expectedVersion: blocked.version,
        idempotencyKey: 'operator-retry-idempotency',
        operatorId: 'fixture-operator',
        reason: 'provider confirms the original message is absent',
        duplicateRiskAccepted: true,
        requestId: 'operator-retry-request',
      };

      const initial = await instance.control(action);
      const replay = await instance.control(action);

      expect(calls).toHaveLength(1);
      expect(await machine.getOutput(deliveryId, first.output.outputKey)).toMatchObject({
        state: 'succeeded',
        sanitizedError: null,
      });
      expect(initial).toMatchObject({ status: 'claimed', requestId: 'operator-retry-request' });
      expect(replay).toMatchObject({ status: 'succeeded', replayed: true });
      expect(await instance.getRequest({ channelId, requestId: 'operator-retry-request' })).toMatchObject({
        requestId: 'operator-retry-request',
        triggerType: 'operator_retry',
        state: 'completed',
        outcome: 'success',
        result: { deliveryId, deliveryState: 'succeeded' },
      });
      const terminalDelivery = await machine.getDelivery(deliveryId);
      expect(calls[0].content.endsWith('[...]')).toBe(true);
      expect(calls[0].options).toMatchObject({
        article: expect.objectContaining({ id: `${ARTICLE.id}-request-operator-retry` }),
        articles: [expect.objectContaining({ id: `${ARTICLE.id}-request-operator-retry` })],
        singleMutation: false,
      });
      expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);

      const [audit] = (await instance.store.list('operator_actions'))
        .filter(value => value.action === 'retry-output');
      expect(JSON.stringify(audit)).not.toContain('provider confirms the original message is absent');
      expect(JSON.stringify(audit)).not.toContain('generated content');

      await instance.store.transact(tx => {
        for (const attempt of tx.list('attempts', value => value.deliveryId === deliveryId)) {
          tx.delete('attempts', attempt.attemptId, { expectedVersion: attempt.version });
        }
        for (const output of tx.list('delivery_outputs', value => value.deliveryId === deliveryId)) {
          tx.delete('delivery_outputs', `${output.deliveryId}:${output.outputKey}`, {
            expectedVersion: output.version,
          });
        }
        const completedDelivery = tx.get('deliveries', deliveryId);
        tx.delete('deliveries', deliveryId, { expectedVersion: completedDelivery.version });
      });
      instance._findChannel = () => { throw new Error('topology preflight must not run for exact replay'); };
      await expect(instance.control(action)).resolves.toMatchObject({
        status: 'succeeded',
        deliveryId,
        deliveryState: 'succeeded',
        outputKey: first.output.outputKey,
        version: terminalDelivery.version,
        requestId: 'operator-retry-request',
        replayed: true,
        result: { success: null, meta: null },
      });
    });
  });

  it('blocks same-provider destination drift before claiming an operator output retry', async () => {
    const channelId = 'operator-retry-topology-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'request-topology-retry');
      const first = await machine.claimNextOutput(deliveryId, { requestId: 'request-topology-retry' });
      await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'unknown provider outcome' });
      const blocked = await machine.getOutput(deliveryId, first.output.outputKey);
      const calls = [];
      instance._findChannel = () => ({
        id: channelId,
        outputs: [{
          id: OUTPUT.id,
          deliveryKey: 'recording-output:a-different-destination',
          async send(...args) { calls.push(args); return { success: true }; },
        }],
      });

      await expect(instance.control({
        action: 'retry-output',
        channelId,
        deliveryId,
        outputKey: first.output.outputKey,
        expectedVersion: blocked.version,
        idempotencyKey: 'operator-topology-drift',
        operatorId: 'fixture-operator',
        reason: 'must fail before provider mutation',
        duplicateRiskAccepted: true,
        requestId: 'operator-topology-drift-request',
      })).rejects.toThrow(/topology changed before operator retry/i);
      expect(calls).toHaveLength(0);
      expect(await machine.getOutput(deliveryId, first.output.outputKey)).toMatchObject({
        state: 'needs_reconciliation',
        version: blocked.version,
      });
    });
  });

  it('replays the same manual request despite a fresh server receipt timestamp', async () => {
    const channelId = 'manual-request-replay-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const current = await machine.getChannelState();
      await machine.setPaused(true, {
        expectedVersion: current.version,
        idempotencyKey: 'pause-for-request-replay',
        operatorId: 'fixture-operator',
        reason: 'keep replay test offline',
      });
      const base = {
        requestId: 'stable-manual-request',
        channelId,
        triggerType: 'manual',
        force: false,
      };

      const initial = await instance.acceptRequest({
        ...base,
        requestedAt: '2026-07-20T00:00:00.000Z',
      });
      const replay = await instance.acceptRequest({
        ...base,
        requestedAt: '2026-07-20T00:00:05.000Z',
      });

      expect(replay).toEqual(initial);
      expect(initial).toMatchObject({ state: 'blocked', reason: 'blocked_paused' });
      expect((await instance.store.list('requests'))).toHaveLength(1);
    });
  });

  it('projects queue state without exposing article titles or private URLs', async () => {
    const channelId = 'redacted-queue-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      instance._findChannel = () => ({ id: channelId });
      instance._buildEngine = () => ({
        async getQueue() {
          return {
            date: '2026-07-20',
            remaining: 1,
            blocked: 1,
            articles: [{
              id: 'private-article',
              title: 'Confidential title',
              url: 'https://private.example/item?token=super-secret',
              source: 'Private source',
              state: 'blocked',
              deliveryId: 'opaque-delivery-id',
            }],
          };
        },
      });

      const previousMode = instance.env.NEWS_RUNTIME_MODE;
      instance.env.NEWS_RUNTIME_MODE = 'bootstrap';
      let queue;
      try {
        queue = await instance.getQueue({ channelId, limit: 10, cursor: 0 });
      } finally {
        instance.env.NEWS_RUNTIME_MODE = previousMode;
      }
      expect(queue).toEqual({
        date: '2026-07-20',
        counts: { total: 1, remaining: 1, blocked: 1 },
        items: [{ itemId: 'opaque-delivery-id', state: 'blocked' }],
        nextCursor: null,
      });
      expect(JSON.stringify(queue)).not.toMatch(/Confidential|private\.example|super-secret|Private source/);

      await instance.store.transact(tx => {
        const identity = tx.get('coordinator_meta', 'identity');
        tx.put('requests', 'redacted-status-request', {
          requestId: 'redacted-status-request',
          channelId,
          triggerType: 'manual',
          state: 'completed',
          outcome: 'success',
          result: {
            status: 'success',
            sourceHealth: { healthy: 2, failed: 1, unknown: 0, degraded: true },
          },
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:01.000Z',
        }, { expectedVersion: 0 });
        tx.put('coordinator_meta', 'identity', {
          ...identity,
          lastRequestId: 'redacted-status-request',
          updatedAt: '2026-07-20T00:00:01.000Z',
        }, { expectedVersion: identity.version });
      });
      let repairCalls = 0;
      instance._ensureRepairAlarm = async () => { repairCalls += 1; };
      instance._queueSummary = async () => ({
        publishingDay: '2026-07-20', total: 1, remaining: 1, blocked: 1,
      });
      expect(await instance.getRequest({ channelId, requestId: 'redacted-status-request' }))
        .toMatchObject({ requestId: 'redacted-status-request', state: 'completed' });
      const status = await instance.getStatus({ channelId, limit: 10 });
      expect(repairCalls).toBe(2);
      expect(status).toMatchObject({
        runtimeMode: 'active',
        lastRequest: { requestId: 'redacted-status-request', state: 'completed' },
        sourceWarning: { degraded: true, healthy: 2, failed: 1, unknown: 0 },
        queue: { publishingDay: '2026-07-20', total: 1, remaining: 1, blocked: 1 },
      });
      expect(JSON.stringify(status)).not.toMatch(/Confidential|private\.example|super-secret|Private source/);
    });
  });

  it('projects exact redacted recovery targets and repairs wake-up after confirmation', async () => {
    const channelId = 'discoverable-recovery-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'discoverable-ambiguity');
      const claim = await machine.claimNextOutput(deliveryId, { requestId: 'discoverable-ambiguity' });
      expect(claim.status).toBe('claimed');
      await machine.commitOutput(claim.attempt.attemptId, {
        success: false,
        error: 'unknown provider outcome',
        meta: { deliveryState: 'ambiguous', retryDisposition: 'manual' },
      });

      const status = await instance.getStatus({ channelId, limit: 10, targetCursor: 0 });
      const outputTarget = status.unresolvedTargets.find(target => target.targetType === 'output');
      const deliveryTarget = status.unresolvedTargets.find(target => target.targetType === 'delivery');
      expect(outputTarget).toMatchObject({
        deliveryId,
        outputKey: claim.output.outputKey,
        state: 'needs_reconciliation',
        actions: ['confirm-delivered', 'retry-output'],
      });
      expect(Number.isSafeInteger(outputTarget.expectedVersion)).toBe(true);
      expect(deliveryTarget).toMatchObject({ deliveryId, state: 'needs_reconciliation', actions: ['abandon'] });
      expect(JSON.stringify(status.unresolvedTargets)).not.toMatch(/Offline Durable Object fixture|example\.invalid|Deterministic fixture/);

      let repairCalls = 0;
      instance._ensureRepairAlarm = async () => { repairCalls += 1; };
      const confirmed = await instance.control({
        action: 'confirm-delivered',
        channelId,
        deliveryId,
        outputKey: outputTarget.outputKey,
        expectedVersion: outputTarget.expectedVersion,
        idempotencyKey: 'confirm-discoverable-output',
        operatorId: 'fixture-operator',
        reason: 'provider console confirms one message',
      });
      expect(confirmed).toMatchObject({ status: 'confirmed' });
      expect(repairCalls).toBe(1);
    });
  });

  it('rejects canary requests for outputs that cannot guarantee one provider mutation', async () => {
    const channelId = 'unsafe-canary-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      instance._findChannel = () => ({
        id: channelId,
        outputs: [{ id: 'threads', supportsSingleMutation: false }],
      });
      await expect(instance.acceptRequest({
        requestId: 'unsafe-canary-request',
        channelId,
        triggerType: 'canary',
        force: true,
        singleMutation: true,
        confirmPausedMutation: true,
        limit: 1,
        operatorId: 'fixture-operator',
        reason: 'prove unsafe output rejection',
        duplicateRiskAccepted: true,
        requestedAt: '2026-07-20T00:00:00.000Z',
      })).rejects.toThrow(/single-mutation Telegram/i);
      expect(await instance.store.list('requests')).toEqual([]);
    });
  });

  it('does not forward a null article limit for an ordinary force request', async () => {
    const channelId = 'ordinary-force-without-limit-channel';
    const requestId = 'ordinary-force-without-limit-request';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const channel = await machine.getChannelState();
      if (channel.paused) {
        await machine.setPaused(false, {
          expectedVersion: channel.version,
          idempotencyKey: 'resume-before-ordinary-force',
          operatorId: 'fixture-operator',
          reason: 'exercise ordinary force without an article limit',
        });
      }

      const originalRunRequest = instance.runRequest.bind(instance);
      instance.runRequest = async () => null;
      await instance.acceptRequest({
        requestId,
        channelId,
        triggerType: 'force',
        operatorId: 'fixture-operator',
        reason: 'exercise ordinary force without an article limit',
        duplicateRiskAccepted: true,
        requestedAt: '2026-07-20T00:00:00.000Z',
      });

      let receivedOptions;
      instance._findChannel = () => ({ id: channelId, output: OUTPUT, mode: 'drip' });
      instance._buildEngine = () => ({
        async runDrip(options) {
          receivedOptions = options;
          return {
            status: 'skipped',
            reason: 'offline-force-fixture',
            stats: { articles: 0, outputs: 0 },
          };
        },
      });
      instance.runRequest = originalRunRequest;

      await instance.runRequest(requestId);

      expect(receivedOptions.articleLimit).toBeUndefined();
      expect(await instance.getRequest({ channelId, requestId })).toMatchObject({
        state: 'completed',
        outcome: 'skipped',
        reason: 'offline-force-fixture',
      });
    });
  });

  it('builds production channel engines with the tech relevance gate before scoring', async () => {
    const channelId = 'middleware-order-channel';
    class FixtureOutput extends OutputPlugin {
      get id() { return 'fixture-output'; }
      get name() { return 'Fixture Output'; }
      get deliveryKey() { return 'fixture-output:offline-destination'; }
    }

    await runInDurableObject(coordinator(channelId), async instance => {
      const engine = instance._buildEngine({
        id: channelId,
        sources: [],
        output: new FixtureOutput(),
        prompt: {},
        maxArticles: 12,
      });

      expect(engine.middlewares.map(middleware => JSON.parse(middleware.selectionKey)[0]))
        .toEqual(['tech-relevance', 'scoring', 'semantic-dedup']);
    });
  });

  it('forwards the channel daily limit and keeps bounded selection counts in request results', async () => {
    const channelId = 'selection-counts-channel';
    const requestId = 'selection-counts-request';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      const channel = await machine.getChannelState();
      if (channel.paused) {
        await machine.setPaused(false, {
          expectedVersion: channel.version,
          idempotencyKey: 'resume-before-selection-counts',
          operatorId: 'fixture-operator',
          reason: 'exercise request result projection',
        });
      }

      const originalRunRequest = instance.runRequest.bind(instance);
      instance.runRequest = async () => null;
      await instance.acceptRequest({
        requestId,
        channelId,
        triggerType: 'manual',
        force: false,
        requestedAt: '2026-07-20T00:00:00.000Z',
      });
      let receivedOptions;
      instance._findChannel = () => ({ id: channelId, output: OUTPUT, mode: 'drip', dailyLimit: 7 });
      instance._buildEngine = () => ({
        async runDrip(options) {
          receivedOptions = options;
          return {
            status: 'skipped',
            reason: 'no_articles',
            stats: {
              articles: 0,
              outputs: 0,
              selection: { fetched: 5, fresh: 4, relevant: 2, ranked: 2, enqueued: -1, title: 'private headline' },
            },
          };
        },
      });
      instance.runRequest = originalRunRequest;

      await instance.runRequest(requestId);

      const request = await instance.getRequest({ channelId, requestId });
      expect(receivedOptions.dailyLimit).toBe(7);
      expect(request.result.selection).toEqual({ fetched: 5, fresh: 4, relevant: 2, ranked: 2 });
    });
  });

  it('accepts a canary only while paused and records a bounded operator audit', async () => {
    const channelId = 'audited-canary-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const output = { id: 'telegram', deliveryKey: 'telegram:offline-canary', supportsSingleMutation: true };
      instance._findChannel = () => ({ id: channelId, output, mode: 'drip' });
      instance.runRequest = async () => null;
      await instance._ensureIdentity(channelId);
      await ensurePaused(instance, channelId, 'pause-before-audited-canary');
      await seedCommittedMigration(instance, channelId, output);

      const accepted = await instance.acceptRequest({
        requestId: 'opaque-audited-canary-request',
        channelId,
        triggerType: 'canary',
        force: true,
        singleMutation: true,
        confirmPausedMutation: true,
        limit: 1,
        operatorId: 'fixture-operator-key',
        reason: 'offline one-mutation proof',
        duplicateRiskAccepted: true,
        requestedAt: '2026-07-20T01:00:00.000Z',
      });

      expect(accepted).toMatchObject({ state: 'accepted', triggerType: 'canary' });
      const audits = (await instance.store.list('operator_actions')).filter(row => row.action === 'canary');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'canary',
        operatorId: 'fixture-operator-key',
        requestId: 'opaque-audited-canary-request',
        duplicateRiskAccepted: true,
      });
      expect(audits[0].reasonHash).toBeTruthy();
      expect(JSON.stringify(audits[0])).not.toContain('offline one-mutation proof');
    });
  });

  it('persists successful canary evidence and requires the exact evidence version for resume', async () => {
    const channelId = 'canary-resume-evidence-channel';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const output = { id: 'telegram', deliveryKey: 'telegram:resume-evidence', supportsSingleMutation: true };
      instance._findChannel = () => ({ id: channelId, output, mode: 'drip' });
      instance._buildEngine = () => ({
        async runDrip(options) {
          expect(options).toMatchObject({ singleMutation: true, articleLimit: 1, batchSize: 1 });
          return {
            status: 'success',
            deliveryId: 'offline-canary-delivery',
            deliveryState: 'succeeded',
            stats: { articles: 1, outputs: 1 },
          };
        },
      });
      await instance._ensureIdentity(channelId);
      await ensurePaused(instance, channelId, 'pause-before-successful-canary');
      const topology = await seedCommittedMigration(instance, channelId, output);
      const now = '2026-07-20T02:00:00.000Z';
      await instance.store.transact(tx => tx.put('requests', 'successful-canary-request', {
        requestId: 'successful-canary-request',
        channelId,
        triggerType: 'canary',
        force: true,
        operatorForce: true,
        confirmPausedMutation: true,
        singleMutation: true,
        limit: 1,
        destinationFingerprint: topology.fingerprint,
        requestedAt: now,
        payloadFingerprint: 'offline-payload-fingerprint',
        state: 'accepted',
        outcome: null,
        reason: null,
        result: null,
        runAttemptId: null,
        startedAt: null,
        deadlineAt: null,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 }));

      const completed = await instance.runRequest('successful-canary-request');
      expect(completed).toMatchObject({ state: 'completed', outcome: 'success' });
      const marker = await instance.store.get('canary_state', channelId);
      const channel = await instance._machine(channelId).getChannelState();
      expect(marker).toMatchObject({
        requestId: 'successful-canary-request',
        deliveryId: 'offline-canary-delivery',
        destinationFingerprint: topology.fingerprint,
        channelVersion: channel.version,
        state: 'succeeded',
      });

      const resumed = await instance.control({
        action: 'resume',
        channelId,
        expectedVersion: channel.version,
        idempotencyKey: 'resume-after-successful-canary',
        operatorId: 'fixture-operator',
        reason: 'canary evidence verified',
      });
      expect(resumed).toMatchObject({ status: 'resumed' });
    });
  });

  it('returns an operator retry acceptance before the provider settles', async () => {
    const channelId = 'operator-retry-async-acceptance';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'async-retry-seed');
      const first = await machine.claimNextOutput(deliveryId, { requestId: 'async-retry-seed' });
      await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'unknown provider outcome' });
      const blocked = await machine.getOutput(deliveryId, first.output.outputKey);
      let resolveProvider;
      const providerResult = new Promise(resolve => { resolveProvider = resolve; });
      let providerCalls = 0;
      instance._findChannel = () => ({
        id: channelId,
        outputs: [{
          id: OUTPUT.id,
          deliveryKey: OUTPUT.deliveryKey,
          maxLength: 4_096,
          async send() {
            providerCalls += 1;
            return providerResult;
          },
        }],
      });

      const accepted = await instance.control({
        action: 'retry-output',
        channelId,
        deliveryId,
        outputKey: first.output.outputKey,
        expectedVersion: blocked.version,
        idempotencyKey: 'async-retry-control',
        operatorId: 'fixture-operator',
        reason: 'provider confirms the original mutation is absent',
        duplicateRiskAccepted: true,
        requestId: 'async-retry-request',
      });

      expect(accepted).toMatchObject({ status: 'claimed', requestId: 'async-retry-request' });
      expect(providerCalls).toBe(1);
      expect(await instance.getRequest({ channelId, requestId: 'async-retry-request' })).toMatchObject({
        state: 'running',
        outcome: null,
      });

      resolveProvider({
        success: true,
        messageId: 'async-retry-message',
        meta: { deliveryState: 'success', retryDisposition: 'never' },
      });
      await expect.poll(async () => (
        await instance.getRequest({ channelId, requestId: 'async-retry-request' })
      )?.state).toBe('completed');
      expect(providerCalls).toBe(1);
    });
  });

  it('does not change an existing alarm when a paused retry is rejected', async () => {
    const channelId = 'rejected-control-alarm';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async (instance, state) => {
      const { deliveryId, machine } = await prepareReadyDelivery(instance, channelId, 'rejected-alarm-seed');
      const first = await machine.claimNextOutput(deliveryId, { requestId: 'rejected-alarm-seed' });
      await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'unknown provider outcome' });
      const blocked = await machine.getOutput(deliveryId, first.output.outputKey);
      const channel = await machine.getChannelState();
      await machine.setPaused(true, {
        expectedVersion: channel.version,
        idempotencyKey: 'pause-rejected-alarm-channel',
        operatorId: 'fixture-operator',
        reason: 'exercise rejected retry alarm ordering',
      });
      instance._findChannel = () => ({ id: channelId, outputs: [OUTPUT] });
      await state.storage.setAlarm(Date.now() + 60_000);
      const before = await state.storage.getAlarm();

      await expect(instance.control({
        action: 'retry-output',
        channelId,
        deliveryId,
        outputKey: first.output.outputKey,
        expectedVersion: blocked.version,
        idempotencyKey: 'paused-retry-without-override',
        operatorId: 'fixture-operator',
        reason: 'must reject without touching recovery scheduling',
        duplicateRiskAccepted: true,
        requestId: 'paused-retry-without-override-request',
      })).rejects.toThrow(/paused channel retry/i);

      expect(await state.storage.getAlarm()).toBe(before);
    });
  });

  it('does not change an existing alarm when request preflight rejects', async () => {
    const channelId = 'rejected-request-alarm';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async (instance, state) => {
      await instance._ensureIdentity(channelId);
      instance._findChannel = () => ({
        id: channelId,
        outputs: [{ id: 'threads', supportsSingleMutation: false }],
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      const before = await state.storage.getAlarm();

      await expect(instance.acceptRequest({
        requestId: 'unsafe-canary-alarm-request',
        channelId,
        triggerType: 'canary',
        limit: 1,
        singleMutation: true,
        confirmPausedMutation: true,
        duplicateRiskAccepted: true,
        operatorId: 'fixture-operator',
        reason: 'must reject before touching recovery scheduling',
      })).rejects.toThrow(/single-mutation Telegram output/i);

      expect(await state.storage.getAlarm()).toBe(before);
    });
  });

  it('serializes competing alarm candidates and preserves the earliest deadline', async () => {
    const channelId = 'concurrent-earliest-alarm';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      const earliest = now + 10_000;
      const later = now + 30_000;
      await state.storage.setAlarm(now + 60_000);

      await Promise.all([
        instance._setEarliestRepairAlarm(earliest),
        instance._setEarliestRepairAlarm(later),
      ]);

      expect(await state.storage.getAlarm()).toBe(earliest);
    });
  });

  it('uses the earliest paused maintenance override across competing states', async () => {
    const channelId = 'paused-maintenance-earliest-alarm';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async (instance, state) => {
      await instance._ensureIdentity(channelId);
      await ensurePaused(instance, channelId, 'pause-for-maintenance-alarm-order');
      const now = Date.now();
      const earliest = now + 10_000;
      await instance.store.transact(tx => {
        for (const record of [
          {
            outboxId: 'a-later-pending',
            state: 'pending',
            deadlineAt: null,
            nextAttemptAt: new Date(now + 30_000).toISOString(),
          },
          {
            outboxId: 'b-middle-attempting',
            state: 'attempting',
            deadlineAt: new Date(now + 20_000).toISOString(),
            nextAttemptAt: null,
          },
          {
            outboxId: 'z-earlier-retry',
            state: 'retry_pending',
            deadlineAt: null,
            nextAttemptAt: new Date(earliest).toISOString(),
          },
        ]) {
          tx.put('maintenance_outbox', record.outboxId, {
            ...record,
            channelId,
            attemptCount: 1,
            pauseOverrideActionId: `override:${record.outboxId}`,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          }, { expectedVersion: 0 });
        }
      });
      await state.storage.setAlarm(now + 60_000);

      await instance._ensureRepairAlarm();

      expect(await state.storage.getAlarm()).toBe(earliest);
    });
  });

  it('uses the earliest unpaused maintenance repair across competing states', async () => {
    const channelId = 'active-maintenance-earliest-alarm';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async (instance, state) => {
      await instance._ensureIdentity(channelId);
      const now = Date.now();
      const earliest = now + 10_000;
      await instance.store.transact(tx => {
        for (const record of [
          {
            outboxId: 'a-later-pending',
            state: 'pending',
            deadlineAt: null,
            nextAttemptAt: new Date(now + 30_000).toISOString(),
          },
          {
            outboxId: 'b-middle-attempting',
            state: 'attempting',
            deadlineAt: new Date(now + 20_000).toISOString(),
            nextAttemptAt: null,
          },
          {
            outboxId: 'z-earlier-retry',
            state: 'retry_pending',
            deadlineAt: null,
            nextAttemptAt: new Date(earliest).toISOString(),
          },
        ]) {
          tx.put('maintenance_outbox', record.outboxId, {
            ...record,
            channelId,
            attemptCount: 1,
            pauseOverrideActionId: null,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          }, { expectedVersion: 0 });
        }
      });
      await state.storage.setAlarm(now + 60_000);

      await instance._ensureRepairAlarm();

      expect(await state.storage.getAlarm()).toBe(earliest);
    });
  });

  it('reports and paginates more than one thousand unresolved targets without truncation', async () => {
    const channelId = 'large-unresolved-status';
    const stub = coordinator(channelId);

    await runInDurableObject(stub, async instance => {
      await instance._ensureIdentity(channelId);
      const now = '2026-07-20T00:00:00.000Z';
      await instance.store.transact(tx => {
        for (let index = 0; index < 1_205; index += 1) {
          const deliveryId = `blocked-status-${String(index).padStart(4, '0')}`;
          tx.put('deliveries', deliveryId, {
            deliveryId,
            channelId,
            state: 'blocked_topology',
            topologyFingerprint: 'offline-topology',
            topologyBlockedFromState: 'ready',
            createdAt: now,
            updatedAt: now,
          }, { expectedVersion: 0 });
        }
      });

      const first = await instance.getStatus({ channelId, limit: 100, targetCursor: 0 });
      expect(first.counts.unresolvedTargets).toBe(1_205);
      expect(first.unresolvedTargets).toHaveLength(100);
      expect(first.nextTargetCursor).toBe(100);
      expect(first.unresolvedTargets[0].actions).toEqual(['restore-topology', 'abandon']);

      const last = await instance.getStatus({ channelId, limit: 100, targetCursor: 1_200 });
      expect(last.counts.unresolvedTargets).toBe(1_205);
      expect(last.unresolvedTargets).toHaveLength(5);
      expect(last.nextTargetCursor).toBeNull();
    });
  });
});
