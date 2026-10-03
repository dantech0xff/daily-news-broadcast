/**
 * Daily retention for the app runtime (user decision 2026-10-03):
 * - library rows that were scanned but never delivered (selected, rejected,
 *   abandoned) are pruned after `contentScanDays` (default 30) by their last
 *   scan, and only when they have not changed for that long either;
 * - run history and source health are pruned after `runHistoryDays` (default 180);
 * - delivered library rows are kept forever, and rows still in a delivery
 *   state are never pruned;
 * - the delivery store's own compaction (`compactHistory()`, itself limited to
 *   once a day per channel) runs for every channel with delivery state, right
 *   after a full library sync so compaction never drops detail the library
 *   has not copied.
 * The job runs at most once a day (the last run is stored in `app_settings`);
 * `run({ force: true })` bypasses that gate.
 */

import { sanitizeRuntimeError } from '../../channels/runner.js';
import { DeliveryStateMachine } from '../../core/delivery-state-machine.js';

export const DEFAULT_CONTENT_SCAN_RETENTION_DAYS = 30;
export const DEFAULT_RUN_HISTORY_RETENTION_DAYS = 180;
export const RETENTION_LAST_RUN_SETTING = 'runtime.retention.last_run_at';

/** Upper bound of both retention settings, in days. */
export const MAX_RETENTION_DAYS = 3_650;

const DAY_MS = 24 * 60 * 60 * 1_000;

export class RetentionJob {
  /**
   * @param {{
   *   storage: import('../db/node-sql-storage.js').NodeSqlStorage,
   *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
   *   contentRepository: import('../db/content-repository.js').ContentRepository,
   *   runRepository: import('../db/run-repository.js').RunRepository,
   *   contentSync: import('./content-sync.js').ContentSync,
   *   listChannelIds: () => string[]|Promise<string[]>,
   *   clock?: () => Date,
   *   logger?: Pick<Console, 'log'|'warn'>,
   *   contentScanDays?: number,
   *   runHistoryDays?: number,
   * }} options `listChannelIds` returns every channel whose deliveries may need
   *   syncing and compaction, including deleted ones that still have delivery state.
   */
  constructor({
    storage, deliveryStore, contentRepository, runRepository, contentSync, listChannelIds,
    clock = () => new Date(), logger = console,
    contentScanDays = DEFAULT_CONTENT_SCAN_RETENTION_DAYS,
    runHistoryDays = DEFAULT_RUN_HISTORY_RETENTION_DAYS,
  }) {
    if (typeof storage?.sql?.exec !== 'function') throw new TypeError('RetentionJob requires SQL storage');
    if (typeof listChannelIds !== 'function') throw new TypeError('RetentionJob requires listChannelIds');
    this._sql = storage.sql;
    this._store = deliveryStore;
    this._content = contentRepository;
    this._runs = runRepository;
    this._contentSync = contentSync;
    this._listChannelIds = listChannelIds;
    this._clock = clock;
    this._logger = logger;
    this._contentScanDays = requireDays(contentScanDays, 'contentScanDays');
    this._runHistoryDays = requireDays(runHistoryDays, 'runHistoryDays');
  }

  /** @returns {string|null} ISO instant of the last completed run. */
  lastRunAt() {
    const [row] = this._sql.exec('SELECT value FROM app_settings WHERE key = ?', RETENTION_LAST_RUN_SETTING).toArray();
    return row && Number.isFinite(Date.parse(row.value)) ? row.value : null;
  }

  /** @returns {boolean} Whether a day has passed since the last completed run. */
  isDue() {
    const last = this.lastRunAt();
    return last === null || this._now().getTime() - Date.parse(last) >= DAY_MS;
  }

  /**
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<
   *   { status: 'skipped', reason: 'not_due', lastRunAt: string|null } |
   *   { status: 'completed', ranAt: string, contentPruned: number, runsPruned: number, sourceHealthPruned: number,
   *     compactedChannels: string[], failedChannels: string[] }
   * >}
   */
  async run({ force = false } = {}) {
    if (!force && !this.isDue()) return { status: 'skipped', reason: 'not_due', lastRunAt: this.lastRunAt() };
    const now = this._now();
    const compactedChannels = [];
    const failedChannels = [];
    for (const channelId of await this._channelIds()) {
      try {
        // Copy every delivery into the library before compaction can remove its detail.
        await this._contentSync.sync(channelId, { full: true });
        const machine = new DeliveryStateMachine({ store: this._store, channelId, clock: this._clock });
        const compacted = await machine.compactHistory();
        if (compacted.status === 'compacted') compactedChannels.push(channelId);
      } catch (error) {
        failedChannels.push(channelId);
        this._logger.warn?.(`[Retention] ${channelId}: sync or compaction failed: ${sanitizeRuntimeError(error)}`);
      }
    }
    const contentPruned = this._content.pruneUndelivered({ before: daysBefore(now, this._contentScanDays) });
    const { runs: runsPruned, sourceHealth: sourceHealthPruned } = this._runs.prune({
      before: daysBefore(now, this._runHistoryDays),
    });
    const ranAt = now.toISOString();
    this._sql.exec(
      `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      RETENTION_LAST_RUN_SETTING, ranAt, ranAt,
    );
    this._logger.log?.(
      `[Retention] Pruned ${contentPruned} library row(s), ${runsPruned} run(s), ${sourceHealthPruned} source health row(s)`,
    );
    return { status: 'completed', ranAt, contentPruned, runsPruned, sourceHealthPruned, compactedChannels, failedChannels };
  }

  async _channelIds() {
    const ids = new Set(await this._listChannelIds());
    for (const state of await this._store.list('channel_state')) {
      if (typeof state?.channelId === 'string' && state.channelId !== '') ids.add(state.channelId);
    }
    return [...ids].sort();
  }

  _now() {
    const now = this._clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('RetentionJob clock must return a valid Date');
    return now;
  }
}

function daysBefore(now, days) {
  return new Date(now.getTime() - days * DAY_MS);
}

function requireDays(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
    throw new TypeError(`${label} must be an integer between 1 and ${MAX_RETENTION_DAYS}`);
  }
  return value;
}
