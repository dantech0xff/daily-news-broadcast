import { DurableObject } from 'cloudflare:workers';

import {
  CloudflareKVCache,
  DeliveryStateMachine,
  NewsEngine,
  PrefixedCache,
  SQLiteDeliveryStore,
  buildOutputTopology,
  channelArticleHash,
  createScoringMiddleware,
  createSemanticDedupMiddleware,
  normalizeSendResult,
  opaqueId,
  projectArticle,
  sanitizeError,
} from '../core/index.js';
import { defineChannels } from '../channels/definitions.js';

const ACTIVE_DELIVERY_STATES = new Set(['ready', 'generation_retry_pending', 'partial_retryable']);
const NON_TERMINAL_DELIVERY_STATES = [
  'pending_generation', 'generating', 'generation_retry_pending',
  'manual_generation_retry_pending', 'generation_exhausted', 'ready',
  'delivering', 'partial_retryable', 'output_manual_retry_required',
  'output_exhausted', 'blocked_topology', 'needs_reconciliation',
];
const RECOVERY_DELIVERY_STATES = [
  'generation_retry_pending', 'generation_exhausted',
  'output_manual_retry_required', 'output_exhausted',
  'blocked_topology', 'needs_reconciliation',
];
const RECOVERY_OUTPUT_STATES = ['manual_retry_required', 'exhausted', 'needs_reconciliation'];
const UNSAFE_CANARY_DELIVERY_STATES = new Set([
  'generating', 'delivering', 'generation_exhausted', 'output_manual_retry_required',
  'output_exhausted', 'blocked_topology', 'needs_reconciliation',
]);
const UNSAFE_CANARY_OUTPUT_STATES = new Set([
  'attempting', 'manual_retry_required', 'exhausted', 'needs_reconciliation',
]);

export class ChannelDeliveryCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.store = new SQLiteDeliveryStore(ctx.storage);
    this._alarmTail = Promise.resolve();
    this.ctx.blockConcurrencyWhile(async () => {
      await this.store.initialize();
    });
  }

  async acceptRequest(input) {
    requireActiveRuntime(this.env);
    const request = validateDeliveryRequest(input);
    await this._ensureIdentity(request.channelId);
    let destinationFingerprint = null;
    if (request.triggerType === 'canary') {
      const channel = this._findChannel(request.channelId);
      const outputs = channel.outputs ?? [channel.output];
      if (outputs.length !== 1 || outputs[0]?.id !== 'telegram' || outputs[0]?.supportsSingleMutation !== true) {
        throw new Error('Canary requires exactly one single-mutation Telegram output');
      }
      await this._assertMigrationReady(channel);
      destinationFingerprint = (await buildOutputTopology(outputs)).fingerprint;
    }
    const operatorActionId = request.operatorId
      ? await opaqueId('operator-action', request.channelId, request.triggerType, request.requestId)
      : null;
    const reasonHash = request.reason
      ? await opaqueId('operator-reason', request.channelId, request.reason)
      : null;
    const duplicateRiskAckHash = request.operatorId
      ? await opaqueId('duplicate-risk-ack', request.channelId, request.requestId, request.duplicateRiskAccepted)
      : null;
    const fingerprint = await opaqueId('request-payload', request.channelId, stableJson({
      requestId: request.requestId,
      triggerType: request.triggerType,
      force: request.force,
      operatorForce: request.operatorForce,
      confirmPausedMutation: request.confirmPausedMutation,
      singleMutation: request.singleMutation,
      limit: request.limit,
      operatorId: request.operatorId,
      reasonHash,
      duplicateRiskAckHash,
      destinationFingerprint,
    }));
    const now = new Date().toISOString();
    const accepted = await this.store.transact(tx => {
      const existing = tx.get('requests', request.requestId);
      if (existing) {
        if (existing.payloadFingerprint !== fingerprint) throw new Error('Request id conflicts with different payload');
        return { created: false, request: existing };
      }
      const activeCount = tx.count('requests', {
        channelId: request.channelId,
        state: ['accepted', 'running'],
      });
      if (activeCount >= 1_000) throw new Error('Active request limit reached');
      const channel = tx.get('channel_state', request.channelId);
      if (request.triggerType === 'canary') {
        assertCanaryPreconditions(tx, request, channel, activeCount);
      }
      const pausedSkip = channel?.paused && request.confirmPausedMutation !== true;
      const pausedState = ['scheduled', 'alarm'].includes(request.triggerType) ? 'completed' : 'blocked';
      const pausedReason = pausedState === 'completed' ? 'skipped_paused' : 'blocked_paused';
      const record = tx.put('requests', request.requestId, {
        requestId: request.requestId,
        channelId: request.channelId,
        triggerType: request.triggerType,
        force: request.force,
        operatorForce: request.operatorForce,
        confirmPausedMutation: request.confirmPausedMutation,
        singleMutation: request.singleMutation,
        limit: request.limit,
        destinationFingerprint,
        operatorActionId,
        requestedAt: request.requestedAt,
        payloadFingerprint: fingerprint,
        state: pausedSkip ? pausedState : 'accepted',
        outcome: pausedSkip ? 'skipped' : null,
        reason: pausedSkip ? pausedReason : null,
        result: pausedSkip ? { status: 'skipped', reason: pausedReason } : null,
        runAttemptId: null,
        startedAt: null,
        deadlineAt: null,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
      if (operatorActionId) {
        tx.put('operator_actions', operatorActionId, {
          actionId: operatorActionId,
          action: request.triggerType,
          channelId: request.channelId,
          requestId: request.requestId,
          operatorId: request.operatorId,
          reasonHash,
          duplicateRiskAckHash,
          duplicateRiskAccepted: request.duplicateRiskAccepted,
          payloadFingerprint: fingerprint,
          state: 'minimized',
          result: { status: record.state, requestId: request.requestId },
          createdAt: now,
          updatedAt: now,
        }, { expectedVersion: 0 });
      }
      const identity = tx.get('coordinator_meta', 'identity');
      if (!identity || identity.channelId !== request.channelId) {
        throw new Error('Coordinator identity disappeared before request acceptance');
      }
      tx.put('coordinator_meta', 'identity', {
        ...identity,
        lastRequestId: record.requestId,
        updatedAt: now,
      }, { expectedVersion: identity.version });
      return { created: true, request: record };
    });
    if (accepted.request.state === 'accepted') {
      await this._setEarliestRepairAlarm(Date.now() + attemptTimeout(this.env));
      this.ctx.waitUntil(this.runRequest(request.requestId));
    }
    return publicRequest(accepted.request);
  }

  async runRequest(requestId) {
    requireActiveRuntime(this.env);
    const runAttemptId = crypto.randomUUID();
    const startedAt = new Date();
    let claimed = false;
    const request = await this.store.transact(tx => {
      const current = tx.get('requests', requestId);
      if (!current) throw new Error('Request not found');
      if (['completed', 'blocked'].includes(current.state)) return current;
      if (current.state === 'running') return current;
      claimed = true;
      return tx.put('requests', requestId, {
        ...current,
        state: 'running',
        runAttemptId,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + requestTimeout(this.env)).toISOString(),
        updatedAt: startedAt.toISOString(),
      }, { expectedVersion: current.version });
    });
    if (!claimed || ['completed', 'blocked'].includes(request.state)) return publicRequest(request);

    let result;
    try {
      const channel = this._findChannel(request.channelId);
      const engine = this._buildEngine(channel);
      const options = {
        requestId: request.requestId,
        requestedAt: request.requestedAt,
        force: request.force,
        idempotencyKey: request.requestId,
        operatorForce: request.operatorForce,
        confirmPausedMutation: request.confirmPausedMutation,
        singleMutation: request.singleMutation,
        articleLimit: request.limit,
      };
      result = channel.mode === 'drip'
        ? await engine.runDrip({ ...options, batchSize: request.singleMutation ? 1 : channel.batchSize || 5, delayMs: channel.delayMs ?? 0 })
        : await engine.run(options);
    } catch (error) {
      result = { status: 'failed', reason: 'coordinator_error', error: sanitizeError(error) };
    }

    const projected = projectRunResult(result);
    const completed = await this.store.transact(tx => {
      const current = tx.get('requests', requestId);
      if (!current) throw new Error('Request disappeared before completion');
      if (['completed', 'blocked'].includes(current.state)) return current;
      if (current.state !== 'running' || current.runAttemptId !== runAttemptId) return current;
      const blocked = ['ambiguous', 'failed'].includes(projected.status) && isBlockingReason(projected.reason);
      const completedRequest = tx.put('requests', requestId, {
        ...current,
        state: blocked ? 'blocked' : 'completed',
        outcome: projected.status,
        reason: projected.reason ?? null,
        result: projected,
        runAttemptId: null,
        deadlineAt: null,
        updatedAt: new Date().toISOString(),
      }, { expectedVersion: current.version });
      if (current.operatorActionId) {
        const action = tx.get('operator_actions', current.operatorActionId);
        if (!action) throw new Error('Operator request audit record is missing');
        tx.put('operator_actions', current.operatorActionId, {
          ...action,
          result: {
            status: completedRequest.state,
            outcome: projected.status,
            requestId: current.requestId,
            deliveryId: projected.deliveryId,
          },
          updatedAt: completedRequest.updatedAt,
        }, { expectedVersion: action.version });
      }
      if (
        current.triggerType === 'canary'
        && projected.status === 'success'
        && projected.deliveryState === 'succeeded'
        && projected.counts.articles === 1
      ) {
        const channel = tx.get('channel_state', current.channelId);
        if (!channel?.paused || channel.mutationState !== 'free') {
          throw new Error('Successful canary did not finish in a paused, mutation-free channel');
        }
        const marker = tx.get('canary_state', current.channelId);
        tx.put('canary_state', current.channelId, {
          channelId: current.channelId,
          requestId: current.requestId,
          deliveryId: projected.deliveryId,
          destinationFingerprint: current.destinationFingerprint,
          channelVersion: channel.version,
          state: 'succeeded',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, { expectedVersion: marker?.version ?? 0 });
      }
      return completedRequest;
    });
    await this._machine(completed.channelId).compactHistory();
    await this._ensureRepairAlarm();
    return publicRequest(completed);
  }

  async getRequest({ channelId, requestId }) {
    await this._ensureIdentity(channelId);
    if (runtimeMode(this.env) === 'active') await this._ensureRepairAlarm();
    const request = await this.store.get('requests', requiredString(requestId, 'requestId'));
    return request ? publicRequest(request) : null;
  }

  async getStatus({ channelId, limit = 50, cursor = 0, targetCursor = 0 } = {}) {
    await this._ensureIdentity(channelId);
    if (runtimeMode(this.env) === 'active') await this._ensureRepairAlarm();
    const boundedLimit = Math.min(100, positiveInteger(limit, 'limit'));
    const offset = nonNegativeInteger(cursor, 'cursor');
    const targetOffset = nonNegativeInteger(targetCursor, 'targetCursor');
    const [channel, identity] = await Promise.all([
      this.store.get('channel_state', channelId),
      this.store.get('coordinator_meta', 'identity'),
    ]);
    const [
      requestCount,
      requests,
      latestRequest,
      pointedRequest,
      activeDeliveryCount,
      recoveryDeliveryCounts,
      unresolvedOutputCounts,
      maintenanceDeadLetterCount,
    ] = await Promise.all([
      this.store.count('requests', { channelId }),
      this.store.query('requests', { channelId }, {
        orderBy: 'createdAt', direction: 'desc', limit: boundedLimit, offset,
      }),
      this.store.query('requests', { channelId }, {
        orderBy: 'createdAt', direction: 'desc', limit: 1,
      }).then(values => values[0] ?? null),
      identity?.lastRequestId ? this.store.get('requests', identity.lastRequestId) : null,
      this.store.count('deliveries', { channelId, state: NON_TERMINAL_DELIVERY_STATES }),
      Promise.all(RECOVERY_DELIVERY_STATES.map(state => (
        this.store.count('deliveries', { channelId, state })
      ))),
      Promise.all(RECOVERY_OUTPUT_STATES.map(state => (
        this.store.count('delivery_outputs', { state })
      ))),
      this.store.count('maintenance_outbox', { channelId, state: 'dead_letter' }),
    ]);
    const recoveryDeliveryCount = recoveryDeliveryCounts.reduce((total, count) => total + count, 0);
    const unresolvedOutputCount = unresolvedOutputCounts.reduce((total, count) => total + count, 0);
    const ambiguousOutputCount = unresolvedOutputCounts[RECOVERY_OUTPUT_STATES.indexOf('needs_reconciliation')] ?? 0;
    const unresolvedTargetCount = recoveryDeliveryCount + unresolvedOutputCount + maintenanceDeadLetterCount;
    const [unresolvedTargets, queue] = await Promise.all([
      queryUnresolvedTargetPage(this.store, channelId, {
        limit: boundedLimit,
        offset: targetOffset,
        deliveryCounts: recoveryDeliveryCounts,
        outputCounts: unresolvedOutputCounts,
        maintenanceCount: maintenanceDeadLetterCount,
      }),
      this._queueSummary(channelId),
    ]);
    const lastRequest = pointedRequest ?? latestRequest;
    const sourceHealth = lastRequest?.result?.sourceHealth;
    return {
      runtimeMode: runtimeMode(this.env),
      channel: publicChannel(channel),
      lastRequest: lastRequest ? publicRequest(lastRequest) : null,
      sourceWarning: sourceHealth?.degraded ? {
        degraded: true,
        healthy: Number(sourceHealth.healthy ?? 0),
        failed: Number(sourceHealth.failed ?? 0),
        unknown: Number(sourceHealth.unknown ?? 0),
      } : null,
      queue: {
        publishingDay: queue.publishingDay,
        total: queue.total,
        remaining: queue.remaining,
        blocked: queue.blocked,
      },
      counts: {
        requests: requestCount,
        activeDeliveries: activeDeliveryCount,
        ambiguousOutputs: ambiguousOutputCount,
        maintenanceDeadLetters: maintenanceDeadLetterCount,
        unresolvedTargets: unresolvedTargetCount,
      },
      requests: requests.map(publicRequest),
      nextCursor: offset + boundedLimit < requestCount ? offset + boundedLimit : null,
      unresolvedTargets,
      nextTargetCursor: targetOffset + boundedLimit < unresolvedTargetCount
        ? targetOffset + boundedLimit
        : null,
    };
  }

  async getQueue({ channelId, publishingDay, limit = 50, cursor = 0 } = {}) {
    requireActiveRuntime(this.env);
    await this._ensureIdentity(channelId);
    const engine = this._buildEngine(this._findChannel(channelId));
    const queue = await engine.getQueue({ publishingDay });
    const boundedLimit = Math.min(100, positiveInteger(limit, 'limit'));
    const offset = nonNegativeInteger(cursor, 'cursor');
    const records = Array.isArray(queue.articles) ? queue.articles : [];
    return {
      date: queue.date,
      counts: {
        total: records.length,
        remaining: Number(queue.remaining ?? 0),
        blocked: Number(queue.blocked ?? 0),
      },
      items: records.slice(offset, offset + boundedLimit).map(record => ({
        itemId: record.deliveryId,
        state: record.state,
      })),
      nextCursor: offset + boundedLimit < records.length ? offset + boundedLimit : null,
    };
  }

  async _queueSummary(channelId) {
    const batch = (await this.store.query('day_batches', { channelId }, {
      orderBy: 'createdAt', direction: 'desc', limit: 1,
    }))[0];
    if (!batch) return { publishingDay: null, total: 0, remaining: 0, blocked: 0 };
    const { total, remaining, blocked } = await this.store.summarizeBatch(batch.batchId);
    return {
      publishingDay: batch.publishingDay,
      total,
      remaining,
      blocked,
    };
  }

  async preview({ channelId, mode } = {}) {
    requireActiveRuntime(this.env);
    await this._ensureIdentity(channelId);
    const channel = this._findChannel(channelId);
    const engine = this._buildEngine(channel);
    const result = (mode ?? channel.mode) === 'drip'
      ? await engine.runDrip({ dryRun: true, batchSize: 1 })
      : await engine.run({ dryRun: true });
    return projectPreview(result);
  }

  async control(input) {
    const action = validateControl(input);
    requireControlRuntime(this.env, action.action);
    await this._ensureIdentity(action.channelId);
    const machine = this._machine(action.channelId);
    const operatorActionId = await opaqueId('operator-action', action.channelId, action.idempotencyKey);
    if (await this.store.get('operator_actions', operatorActionId)) {
      if (action.action === 'migrate-legacy') return this._migrateLegacy(action);
      const replay = action.action === 'pause' || action.action === 'resume'
        ? await machine.setPaused(action.action === 'pause', action)
        : await machine.reconcile(action);
      if (
        replay.status === 'claimed'
        && ['retry-generation', 'retry-output', 'retry-maintenance'].includes(action.action)
      ) await this._ensureRepairAlarm();
      return projectControlResult(replay, action.requestId);
    }
    if (action.action === 'pause' || action.action === 'resume') {
      if (action.action === 'resume') {
        const channel = this._findChannel(action.channelId);
        await machine.recoverStaleAttempts();
        const liveAttempts = [
          ...await this.store.query('attempts', { channelId: action.channelId, state: 'attempting' }),
          ...await this.store.query('attempts', { channelId: null, state: 'attempting' }),
        ];
        if (liveAttempts.length > 0) throw new Error('Coordinator recovery is still in progress');
        await this._assertMigrationReady(channel);
        await this._assertCanaryReady(channel, action.expectedVersion);
      }
      const result = await machine.setPaused(action.action === 'pause', action);
      if (action.action === 'pause') await this._coalescePausedRequests(action.channelId);
      else await this._ensureRepairAlarm();
      return projectControlResult(result, action.requestId);
    }
    if ([
      'retry-generation', 'retry-output', 'restore-topology',
      'confirm-delivered', 'abandon', 'retry-maintenance',
    ].includes(action.action)) {
      let retryContext = null;
      if (['retry-generation', 'retry-output'].includes(action.action)) {
        const channel = this._findChannel(action.channelId);
        const outputs = channel.outputs ?? [channel.output];
        const topology = await buildOutputTopology(outputs);
        const delivery = await machine.getDelivery(action.deliveryId);
        if (!delivery || delivery.channelId !== action.channelId) throw new Error('Recovery delivery target was not found');
        if (delivery.topologyFingerprint !== topology.fingerprint || delivery.state === 'blocked_topology') {
          throw new Error('Output topology changed before operator retry');
        }
        if (action.action === 'retry-generation' && typeof channel.ai?.summarize !== 'function') {
          throw new Error('Configured AI provider is unavailable for generation retry');
        }
        retryContext = { channel, outputs, topology, delivery };
        if (action.action === 'retry-output') {
          const storedOutput = await machine.getOutput(action.deliveryId, action.outputKey);
          const configuredTarget = storedOutput && topology.outputs[storedOutput.ordinal];
          const output = storedOutput && outputs[storedOutput.ordinal];
          if (!storedOutput
            || !output
            || configuredTarget?.outputKey !== storedOutput.outputKey
            || configuredTarget.providerId !== storedOutput.providerId
            || output.id !== storedOutput.providerId) {
            throw new Error('Output topology changed before operator retry');
          }
        }
      }
      if (action.action === 'restore-topology') {
        const channel = this._findChannel(action.channelId);
        const topology = await buildOutputTopology(channel.outputs ?? [channel.output]);
        const delivery = await machine.getDelivery(action.deliveryId);
        if (!delivery || delivery.channelId !== action.channelId) throw new Error('Recovery delivery target was not found');
        if (delivery.topologyFingerprint !== topology.fingerprint) {
          throw new Error('Configured output topology has not been restored');
        }
        action.topologyFingerprint = topology.fingerprint;
      }
      const result = await machine.reconcile(action);
      if (action.action === 'confirm-delivered') await this._ensureRepairAlarm();
      if (result.replayed) return projectControlResult(result, action.requestId);
      if (result.status !== 'claimed') return projectControlResult(result, action.requestId);
      if (['retry-generation', 'retry-output'].includes(action.action)) {
        await this._ensureRepairAlarm();
        this.ctx.waitUntil(this._executeClaimedControl(action, result, retryContext));
        return projectControlResult(result, action.requestId);
      }
      if (action.action === 'retry-maintenance') {
        await this._ensureRepairAlarm();
        return this._executeClaimedControl(action, result, retryContext);
      }
      return projectControlResult(result, action.requestId);
    }
    if (action.action === 'migrate-legacy') return this._migrateLegacy(action);
    throw new Error(`Unsupported control action: ${action.action}`);
  }

  async _executeClaimedControl(action, result, retryContext) {
    const machine = this._machine(action.channelId);
    try {
      if (action.action === 'retry-generation') {
        const { channel } = retryContext;
        try {
          const generated = await withCoordinatorTimeout(signal => channel.ai.summarize(
            result.articles,
            {
              language: 'vi',
              style: channel.prompt?.style,
              audience: channel.prompt?.audience,
              platform: channel.prompt?.platform,
              deliveryMode: result.delivery.mode,
              requestId: action.requestId,
              attemptId: result.attempt.attemptId,
              articles: result.articles,
              signal,
            },
          ), externalAttemptTimeout(this.env), `AI ${channel.ai.id}`);
          const committed = await machine.commitGeneration(result.attempt.attemptId, { content: generated.text });
          return projectControlResult({ status: committed.state, delivery: committed }, action.requestId);
        } catch (error) {
          const failed = await machine.failGeneration(result.attempt.attemptId, error, { retryDisposition: 'never' });
          return projectControlResult({ status: failed.state, delivery: failed }, action.requestId);
        }
      }
      if (action.action === 'retry-maintenance') {
        const cache = new PrefixedCache(
          new CloudflareKVCache(this.env.NEWS_CACHE, { required: true }),
          `news:${action.channelId}`,
        );
        try {
          await cache.set(result.outbox.targetKey, result.outbox.targetValue, result.outbox.kind === 'legacy_digest' ? 30 * 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000);
          const committed = await machine.commitMaintenance(result.outbox.outboxId, { success: true });
          return projectControlResult({ status: committed.state, outbox: committed }, action.requestId);
        } catch (error) {
          const committed = await machine.commitMaintenance(result.outbox.outboxId, { success: false, error });
          return projectControlResult({ status: committed.state, outbox: committed }, action.requestId);
        }
      }
      if (action.action !== 'retry-output') return projectControlResult(result, action.requestId);
      const { outputs, topology } = retryContext;
      const output = outputs[result.output.ordinal];
      const configuredTarget = topology.outputs[result.output.ordinal];
      if (!output
        || output.id !== result.output.providerId
        || configuredTarget?.outputKey !== result.output.outputKey
        || configuredTarget.providerId !== result.output.providerId) {
        throw new Error('Output topology changed during operator retry');
      }
      let normalized;
      try {
        normalized = normalizeSendResult(await withCoordinatorTimeout(signal => output.send(
          result.delivery.singleMutation === true ? result.content : fitToOutput(result.content, output),
          {
            articles: result.delivery.articleSnapshot,
            article: result.delivery.mode === 'drip' ? result.delivery.articleSnapshot[0] : undefined,
            deliveryId: action.deliveryId,
            attemptId: result.attempt.attemptId,
            singleMutation: result.delivery.singleMutation === true,
            signal,
          },
        ), externalAttemptTimeout(this.env), `Output ${output.id}`));
      } catch (error) {
        normalized = normalizeSendResult(null, { error });
      }
      const committed = await machine.commitOutput(result.attempt.attemptId, normalized);
      return projectControlResult({
        status: committed.delivery.state,
        delivery: committed.delivery,
        result: committed.result,
      }, action.requestId);
    } finally {
      await this._ensureRepairAlarm();
    }
  }

  async alarm() {
    if (runtimeMode(this.env) !== 'active') return;
    const identity = await this.store.get('coordinator_meta', 'identity');
    if (!identity?.channelId) return;
    const machine = this._machine(identity.channelId);
    await machine.recoverStaleAttempts();
    await this._drainMaintenance(machine);
    const now = new Date();
    await this.store.transact(tx => {
      for (const request of tx.query('requests', {
        channelId: identity.channelId,
        state: 'running',
      }).filter(value => (
        value.triggerType !== 'operator_retry'
        && value.deadlineAt
        && new Date(value.deadlineAt) <= now
      ))) {
        tx.put('requests', request.requestId, {
          ...request,
          state: 'accepted',
          runAttemptId: null,
          deadlineAt: null,
          recoveryCount: Number(request.recoveryCount ?? 0) + 1,
          updatedAt: now.toISOString(),
        }, { expectedVersion: request.version });
      }
    });
    const accepted = (await this.store.query('requests', {
      channelId: identity.channelId,
      state: 'accepted',
    }, { orderBy: 'createdAt', direction: 'asc', limit: 10 }))
      .filter(request => request.triggerType !== 'operator_retry');
    for (const request of accepted) await this.runRequest(request.requestId);
    const channelState = await machine.getChannelState();
    const retryable = channelState?.paused || channelState?.mutationState !== 'free'
      ? []
      : await this.store.query('deliveries', {
        channelId: identity.channelId,
        state: [...ACTIVE_DELIVERY_STATES],
      }, { orderBy: 'createdAt', direction: 'asc', limit: 10 });
    for (const delivery of retryable) {
      const syntheticId = await opaqueId('alarm-resume', delivery.deliveryId, delivery.updatedAt);
      await this.acceptRequest({
        requestId: syntheticId,
        channelId: identity.channelId,
        triggerType: 'alarm',
        force: false,
        requestedAt: new Date().toISOString(),
      });
    }
    await this._ensureRepairAlarm();
  }

  _buildEngine(channel) {
    const rawCache = new CloudflareKVCache(this.env.NEWS_CACHE, { required: true });
    const cache = new PrefixedCache(rawCache, `news:${channel.id}`);
    const engine = new NewsEngine();
    for (const source of channel.sources) engine.addSource(source);
    if (channel.ai) engine.useAI(channel.ai);
    for (const output of channel.outputs ?? [channel.output]) engine.addOutput(output);
    engine.useCache(cache);
    engine.useDeliveryStore(this.store);
    engine.use(createScoringMiddleware({ maxArticles: channel.maxArticles || 12 }));
    engine.use(createSemanticDedupMiddleware());
    engine.configure({
      channelId: channel.id,
      timezone: channel.timezone || 'UTC',
      maxArticlesPerSource: channel.maxArticlesPerSource || 3,
      concurrency: channel.concurrency || 5,
      attemptTimeoutMs: attemptTimeout(this.env),
      ...channel.prompt,
    });
    return engine;
  }

  _findChannel(channelId) {
    const channels = defineChannels(this.env);
    const channel = channels.find(value => value.id === channelId);
    if (!channel) throw new Error('Configured channel was not found');
    return channel;
  }

  _machine(channelId) {
    return new DeliveryStateMachine({
      store: this.store,
      channelId,
      attemptTimeoutMs: attemptTimeout(this.env),
    });
  }

  async _ensureIdentity(channelId) {
    const boundedChannelId = requiredString(channelId, 'channelId', 100);
    const now = new Date().toISOString();
    return this.store.transact(tx => {
      const identity = tx.get('coordinator_meta', 'identity');
      if (identity && identity.channelId !== boundedChannelId) throw new Error('Coordinator identity mismatch');
      if (!identity) {
        tx.put('coordinator_meta', 'identity', {
          channelId: boundedChannelId,
          createdAt: now,
          updatedAt: now,
        }, { expectedVersion: 0 });
      }
      const channel = tx.get('channel_state', boundedChannelId);
      if (!channel) {
        tx.put('channel_state', boundedChannelId, {
          channelId: boundedChannelId,
          mutationState: 'free',
          activeOutputAttemptId: null,
          paused: String(this.env.NEWS_DEFAULT_PAUSED ?? 'true') !== 'false',
          createdAt: now,
          updatedAt: now,
        }, { expectedVersion: 0 });
      }
      return boundedChannelId;
    });
  }

  async _coalescePausedRequests(channelId) {
    const now = new Date().toISOString();
    return this.store.transact(tx => {
      let updated = 0;
      for (const request of tx.query('requests', { channelId, state: 'accepted' })) {
        const state = ['scheduled', 'alarm'].includes(request.triggerType) ? 'completed' : 'blocked';
        const reason = state === 'completed' ? 'skipped_paused' : 'blocked_paused';
        tx.put('requests', request.requestId, {
          ...request,
          state,
          outcome: 'skipped',
          reason,
          result: { status: 'skipped', reason },
          updatedAt: now,
        }, { expectedVersion: request.version });
        updated += 1;
      }
      return updated;
    });
  }

  async _ensureRepairAlarm() {
    const identity = await this.store.get('coordinator_meta', 'identity');
    const channel = identity?.channelId ? await this.store.get('channel_state', identity.channelId) : null;
    const channelId = identity?.channelId;
    if (!channelId) return;
    const attempts = [
      ...await this.store.query('attempts', { channelId, state: 'attempting' }, {
        orderBy: 'deadlineAt',
        limit: 1,
      }),
      ...await this.store.query('attempts', { channelId: null, state: 'attempting' }, {
        orderBy: 'deadlineAt',
        limit: 1,
      }),
    ];
    const accepted = await this.store.query('requests', { channelId, state: 'accepted' }, { limit: 1 });
    const running = await this.store.query('requests', { channelId, state: 'running' }, {
      orderBy: 'deadlineAt',
      limit: 1,
    });
    const retryable = channel?.paused || channel?.mutationState !== 'free'
      ? []
      : await this.store.query('deliveries', { channelId, state: [...ACTIVE_DELIVERY_STATES] }, { limit: 1 });
    const pausedMaintenance = channel?.paused
      ? await this.store.findPausedMaintenance(channelId)
      : null;
    const maintenance = channel?.paused
      ? (pausedMaintenance ? [pausedMaintenance] : [])
      : [await this.store.findMaintenance(channelId)].filter(Boolean);
    if (attempts.length || retryable.length || accepted.length || running.length || maintenance.length) {
      const deadlines = [
        ...attempts.map(value => Date.parse(value.deadlineAt)),
        ...running.map(value => Date.parse(value.deadlineAt)),
        ...maintenance.map(value => Date.parse(value.deadlineAt ?? value.nextAttemptAt)),
      ].filter(Number.isFinite);
      const next = deadlines.length ? Math.min(...deadlines) : Date.now() + 30_000;
      await this._setEarliestRepairAlarm(next);
    }
  }

  async _setEarliestRepairAlarm(candidate) {
    const operation = this._alarmTail.then(async () => {
      const next = Math.max(Date.now() + 1_000, Number(candidate));
      if (!Number.isFinite(next)) throw new Error('Repair alarm candidate is invalid');
      const current = await this.ctx.storage.getAlarm();
      const currentTimestamp = current === null ? null : Number(current);
      if (currentTimestamp === null || !Number.isFinite(currentTimestamp) || next < currentTimestamp) {
        await this.ctx.storage.setAlarm(next);
        return next;
      }
      return currentTimestamp;
    });
    this._alarmTail = operation.catch(() => {});
    return operation;
  }

  async _drainMaintenance(machine, limit = 25) {
    const cache = new PrefixedCache(
      new CloudflareKVCache(this.env.NEWS_CACHE, { required: true }),
      `news:${machine.channelId}`,
    );
    for (let index = 0; index < limit; index++) {
      const row = await machine.claimMaintenance();
      if (!row) break;
      try {
        await cache.set(
          row.targetKey,
          row.targetValue,
          row.kind === 'legacy_digest' ? 30 * 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000,
        );
        await machine.commitMaintenance(row.outboxId, { success: true });
      } catch (error) {
        await machine.commitMaintenance(row.outboxId, { success: false, error });
      }
    }
  }

  async _migrateLegacy(action) {
    const operatorActionId = await opaqueId('operator-action', action.channelId, action.idempotencyKey);
    const reasonHash = await opaqueId('operator-reason', action.channelId, action.reason);
    const payloadFingerprint = await opaqueId(
      'operator-action-payload',
      action.action,
      action.expectedVersion,
      action.operatorId,
      reasonHash,
    );
    const existingAction = await this.store.get('operator_actions', operatorActionId);
    if (existingAction) {
      if (existingAction.payloadFingerprint !== payloadFingerprint) {
        throw new Error('Idempotency key conflicts with a different operator action');
      }
      return projectMigrationResult(existingAction.result);
    }
    const channel = await this.store.get('channel_state', action.channelId);
    if (!channel?.paused) throw new Error('Legacy migration requires a paused coordinator');
    if (!this.env.NEWS_CACHE?.list || !this.env.NEWS_CACHE?.get) throw new Error('Legacy migration requires NEWS_CACHE');
    const migrationId = await opaqueId('legacy-migration-id', action.channelId, 'v2');
    const configuredChannel = this._findChannel(action.channelId);
    const outputs = configuredChannel.outputs ?? [configuredChannel.output];
    const topology = await buildOutputTopology(outputs);
    const committedMigration = await this.store.get('migration_state', migrationId);
    if (committedMigration) {
      if (committedMigration.destinationFingerprint !== topology.fingerprint) {
        throw new Error('Legacy destination fingerprint changed');
      }
      return this.store.transact(tx => {
        const replay = tx.get('operator_actions', operatorActionId);
        if (replay) {
          if (replay.payloadFingerprint !== payloadFingerprint) {
            throw new Error('Idempotency key conflicts with a different operator action');
          }
          return projectMigrationResult(replay.result);
        }
        const currentChannel = tx.get('channel_state', action.channelId);
        if (!currentChannel?.paused) throw new Error('Legacy migration requires a paused coordinator');
        if (currentChannel.version !== action.expectedVersion) throw new Error('Legacy migration version conflict');
        const currentMigration = tx.get('migration_state', migrationId);
        if (!currentMigration || currentMigration.destinationFingerprint !== topology.fingerprint) {
          throw new Error('Committed legacy migration changed before audit');
        }
        const result = projectMigrationResult(currentMigration);
        putMigrationOperatorAction(tx, {
          action,
          operatorActionId,
          reasonHash,
          payloadFingerprint,
          migrationId,
          result,
          now: new Date().toISOString(),
        });
        return result;
      });
    }
    const prefix = `news:${action.channelId}:`;
    const keys = [];
    let cursor;
    do {
      const page = await this.env.NEWS_CACHE.list({ prefix, cursor, limit: 100 });
      for (const entry of page.keys) {
        const suffix = entry.name.slice(prefix.length);
        if (/^(seen:(?!v2:)|digest:|drip:queue:)/.test(suffix) && !/token|oauth|refresh-lock/i.test(suffix)) {
          keys.push({ name: entry.name, expiration: entry.expiration });
        }
        if (keys.length > 1_000) throw new Error('Legacy migration key limit exceeded');
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    const snapshots = [];
    for (const entry of keys.sort((left, right) => left.name.localeCompare(right.name))) {
      const value = await this.env.NEWS_CACHE.get(entry.name);
      if (value && new TextEncoder().encode(value).byteLength > 256 * 1024) throw new Error('Legacy migration value is oversized');
      snapshots.push({
        key: entry.name,
        value,
        valueChecksum: await opaqueId('legacy-value', value ?? ''),
        expiresAt: Number.isFinite(entry.expiration) ? new Date(entry.expiration * 1_000).toISOString() : null,
      });
    }
    const fingerprint = await opaqueId('legacy-migration', stableJson(snapshots.map(snapshot => ({
      suffix: snapshot.key.slice(prefix.length),
      valueChecksum: snapshot.valueChecksum,
      expiresAt: snapshot.expiresAt,
    }))));
    const now = new Date().toISOString();
    const prepared = await prepareLegacyImport({
      channelId: action.channelId,
      prefix,
      snapshots,
      topology,
      fingerprint,
      importedAt: now,
    });
    return this.store.transact(tx => {
      const existing = tx.get('migration_state', migrationId);
      if (existing) {
        if (existing.sourceFingerprint !== fingerprint) throw new Error('Legacy migration fingerprint changed');
        if (existing.destinationFingerprint !== topology.fingerprint) throw new Error('Legacy destination fingerprint changed');
        const result = projectMigrationResult(existing);
        putMigrationOperatorAction(tx, {
          action,
          operatorActionId,
          reasonHash,
          payloadFingerprint,
          migrationId,
          result,
          now,
        });
        return result;
      }
      const currentChannel = tx.get('channel_state', action.channelId);
      if (!currentChannel?.paused) throw new Error('Legacy migration requires a paused coordinator');
      if (currentChannel.version !== action.expectedVersion) throw new Error('Legacy migration version conflict');

      for (const seen of prepared.seen) {
        if (!tx.get('legacy_seen_compat', seen.compatId)) {
          tx.put('legacy_seen_compat', seen.compatId, {
            compatId: seen.compatId,
            channelId: action.channelId,
            legacyHash: seen.legacyHash,
            valueChecksum: seen.valueChecksum,
            expiresAt: seen.expiresAt,
            importedAt: now,
          }, { expectedVersion: 0 });
        }
      }
      for (const digest of prepared.digests) {
        if (!tx.get('legacy_digest_compat', digest.compatId)) {
          tx.put('legacy_digest_compat', digest.compatId, {
            compatId: digest.compatId,
            channelId: action.channelId,
            publishingDay: digest.publishingDay,
            valueChecksum: digest.valueChecksum,
            importedAt: now,
          }, { expectedVersion: 0 });
        }
      }

      let importedQueueItems = 0;
      let duplicateQueueItems = 0;
      for (const queue of prepared.queues) {
        let batch = tx.get('day_batches', queue.batchId);
        if (!batch) {
          batch = tx.put('day_batches', queue.batchId, {
            batchId: queue.batchId,
            channelId: action.channelId,
            publishingDay: queue.publishingDay,
            mode: 'drip',
            sourceTopologyFingerprint: queue.sourceTopologyFingerprint,
            sourceHealth: {
              total: 0,
              healthy: 0,
              failed: 0,
              unknown: 0,
              degraded: false,
              exhaustionEligible: false,
              legacyImported: true,
            },
            refillCount: 0,
            refillFailureCount: 0,
            activeRefillClaimToken: null,
            refillDeadlineAt: null,
            nextRefillAt: null,
            exhausted: false,
            createdAt: now,
            updatedAt: now,
          }, { expectedVersion: 0 });
        }
        const batchItems = tx.query('batch_items', { batchId: queue.batchId }, {
          orderBy: 'createdAt', direction: 'asc', limit: 1_000,
        });
        const knownDeliveryIds = new Set(batchItems.map(item => item.deliveryId));
        let position = batchItems.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1;
        for (const item of queue.items) {
          const ledger = tx.get('articles', item.articleHash);
          if (ledger?.terminalState || ledger?.safetySuppressed) {
            duplicateQueueItems += 1;
            continue;
          }
          const deliveryId = ledger?.activeDeliveryId ?? item.deliveryId;
          if (!ledger?.activeDeliveryId) {
            if (!tx.get('deliveries', item.deliveryId)) {
              tx.put('deliveries', item.deliveryId, {
                deliveryId: item.deliveryId,
                channelId: action.channelId,
                requestId: item.requestId,
                mode: 'drip',
                publishingDay: queue.publishingDay,
                forceKind: null,
                singleMutation: false,
                state: 'pending_generation',
                articleHashes: [item.articleHash],
                articleSnapshot: [item.article],
                generatedContent: null,
                contentChecksum: null,
                outputTopology: topology.outputs,
                topologyFingerprint: topology.fingerprint,
                outputSummary: {
                  total: topology.outputs.length,
                  succeeded: 0,
                  unresolved: topology.outputs.length,
                  ambiguous: 0,
                },
                generationAttemptCount: 0,
                authorizedRetryRequestId: null,
                legacyImported: true,
                createdAt: now,
                updatedAt: now,
              }, { expectedVersion: 0 });
              for (const output of topology.outputs) {
                tx.put('delivery_outputs', `${item.deliveryId}:${output.outputKey}`, {
                  deliveryId: item.deliveryId,
                  outputKey: output.outputKey,
                  providerId: output.providerId,
                  ordinal: output.ordinal,
                  state: 'pending',
                  attemptCount: 0,
                  retryDisposition: null,
                  nextAttemptAt: null,
                  authorizedRetryRequestId: null,
                  successfulMessageIds: [],
                  partialMutation: null,
                  sanitizedError: null,
                  activeAttemptId: null,
                  updatedAt: now,
                }, { expectedVersion: 0 });
              }
            }
            tx.put('articles', item.articleHash, {
              articleHash: item.articleHash,
              sourceKey: item.article.source,
              firstSeenAt: now,
              activeDeliveryId: item.deliveryId,
              terminalState: null,
              safetySuppressed: false,
              lastPublishingDay: queue.publishingDay,
              legacyImported: true,
              updatedAt: now,
            }, { expectedVersion: ledger?.version ?? 0 });
          }
          if (!knownDeliveryIds.has(deliveryId)) {
            const itemId = `${queue.batchId}:${String(position).padStart(6, '0')}`;
            tx.put('batch_items', itemId, {
              itemId,
              channelId: action.channelId,
              batchId: queue.batchId,
              position,
              articleHash: item.articleHash,
              deliveryId,
              itemState: 'queued',
              legacyImported: true,
              createdAt: now,
              updatedAt: now,
            }, { expectedVersion: 0 });
            knownDeliveryIds.add(deliveryId);
            position += 1;
            importedQueueItems += 1;
          } else {
            duplicateQueueItems += 1;
          }
        }
      }
      const committed = tx.put('migration_state', migrationId, {
        migrationId,
        channelId: action.channelId,
        sourceFingerprint: fingerprint,
        destinationFingerprint: topology.fingerprint,
        state: 'committed',
        importedAt: now,
        counts: {
          keys: snapshots.length,
          seen: prepared.seen.length,
          digests: prepared.digests.length,
          queues: prepared.queues.length,
          importedQueueItems,
          duplicateQueueItems,
        },
        updatedAt: now,
      }, { expectedVersion: 0 });
      const result = projectMigrationResult(committed);
      putMigrationOperatorAction(tx, {
        action,
        operatorActionId,
        reasonHash,
        payloadFingerprint,
        migrationId,
        result,
        now,
      });
      return result;
    });
  }

  async _assertMigrationReady(channel) {
    const migrations = await this.store.query('migration_state', {
      channelId: channel.id,
      state: 'committed',
    });
    const migration = migrations.sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0];
    if (!migration) throw new Error('Coordinator legacy migration is not committed');
    const outputs = channel.outputs ?? [channel.output];
    const topology = await buildOutputTopology(outputs);
    if (migration.destinationFingerprint !== topology.fingerprint) {
      throw new Error('Coordinator destination fingerprint changed after migration');
    }
    return migration;
  }

  async _assertCanaryReady(channel, expectedVersion) {
    const state = await this.store.get('channel_state', channel.id);
    const marker = await this.store.get('canary_state', channel.id);
    const topology = await buildOutputTopology(channel.outputs ?? [channel.output]);
    if (!state?.paused) throw new Error('Coordinator must remain paused before resume');
    if (state.mutationState !== 'free') throw new Error('Coordinator mutation lease is not free');
    if (!Number.isSafeInteger(expectedVersion) || state.version !== expectedVersion) {
      throw new Error('Coordinator resume version conflict');
    }
    if (!marker || marker.state !== 'succeeded') throw new Error('Successful canary is required before resume');
    if (marker.channelVersion !== state.version) throw new Error('Canary evidence is stale for the current channel version');
    if (marker.destinationFingerprint !== topology.fingerprint) {
      throw new Error('Canary destination fingerprint changed before resume');
    }
    const unsafe = await this._listUnsafeCanaryBlockers(channel.id);
    if (unsafe.length > 0) throw new Error('Unsafe delivery blocker must be reconciled before resume');
    return marker;
  }

  async _listUnsafeCanaryBlockers(channelId) {
    const deliveries = await this.store.query('deliveries', {
      channelId,
      state: [...UNSAFE_CANARY_DELIVERY_STATES],
    }, { limit: 1 });
    const outputs = await this.store.query('delivery_outputs', {
      state: [...UNSAFE_CANARY_OUTPUT_STATES],
    }, { limit: 1 });
    const attempts = [
      ...await this.store.query('attempts', { channelId, state: 'attempting' }, { limit: 1 }),
      ...await this.store.query('attempts', { channelId: null, state: 'attempting' }, { limit: 1 }),
    ];
    const outbox = await this.store.query('maintenance_outbox', {
      channelId,
      state: ['attempting', 'dead_letter'],
    }, { limit: 1 });
    return [...deliveries, ...outputs, ...attempts, ...outbox];
  }
}

function validateDeliveryRequest(value) {
  if (!value || typeof value !== 'object') throw new Error('Request payload is required');
  const triggerType = String(value.triggerType ?? 'manual');
  if (!['scheduled', 'manual', 'force', 'canary', 'alarm'].includes(triggerType)) throw new Error('Invalid triggerType');
  const force = triggerType === 'force' || triggerType === 'canary' || value.force === true;
  const operatorRequest = triggerType === 'force' || triggerType === 'canary';
  const limit = value.limit === undefined ? null : positiveInteger(value.limit, 'limit');
  if (triggerType === 'canary' && limit !== 1) throw new Error('Canary requires limit=1');
  if (triggerType === 'canary' && (value.singleMutation !== true || value.confirmPausedMutation !== true)) {
    throw new Error('Canary requires explicit paused single-mutation confirmation');
  }
  if (triggerType === 'force' && (value.operatorForce === true || value.confirmPausedMutation === true || value.singleMutation === true)) {
    throw new Error('Paused single-mutation override is reserved for canary requests');
  }
  if (operatorRequest && value.duplicateRiskAccepted !== true) {
    throw new Error('duplicateRiskAccepted=true is required for force delivery');
  }
  return {
    requestId: requiredString(value.requestId, 'requestId', 200),
    channelId: requiredString(value.channelId, 'channelId', 100),
    triggerType,
    force,
    operatorForce: triggerType === 'canary',
    confirmPausedMutation: triggerType === 'canary',
    singleMutation: triggerType === 'canary',
    limit,
    operatorId: operatorRequest ? requiredString(value.operatorId, 'operatorId', 100) : null,
    reason: operatorRequest ? requiredString(value.reason, 'reason', 500) : null,
    duplicateRiskAccepted: operatorRequest && value.duplicateRiskAccepted === true,
    requestedAt: new Date(value.requestedAt ?? Date.now()).toISOString(),
  };
}

function assertCanaryPreconditions(tx, request, channel, activeRequestCount) {
  if (!channel?.paused) throw new Error('Canary requires a paused coordinator');
  if (channel.mutationState !== 'free') throw new Error('Canary requires a mutation-free coordinator');
  if (activeRequestCount > 0) throw new Error('Canary requires no other active request');

  const deliveries = tx.query('deliveries', {
    channelId: request.channelId,
    state: [...UNSAFE_CANARY_DELIVERY_STATES],
  }, { limit: 1 });
  const outputs = tx.query('delivery_outputs', {
    state: [...UNSAFE_CANARY_OUTPUT_STATES],
  }, { limit: 1 });
  const attempts = [
    ...tx.query('attempts', { channelId: request.channelId, state: 'attempting' }, { limit: 1 }),
    ...tx.query('attempts', { channelId: null, state: 'attempting' }, { limit: 1 }),
  ];
  const outbox = tx.query('maintenance_outbox', {
    channelId: request.channelId,
    state: ['pending', 'retry_pending', 'attempting', 'dead_letter'],
  }, { limit: 1 });
  if (deliveries.length || outputs.length || attempts.length || outbox.length) {
    throw new Error('Canary requires all unsafe delivery blockers to be reconciled');
  }
}

function validateControl(value) {
  if (!value || typeof value !== 'object') throw new Error('Control payload is required');
  return {
    ...value,
    action: requiredString(value.action, 'action', 80),
    channelId: requiredString(value.channelId, 'channelId', 100),
    idempotencyKey: requiredString(value.idempotencyKey, 'idempotencyKey', 200),
    operatorId: requiredString(value.operatorId, 'operatorId', 100),
    reason: requiredString(value.reason, 'reason', 500),
    expectedVersion: Number(value.expectedVersion),
  };
}

function publicRequest(request) {
  return {
    requestId: request.requestId,
    channelId: request.channelId,
    triggerType: request.triggerType,
    state: request.state,
    outcome: request.outcome,
    reason: request.reason,
    result: request.result,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    version: request.version,
  };
}

function publicChannel(channel) {
  if (!channel) return null;
  return {
    channelId: channel.channelId,
    paused: channel.paused,
    mutationState: channel.mutationState,
    version: channel.version,
    updatedAt: channel.updatedAt,
  };
}

function projectUnresolvedTargets(deliveries, outputs, outbox) {
  const targets = [];
  for (const delivery of deliveries) {
    if (['succeeded', 'abandoned'].includes(delivery.state)) continue;
    const actions = ['abandon'];
    if (['generation_retry_pending', 'generation_exhausted'].includes(delivery.state)) {
      actions.unshift('retry-generation');
    }
    if (delivery.state === 'blocked_topology') actions.unshift('restore-topology');
    if (
      actions.length > 1
      || ['output_manual_retry_required', 'output_exhausted', 'blocked_topology', 'needs_reconciliation'].includes(delivery.state)
    ) {
      targets.push({
        targetType: 'delivery',
        deliveryId: delivery.deliveryId,
        state: delivery.state,
        expectedVersion: delivery.version,
        actions,
      });
    }
  }
  for (const output of outputs) {
    if (!['manual_retry_required', 'exhausted', 'needs_reconciliation'].includes(output.state)) continue;
    targets.push({
      targetType: 'output',
      deliveryId: output.deliveryId,
      outputKey: output.outputKey,
      state: output.state,
      expectedVersion: output.version,
      actions: output.state === 'needs_reconciliation'
        ? ['confirm-delivered', 'retry-output']
        : ['retry-output'],
    });
  }
  for (const row of outbox) {
    if (row.state !== 'dead_letter') continue;
    targets.push({
      targetType: 'maintenance',
      outboxId: row.outboxId,
      state: row.state,
      expectedVersion: row.version,
      actions: ['retry-maintenance'],
    });
  }
  return targets;
}

async function queryUnresolvedTargetPage(store, channelId, {
  limit,
  offset,
  deliveryCounts,
  outputCounts,
  maintenanceCount,
}) {
  const groups = [
    ...RECOVERY_DELIVERY_STATES.map((state, index) => ({
      count: deliveryCounts[index],
      query: page => store.query('deliveries', {
        channelId,
        state,
      }, page),
      project: records => projectUnresolvedTargets(records, [], []),
    })),
    ...RECOVERY_OUTPUT_STATES.map((state, index) => ({
      count: outputCounts[index],
      query: page => store.query('delivery_outputs', {
        state,
      }, page),
      project: records => projectUnresolvedTargets([], records, []),
    })),
    {
      count: maintenanceCount,
      query: page => store.query('maintenance_outbox', {
        channelId,
        state: 'dead_letter',
      }, page),
      project: records => projectUnresolvedTargets([], [], records),
    },
  ];
  let remainingOffset = offset;
  let remainingLimit = limit;
  const targets = [];
  for (const group of groups) {
    if (remainingLimit === 0) break;
    if (remainingOffset >= group.count) {
      remainingOffset -= group.count;
      continue;
    }
    const records = await group.query({
      orderBy: 'recordId',
      direction: 'asc',
      limit: Math.min(remainingLimit, group.count - remainingOffset),
      offset: remainingOffset,
    });
    targets.push(...group.project(records));
    remainingLimit -= records.length;
    remainingOffset = 0;
  }
  return targets;
}

function projectRunResult(result) {
  return {
    status: String(result?.status ?? 'failed').slice(0, 40),
    reason: result?.reason ? String(result.reason).slice(0, 120) : null,
    publishingDay: result?.publishingDay ?? null,
    deliveryId: result?.deliveryId ?? null,
    deliveryState: result?.deliveryState ?? null,
    counts: {
      articles: Number(result?.stats?.articles ?? result?.articles?.length ?? 0),
      outputs: Number(result?.stats?.outputs ?? result?.outputs?.length ?? 0),
      remaining: Number(result?.stats?.remaining ?? 0),
      blocked: Number(result?.stats?.blocked ?? 0),
    },
    sourceHealth: result?.sourceHealth ? {
      total: result.sourceHealth.total,
      healthy: result.sourceHealth.healthy,
      failed: result.sourceHealth.failed,
      unknown: result.sourceHealth.unknown,
      degraded: result.sourceHealth.degraded,
    } : null,
  };
}

function projectPreview(result) {
  return {
    status: result.status,
    publishingDay: result.publishingDay,
    content: typeof result.content === 'string' ? result.content.slice(0, 64 * 1024) : null,
    articles: Array.isArray(result.articles)
      ? result.articles.slice(0, 10).map(item => ({ article: item.article, hook: item.hook }))
      : undefined,
    stats: result.stats,
    sourceHealth: result.sourceHealth,
  };
}

function projectControlResult(result, requestId = null) {
  const channel = result.channel ? publicChannel(result.channel) : null;
  const outbox = result.outbox ?? null;
  const retainedResult = result.result ?? null;
  return {
    status: result.status,
    deliveryId: result.delivery?.deliveryId ?? result.deliveryId ?? retainedResult?.deliveryId ?? null,
    deliveryState: result.delivery?.state ?? result.deliveryState ?? retainedResult?.deliveryState ?? null,
    outputKey: result.output?.outputKey ?? result.outputKey ?? retainedResult?.outputKey ?? null,
    outboxId: outbox?.outboxId ?? result.outboxId ?? null,
    outboxState: outbox?.state ?? result.outboxState ?? null,
    version: result.delivery?.version
      ?? result.deliveryVersion
      ?? retainedResult?.deliveryVersion
      ?? channel?.version
      ?? outbox?.version
      ?? result.outboxVersion
      ?? null,
    requestId: result.requestId ?? result.attempt?.requestId ?? requestId ?? null,
    channel,
    replayed: result.replayed === true,
    result: {
      success: retainedResult?.success ?? null,
      meta: retainedResult?.meta ?? null,
    },
  };
}

function projectMigrationResult(value) {
  const counts = value?.counts ?? {};
  return {
    status: value?.status ?? value?.state ?? 'committed',
    migrationId: value?.migrationId ?? null,
    sourceFingerprint: value?.sourceFingerprint ?? null,
    destinationFingerprint: value?.destinationFingerprint ?? null,
    counts: {
      keys: Number(counts.keys ?? 0),
      seen: Number(counts.seen ?? 0),
      digests: Number(counts.digests ?? 0),
      queues: Number(counts.queues ?? 0),
      importedQueueItems: Number(counts.importedQueueItems ?? 0),
      duplicateQueueItems: Number(counts.duplicateQueueItems ?? 0),
    },
    importedAt: value?.importedAt ?? null,
    version: Number.isSafeInteger(value?.version) ? value.version : null,
  };
}

function putMigrationOperatorAction(tx, {
  action,
  operatorActionId,
  reasonHash,
  payloadFingerprint,
  migrationId,
  result,
  now,
}) {
  const existing = tx.get('operator_actions', operatorActionId);
  if (existing) {
    if (existing.payloadFingerprint !== payloadFingerprint) {
      throw new Error('Idempotency key conflicts with a different operator action');
    }
    return existing;
  }
  return tx.put('operator_actions', operatorActionId, {
    actionId: operatorActionId,
    action: action.action,
    channelId: action.channelId,
    migrationId,
    operatorId: action.operatorId,
    reasonHash,
    payloadFingerprint,
    state: 'minimized',
    result,
    createdAt: now,
    updatedAt: now,
  }, { expectedVersion: 0 });
}

function isBlockingReason(reason) {
  return /ambiguous|reconciliation|topology|exhausted|manual_retry|state_commit/i.test(reason ?? '');
}

function runtimeMode(env) { return String(env.NEWS_RUNTIME_MODE ?? 'bootstrap').toLowerCase(); }
function requireActiveRuntime(env) {
  if (runtimeMode(env) !== 'active') throw new Error(`Runtime mode ${runtimeMode(env)} blocks delivery operations`);
}
function requireControlRuntime(env, action) {
  const mode = runtimeMode(env);
  if (mode === 'active' || (mode === 'bootstrap' && action === 'pause')) return;
  throw new Error(`Runtime mode ${mode} blocks control operation ${action}`);
}
function attemptTimeout(env) {
  const value = Number(env.DELIVERY_ATTEMPT_TIMEOUT_MS ?? 30_000);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 15 * 60_000 ? value : 30_000;
}
function requestTimeout(env) {
  const value = Number(env.COORDINATOR_REQUEST_TIMEOUT_MS ?? 10 * 60_000);
  const minimum = attemptTimeout(env) + 1_000;
  return Number.isSafeInteger(value) && value >= minimum && value <= 30 * 60_000
    ? value
    : Math.max(10 * 60_000, minimum);
}
function externalAttemptTimeout(env) {
  return Math.max(1, attemptTimeout(env) - 100);
}
async function withCoordinatorTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function fitToOutput(content, output) {
  const value = String(content ?? '');
  if (value.length <= output.maxLength) return value;
  const truncated = value.substring(0, Math.max(0, output.maxLength - 50));
  const lastBreak = truncated.lastIndexOf('\n\n');
  return (lastBreak > value.length * 0.5 ? truncated.substring(0, lastBreak) : truncated) + '\n\n[...]';
}
function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

async function prepareLegacyImport({ channelId, prefix, snapshots, topology, fingerprint, importedAt }) {
  const prepared = { seen: [], digests: [], queues: [] };
  let queueItemCount = 0;
  for (const snapshot of snapshots) {
    const suffix = snapshot.key.slice(prefix.length);
    if (suffix.startsWith('seen:')) {
      const legacyHash = suffix.slice('seen:'.length);
      if (!legacyHash || legacyHash.length > 200) throw new Error('Legacy seen key is invalid');
      prepared.seen.push({
        compatId: await opaqueId('legacy-seen-compat', channelId, legacyHash),
        legacyHash,
        valueChecksum: snapshot.valueChecksum,
        expiresAt: snapshot.expiresAt
          ?? new Date(new Date(importedAt).getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      });
      continue;
    }
    const digest = suffix.match(/^digest:(\d{4}-\d{2}-\d{2})$/);
    if (digest) {
      prepared.digests.push({
        compatId: await opaqueId('legacy-digest-compat', channelId, digest[1]),
        publishingDay: digest[1],
        valueChecksum: snapshot.valueChecksum,
      });
      continue;
    }
    const queue = suffix.match(/^drip:queue:(\d{4}-\d{2}-\d{2})$/);
    if (!queue) throw new Error(`Unsupported legacy news key: ${suffix}`);
    let rawArticles;
    try { rawArticles = JSON.parse(snapshot.value ?? ''); }
    catch { throw new Error(`Legacy queue ${queue[1]} is corrupt`); }
    if (!Array.isArray(rawArticles)) throw new Error(`Legacy queue ${queue[1]} is not an array`);
    queueItemCount += rawArticles.length;
    if (queueItemCount > 1_000) throw new Error('Legacy queue item limit exceeded');
    const items = [];
    for (const raw of rawArticles) {
      const article = projectArticle(raw);
      const articleHash = await channelArticleHash(channelId, article);
      const requestId = await opaqueId('drip-item', channelId, queue[1], article.source, article.id);
      items.push({
        article,
        articleHash,
        requestId,
        deliveryId: await opaqueId('delivery', channelId, 'normal', 'drip', requestId, articleHash),
      });
    }
    prepared.queues.push({
      publishingDay: queue[1],
      batchId: await opaqueId('day-batch', channelId, queue[1], 'drip'),
      sourceTopologyFingerprint: await opaqueId('legacy-source-topology', channelId, queue[1], fingerprint),
      items,
      topology,
    });
  }
  return prepared;
}

function requiredString(value, label, maximum = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return result;
}
function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}
function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}
