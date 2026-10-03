/**
 * Delivery → library sync. Projects a channel's deliveries and outputs from
 * the delivery store into `app_content_items` (status, generated summary,
 * provider message ids, delivery time), keyed by the same canonical article
 * keys the delivery store uses. The runtime syncs right after every run and
 * every operator control, long before the store compacts terminal delivery
 * detail (30 days), and the projection is idempotent.
 *
 * Syncs are incremental: each channel remembers the newest delivery
 * `updatedAt` it projected and re-reads only deliveries changed since then
 * (with an overlap for clock adjustments). A full sync re-projects every
 * delivery still in the store; the runtime runs one at start-up and during
 * daily maintenance, so a crash between a run and its sync is repaired.
 */

import { sanitizeError } from '../../core/delivery.js';

const PAGE_SIZE = 200;
const OVERLAP_MS = 10 * 60 * 1_000;
const MAX_MESSAGE_IDS = 20;
const MAX_MESSAGE_ID_TEXT = 500;

/** Delivery-store states mapped to library statuses. */
export const CONTENT_STATUS_BY_DELIVERY_STATE = Object.freeze({
  pending_generation: 'queued',
  ready: 'queued',
  generating: 'generating',
  delivering: 'delivering',
  generation_retry_pending: 'generation_failed',
  manual_generation_retry_pending: 'generation_failed',
  generation_exhausted: 'generation_failed',
  partial_retryable: 'failed',
  output_manual_retry_required: 'failed',
  output_exhausted: 'failed',
  needs_reconciliation: 'ambiguous',
  blocked_topology: 'blocked',
  succeeded: 'delivered',
  abandoned: 'abandoned',
});

/**
 * @param {string} state Delivery-store delivery state.
 * @returns {string} Library status; unknown states surface as `blocked` so they get attention.
 */
export function contentStatusForDelivery(state) {
  return CONTENT_STATUS_BY_DELIVERY_STATE[state] ?? 'blocked';
}

export class ContentSync {
  /**
   * @param {{
   *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
   *   contentRepository: import('../db/content-repository.js').ContentRepository,
   *   logger?: Pick<Console, 'warn'>,
   * }} options
   */
  constructor({ deliveryStore, contentRepository, logger = console }) {
    if (typeof deliveryStore?.query !== 'function') throw new TypeError('ContentSync requires a queryable delivery store');
    if (typeof contentRepository?.applyDeliveryProjections !== 'function') {
      throw new TypeError('ContentSync requires a content repository');
    }
    this._store = deliveryStore;
    this._content = contentRepository;
    this._logger = logger;
    /** @type {Map<string, number>} channel id -> newest projected delivery updatedAt (ms) */
    this._watermarks = new Map();
    /** @type {Map<string, Promise<unknown>>} serializes syncs per channel */
    this._tails = new Map();
  }

  /**
   * Project the channel's changed deliveries into the library. Syncs of one
   * channel never overlap, so an older read can never overwrite a newer one.
   * @param {string} channelId
   * @param {{ full?: boolean, runId?: string|null }} [options] `runId` is
   *   attached to library rows this sync creates.
   * @returns {Promise<{ deliveries: number, changed: number }>}
   */
  sync(channelId, { full = false, runId = null } = {}) {
    if (typeof channelId !== 'string' || channelId === '') throw new TypeError('ContentSync requires a channel id');
    const previous = this._tails.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this._sync(channelId, { full, runId }));
    const tail = current.catch(() => {});
    this._tails.set(channelId, tail);
    tail.then(() => {
      if (this._tails.get(channelId) === tail) this._tails.delete(channelId);
    });
    return current;
  }

  /**
   * `sync()` that logs instead of throwing, for post-run and post-control hooks.
   * @param {string} channelId
   * @param {{ full?: boolean, runId?: string|null }} [options]
   * @returns {Promise<{ deliveries: number, changed: number }|null>}
   */
  async syncQuietly(channelId, options) {
    try {
      return await this.sync(channelId, options);
    } catch (error) {
      this._logger.warn?.('[Library] Delivery sync failed', { channelId, error: sanitizeError(error) });
      return null;
    }
  }

  async _sync(channelId, { full, runId }) {
    const watermark = full ? null : this._watermarks.get(channelId) ?? null;
    const since = watermark === null ? null : watermark - OVERLAP_MS;
    const deliveries = [];
    let newest = watermark;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this._store.query('deliveries', { channelId }, {
        orderBy: 'updatedAt',
        direction: 'desc',
        limit: PAGE_SIZE,
        offset,
      });
      let reachedOlder = false;
      for (const delivery of page) {
        const updatedAt = Date.parse(delivery.updatedAt ?? '');
        if (since !== null && Number.isFinite(updatedAt) && updatedAt < since) {
          reachedOlder = true;
          break;
        }
        if (Number.isFinite(updatedAt) && (newest === null || updatedAt > newest)) newest = updatedAt;
        deliveries.push(delivery);
      }
      if (reachedOlder || page.length < PAGE_SIZE) break;
    }

    // Oldest first, so when two deliveries share an article the newest state wins.
    deliveries.sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
    const projections = [];
    for (const delivery of deliveries) {
      if (!isProjectable(delivery, channelId)) continue;
      const outputs = await this._store.query('delivery_outputs', { deliveryId: delivery.deliveryId });
      projections.push(...projectDelivery(delivery, outputs, { channelId, runId }));
    }
    const changed = this._content.applyDeliveryProjections(projections);
    if (newest !== null) this._watermarks.set(channelId, Math.max(newest, this._watermarks.get(channelId) ?? newest));
    return { deliveries: deliveries.length, changed };
  }
}

// Compacted tombstones keep identity only; their library rows were projected earlier.
function isProjectable(delivery, channelId) {
  return delivery?.channelId === channelId
    && delivery.compacted !== true
    && Array.isArray(delivery.articleHashes)
    && Array.isArray(delivery.articleSnapshot)
    && delivery.articleHashes.length === delivery.articleSnapshot.length;
}

function projectDelivery(delivery, outputs, { channelId, runId }) {
  const status = contentStatusForDelivery(delivery.state);
  const sorted = [...outputs].sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
  const messageIds = [...new Set(sorted.flatMap(output => (
    Array.isArray(output.successfulMessageIds) ? output.successfulMessageIds.map(String) : []
  )))].slice(0, MAX_MESSAGE_IDS);
  const deliveredAt = status === 'delivered' ? deliveredInstant(delivery, sorted) : null;
  const projections = [];
  delivery.articleHashes.forEach((articleKey, index) => {
    const snapshot = delivery.articleSnapshot[index];
    if (!snapshot || typeof snapshot.title !== 'string' || typeof snapshot.source !== 'string') return;
    projections.push({
      channelId,
      articleKey,
      title: snapshot.title,
      url: snapshot.url ?? null,
      sourceName: snapshot.source,
      category: snapshot.category ?? null,
      publishedAt: snapshot.publishedAt ?? null,
      status,
      deliveryId: delivery.deliveryId,
      summaryText: typeof delivery.generatedContent === 'string' ? delivery.generatedContent : null,
      messageId: messageIds.length > 0 ? messageIds.join(',').slice(0, MAX_MESSAGE_ID_TEXT) : null,
      deliveredAt,
      firstSeenAt: validIso(delivery.createdAt) ?? validIso(delivery.updatedAt) ?? new Date(0).toISOString(),
      runId,
    });
  });
  return projections;
}

function deliveredInstant(delivery, outputs) {
  const sent = outputs
    .filter(output => output.state === 'succeeded')
    .map(output => Date.parse(output.updatedAt ?? ''))
    .filter(Number.isFinite);
  if (sent.length > 0) return new Date(Math.max(...sent)).toISOString();
  return validIso(delivery.updatedAt);
}

function validIso(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
