/**
 * Read-only operational views of a channel for the dashboard: delivery state
 * (paused, version, mutation lease), the publishing-day queue, the latest run,
 * and recovery targets. Views carry titles and identifiers only, never
 * generated content, provider payloads, or destinations.
 */

import { listUnresolvedTargets } from '../../channels/runner.js';
import { opaqueId, publishingDayFor } from '../../core/delivery.js';
import { DeliveryStateMachine } from '../../core/delivery-state-machine.js';
import { IssueCollector, ValidationError, readObject } from '../channels/validation.js';
import { readQueryInteger } from '../db/content-repository.js';
import { contentStatusForDelivery } from './content-sync.js';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Delivery states the engine reports as blocked: they wait for an operator.
const BLOCKED_DELIVERY_STATES = new Set([
  'manual_generation_retry_pending', 'generation_exhausted', 'output_manual_retry_required',
  'output_exhausted', 'blocked_topology', 'needs_reconciliation',
]);
const SETTLED_DELIVERY_STATES = new Set(['succeeded', 'abandoned']);
const DEFAULT_UNRESOLVED_PAGE_SIZE = 50;

/**
 * @typedef {object} QueueItem
 * @property {number} position
 * @property {string} deliveryId
 * @property {string} status Library status (queued, delivering, delivered, …).
 * @property {string} deliveryState Raw delivery-store state.
 * @property {string|null} title First article's title.
 * @property {string|null} url
 * @property {string|null} source
 * @property {number} articleCount
 * @property {boolean} forced Created by a force run rather than the schedule.
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 */

/**
 * @typedef {object} QueueView
 * @property {string} date Publishing day (YYYY-MM-DD in the channel timezone).
 * @property {string} mode
 * @property {number} total
 * @property {number} remaining Not yet delivered or abandoned.
 * @property {number} blocked Waiting for an operator.
 * @property {number} delivered
 * @property {QueueItem[]} items Oldest first.
 */

export class ChannelStatusReader {
  /**
   * @param {{
   *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
   *   runs: import('../db/run-repository.js').RunRepository,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ deliveryStore, runs, clock = () => new Date() }) {
    this._store = deliveryStore;
    this._runs = runs;
    this._clock = clock;
  }

  /**
   * @param {import('../channels/channel-repository.js').ChannelRecord} record
   * @param {{ scheduled: boolean, running: boolean, queued: boolean }} runtime
   * @returns {Promise<object>} Status snapshot; `version` is the delivery-state
   *   version to pass as `expectedVersion` for pause/resume, `configVersion`
   *   the config version for updates.
   */
  async status(record, runtime) {
    const [state, queue, unresolved] = await Promise.all([
      this._store.get('channel_state', record.id),
      this.queue(record),
      listUnresolvedTargets(this._store, record.id, { limit: 1 }),
    ]);
    return {
      channelId: record.id,
      name: record.name,
      enabled: record.enabled,
      mode: record.mode,
      cron: record.cron,
      timezone: record.timezone,
      notBefore: record.notBefore,
      cutoverRequired: record.cutoverRequired === true,
      dailyLimit: record.limits.dailyLimit,
      configVersion: record.version,
      paused: state ? state.paused === true : null,
      version: Number.isSafeInteger(state?.version) ? state.version : null,
      mutationState: state?.mutationState ?? null,
      allowedActions: unresolved.channel?.allowedActions ?? [],
      scheduled: runtime.scheduled,
      running: runtime.running,
      queued: runtime.queued,
      queue: { date: queue.date, total: queue.total, remaining: queue.remaining, blocked: queue.blocked, delivered: queue.delivered },
      lastRun: summarizeRun(this._runs.latest(record.id)),
      unresolvedCount: unresolved.page.total,
    };
  }

  /**
   * Deliveries of one publishing day, oldest first.
   * @param {import('../channels/channel-repository.js').ChannelRecord} record
   * @param {string} [day] YYYY-MM-DD; defaults to today in the channel timezone.
   * @returns {Promise<QueueView>}
   * @throws {ValidationError}
   */
  async queue(record, day) {
    const date = day === undefined || day === null || day === ''
      ? publishingDayFor(this._clock(), record.timezone)
      : readDay(day);
    const machine = new DeliveryStateMachine({ store: this._store, channelId: record.id, clock: this._clock });
    // Drip deliveries follow their position in the day batch (the engine's queue order).
    const positions = new Map();
    if (record.mode === 'drip') {
      const batchId = await opaqueId('day-batch', record.id, date, 'drip');
      for (const item of await machine.listBatchItems(batchId)) positions.set(item.deliveryId, item.position);
    }
    const rank = delivery => positions.get(delivery.deliveryId) ?? Number.MAX_SAFE_INTEGER;
    const deliveries = (await machine.listDeliveriesForPublishingDays([date]))
      .sort((left, right) => (rank(left) - rank(right))
        || String(left.createdAt).localeCompare(String(right.createdAt))
        || String(left.deliveryId).localeCompare(String(right.deliveryId)));
    const items = deliveries.map((delivery, position) => {
      const article = Array.isArray(delivery.articleSnapshot) ? delivery.articleSnapshot[0] ?? null : null;
      return {
        position,
        deliveryId: delivery.deliveryId,
        status: contentStatusForDelivery(delivery.state),
        deliveryState: delivery.state,
        title: article?.title ?? null,
        url: article?.url ?? null,
        source: article?.source ?? null,
        articleCount: Array.isArray(delivery.articleHashes) ? delivery.articleHashes.length : 0,
        forced: Boolean(delivery.forceKind),
        createdAt: delivery.createdAt ?? null,
        updatedAt: delivery.updatedAt ?? null,
      };
    });
    return {
      date,
      mode: record.mode,
      total: items.length,
      remaining: items.filter(item => !SETTLED_DELIVERY_STATES.has(item.deliveryState)).length,
      blocked: items.filter(item => BLOCKED_DELIVERY_STATES.has(item.deliveryState)).length,
      delivered: items.filter(item => item.deliveryState === 'succeeded').length,
      items,
    };
  }

  /**
   * Exact recovery targets (with each delivery's first title) and the
   * channel's pause/resume target.
   * @param {string} channelId
   * @param {{ limit?: number|string, offset?: number|string }} [page]
   * @returns {Promise<Awaited<ReturnType<typeof listUnresolvedTargets>>>}
   * @throws {ValidationError}
   */
  async unresolved(channelId, page = {}) {
    const issues = new IssueCollector();
    const value = readObject(issues, page ?? {}, '', { allowed: ['limit', 'offset'] }) ?? {};
    const limit = readQueryInteger(issues, value.limit, 'limit', 1, 100, DEFAULT_UNRESOLVED_PAGE_SIZE);
    const offset = readQueryInteger(issues, value.offset, 'offset', 0, 100_000, 0);
    if (issues.hasIssues) throw new ValidationError('Unresolved page is invalid', issues.issues);
    const result = await listUnresolvedTargets(this._store, channelId, { limit, offset });
    const targets = [];
    for (const target of result.targets) {
      if (!target.deliveryId) {
        targets.push(target);
        continue;
      }
      const delivery = await this._store.get('deliveries', target.deliveryId);
      const article = Array.isArray(delivery?.articleSnapshot) ? delivery.articleSnapshot[0] ?? null : null;
      targets.push({
        ...target,
        title: typeof article?.title === 'string' ? article.title.slice(0, 500) : null,
        articleCount: Array.isArray(delivery?.articleHashes) ? delivery.articleHashes.length : 0,
        mode: delivery?.mode ?? null,
        publishingDay: delivery?.publishingDay ?? null,
      });
    }
    return { ...result, targets };
  }
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    triggerType: run.triggerType,
    status: run.status,
    reason: run.stats?.reason ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    error: run.error,
    aiInputTokens: run.aiInputTokens,
    aiOutputTokens: run.aiOutputTokens,
    outputsTotal: run.outputsTotal,
    outputsSucceeded: run.outputsSucceeded,
    outputsFailed: run.outputsFailed,
    selection: run.stats?.selection ?? null,
    sourceHealth: run.stats?.sourceHealth ?? null,
  };
}

function readDay(day) {
  const time = typeof day === 'string' && DAY_PATTERN.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : NaN;
  // Round-tripping rejects impossible dates that Date would roll over (February 30).
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) {
    throw new ValidationError('Queue day is invalid', [{ field: 'day', code: 'invalid_format', message: 'Ngày dạng YYYY-MM-DD.' }]);
  }
  return day;
}
