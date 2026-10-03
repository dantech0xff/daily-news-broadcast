/**
 * Stage recorder for the content library. Each selection stage of a run
 * (cutover filter, tech gate, scoring, semantic dedup) is wrapped so every
 * candidate that reaches the chain (after the ledger dedup) is observed once:
 * `rejected` with the dropping stage's reason, or `selected` when it survives
 * the whole chain. Observations are buffered in memory and written in one
 * transaction after the run; recording problems are logged and never change
 * what the engine selects.
 */

import { channelArticleHash, projectArticle, sanitizeError } from '../../core/delivery.js';
import { REJECT_REASONS } from '../db/content-repository.js';

/**
 * @typedef {object} RecordedStage
 * @property {(articles: object[]) => object[]|Promise<object[]>} middleware
 * @property {string} reason One of `REJECT_REASONS`, recorded for articles this stage drops.
 */

export class ContentRecorder {
  /**
   * @param {{
   *   channelId: string,
   *   runId: string|null,
   *   sources?: { id: string, name: string }[],
   *   clock?: () => Date,
   *   logger?: Pick<Console, 'warn'>,
   * }} options `sources` maps article source names back to source plugin ids.
   */
  constructor({ channelId, runId = null, sources = [], clock = () => new Date(), logger = console }) {
    if (typeof channelId !== 'string' || channelId === '') throw new TypeError('ContentRecorder requires a channel id');
    this._channelId = channelId;
    this._runId = runId;
    this._clock = clock;
    this._logger = logger;
    this._sourceIds = sourceIdsByName(sources);
    /** @type {Map<string, import('../db/content-repository.js').ScanObservation>} */
    this._observations = new Map();
    this._keys = new Map();
  }

  /**
   * Wrap stages in order. Each wrapper keeps its stage's `label` and
   * `selectionKey`, so the engine's selection counts and the drip batch's
   * source-topology fingerprint match the unwrapped chain; the last wrapper
   * also records the survivors as `selected`.
   * @param {RecordedStage[]} stages
   * @returns {Array<(articles: object[]) => Promise<object[]>>}
   */
  wrapStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) throw new TypeError('ContentRecorder needs at least one stage');
    return stages.map(({ middleware, reason }, index) => {
      if (typeof middleware !== 'function') throw new TypeError('Recorded stage middleware must be a function');
      if (!REJECT_REASONS.includes(reason)) throw new TypeError(`Unknown reject reason: ${String(reason)}`);
      const last = index === stages.length - 1;
      const wrapped = async articles => {
        const kept = await middleware(articles);
        await this._observe(articles, kept, reason, last);
        return kept;
      };
      if (middleware.label !== undefined) wrapped.label = middleware.label;
      if (middleware.selectionKey !== undefined) wrapped.selectionKey = middleware.selectionKey;
      return wrapped;
    });
  }

  /**
   * Record candidates dropped outside the stage chain, e.g. stories a radar
   * scan skipped because the channel already delivered them.
   * @param {object[]} articles
   * @param {string} reason One of `REJECT_REASONS`.
   * @returns {Promise<void>} Never rejects.
   */
  async observeExcluded(articles, reason) {
    if (!REJECT_REASONS.includes(reason)) throw new TypeError(`Unknown reject reason: ${String(reason)}`);
    await this._observe(articles, [], reason, false);
  }

  /** @returns {import('../db/content-repository.js').ScanObservation[]} Latest observation per article. */
  observations() {
    return [...this._observations.values()];
  }

  async _observe(input, kept, reason, last) {
    try {
      const seenAt = this._clock().toISOString();
      const keptKeys = new Set();
      for (const article of Array.isArray(kept) ? kept : []) {
        const entry = await this._entry(article);
        if (!entry) continue;
        keptKeys.add(entry.key);
        if (last) this._record(entry, 'selected', null, seenAt);
      }
      for (const article of Array.isArray(input) ? input : []) {
        const entry = await this._entry(article);
        if (entry && !keptKeys.has(entry.key)) this._record(entry, 'rejected', reason, seenAt);
      }
    } catch (error) {
      this._logger.warn?.('[Library] Could not record selection stage', {
        channelId: this._channelId,
        error: sanitizeError(error),
      });
    }
  }

  // Articles that cannot be projected are skipped; the engine rejects them itself.
  async _entry(article) {
    let snapshot;
    try {
      snapshot = projectArticle(article);
    } catch {
      return null;
    }
    const identity = `${snapshot.source}\u0000${snapshot.id}\u0000${snapshot.url ?? ''}`;
    let key = this._keys.get(identity);
    if (!key) {
      key = await channelArticleHash(this._channelId, snapshot);
      this._keys.set(identity, key);
    }
    return { key, snapshot };
  }

  _record({ key, snapshot }, status, rejectReason, seenAt) {
    this._observations.set(key, {
      channelId: this._channelId,
      articleKey: key,
      title: snapshot.title,
      url: snapshot.url ?? null,
      sourceId: this._sourceIds.get(snapshot.source) ?? null,
      sourceName: snapshot.source,
      category: snapshot.category ?? null,
      publishedAt: snapshot.publishedAt ?? null,
      status,
      rejectReason,
      runId: this._runId,
      seenAt,
    });
  }
}

// Sources stamp articles with their display name; a name shared by two
// sources is ambiguous and maps to no id.
function sourceIdsByName(sources) {
  const ids = new Map();
  const ambiguous = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    let name;
    let id;
    try {
      name = String(source.name);
      id = String(source.id).slice(0, 100);
    } catch {
      continue;
    }
    if (ids.has(name) && ids.get(name) !== id) ambiguous.add(name);
    ids.set(name, id);
  }
  for (const name of ambiguous) ids.delete(name);
  return ids;
}
