/**
 * Run history backed by `app_runs` (one row per scheduled or manual channel
 * run) and `app_source_health` (one row per source fetched by a run). Rows
 * hold bounded, already-sanitized summaries only: never secrets, provider
 * payloads, or generated content.
 */

import { IssueCollector, ValidationError, readObject } from '../channels/validation.js';
import { readQueryInteger } from './content-repository.js';

export const RUN_TRIGGER_TYPES = Object.freeze(['scheduled', 'manual']);
export const RUN_STATUSES = Object.freeze([
  'running', 'success', 'partial', 'failed', 'ambiguous', 'skipped', 'error', 'interrupted',
]);
export const SOURCE_HEALTH_STATUSES = Object.freeze(['healthy', 'empty', 'failed']);
export const MAX_RUN_PAGE_SIZE = 100;

const DEFAULT_RUN_PAGE_SIZE = 20;
const MAX_RUN_OFFSET = 100_000;
const MAX_ERROR_LENGTH = 500;
const MAX_STATS_BYTES = 64 * 1024;
const RUN_COLUMNS = `
  id, channel_id, trigger_type, status, started_at, finished_at, stats_json,
  ai_input_tokens, ai_output_tokens, outputs_total, outputs_succeeded, outputs_failed, error_text
`;

/**
 * @typedef {object} SourceHealthEntry
 * @property {string} sourceId
 * @property {string|null} sourceName
 * @property {'healthy'|'empty'|'failed'} status
 * @property {number} articleCount
 * @property {string|null} errorClass Bounded failure class, e.g. `http` or `transport`.
 */

/**
 * @typedef {object} RunRecord
 * @property {string} id
 * @property {string} channelId
 * @property {'scheduled'|'manual'} triggerType
 * @property {string} status One of `RUN_STATUSES`.
 * @property {string} startedAt
 * @property {string|null} finishedAt
 * @property {number|null} durationMs
 * @property {object|null} stats
 * @property {number|null} aiInputTokens
 * @property {number|null} aiOutputTokens
 * @property {number|null} outputsTotal
 * @property {number|null} outputsSucceeded
 * @property {number|null} outputsFailed
 * @property {string|null} error Sanitized error text.
 * @property {(SourceHealthEntry & { observedAt: string })[]} [sourceHealth] Present on `get()`.
 */

export class RunRepository {
  /**
   * @param {{ storage: import('./node-sql-storage.js').NodeSqlStorage }} options
   */
  constructor({ storage } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('RunRepository requires SQL storage with exec() and transactionSync()');
    }
    this._storage = storage;
  }

  /**
   * Record a run that has started.
   * @param {{ id: string, channelId: string, triggerType: 'scheduled'|'manual', startedAt: Date, stats?: object|null }} run
   * @returns {RunRecord}
   */
  start({ id, channelId, triggerType, startedAt, stats = null }) {
    requireText(id, 'Run id', 100);
    requireText(channelId, 'Run channel id', 100);
    if (!RUN_TRIGGER_TYPES.includes(triggerType)) throw new TypeError(`Invalid run trigger type: ${String(triggerType)}`);
    this._storage.sql.exec(
      `INSERT INTO app_runs(id, channel_id, trigger_type, status, started_at, stats_json)
       VALUES (?, ?, ?, 'running', ?, ?)`,
      id, channelId, triggerType, requireDate(startedAt, 'Run start').toISOString(), serializeStats(stats),
    );
    return this.get(id);
  }

  /**
   * Complete a running run and store its per-source health in one
   * transaction. A run that is no longer `running` (finished or marked
   * interrupted) is left unchanged.
   * @param {string} id
   * @param {{
   *   status: string,
   *   finishedAt: Date,
   *   stats?: object|null,
   *   aiInputTokens?: number|null,
   *   aiOutputTokens?: number|null,
   *   outputsTotal?: number|null,
   *   outputsSucceeded?: number|null,
   *   outputsFailed?: number|null,
   *   error?: string|null,
   *   sourceHealth?: SourceHealthEntry[],
   * }} result `error` must already be sanitized.
   * @returns {RunRecord|null} `null` when the run does not exist.
   */
  finish(id, {
    status,
    finishedAt,
    stats = null,
    aiInputTokens = null,
    aiOutputTokens = null,
    outputsTotal = null,
    outputsSucceeded = null,
    outputsFailed = null,
    error = null,
    sourceHealth = [],
  }) {
    if (!RUN_STATUSES.includes(status) || status === 'running') throw new TypeError(`Invalid final run status: ${String(status)}`);
    const finished = requireDate(finishedAt, 'Run finish').toISOString();
    if (!Array.isArray(sourceHealth)) throw new TypeError('Run source health must be an array');
    this._storage.transactionSync(() => {
      const [run] = this._storage.sql.exec('SELECT channel_id, status FROM app_runs WHERE id = ?', id).toArray();
      if (!run || run.status !== 'running') return;
      this._storage.sql.exec(
        `UPDATE app_runs SET
           status = ?, finished_at = ?, stats_json = ?, ai_input_tokens = ?, ai_output_tokens = ?,
           outputs_total = ?, outputs_succeeded = ?, outputs_failed = ?, error_text = ?
         WHERE id = ?`,
        status, finished, serializeStats(stats), countOrNull(aiInputTokens), countOrNull(aiOutputTokens),
        countOrNull(outputsTotal), countOrNull(outputsSucceeded), countOrNull(outputsFailed),
        error === null || error === undefined ? null : String(error).slice(0, MAX_ERROR_LENGTH),
        id,
      );
      for (const entry of sourceHealth) {
        if (!SOURCE_HEALTH_STATUSES.includes(entry?.status)) throw new TypeError('Invalid source health status');
        // Duplicate source ids within one run keep the first observation.
        this._storage.sql.exec(
          `INSERT INTO app_source_health(
             run_id, channel_id, source_id, source_name, status, article_count, error_class, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, source_id) DO NOTHING`,
          id, run.channel_id, requireText(entry.sourceId, 'Source id', 100), boundedOrNull(entry.sourceName, 200),
          entry.status, countOrNull(entry.articleCount) ?? 0, boundedOrNull(entry.errorClass, 80), finished,
        );
      }
    });
    return this.get(id);
  }

  /**
   * Mark runs left `running` by a previous process as `interrupted`.
   * @param {{ finishedAt: Date, excludeIds?: string[] }} options
   * @returns {number} Runs marked.
   */
  interruptStale({ finishedAt, excludeIds = [] }) {
    const finished = requireDate(finishedAt, 'Interruption time').toISOString();
    const excluded = excludeIds.filter(id => typeof id === 'string' && id !== '');
    return this._storage.transactionSync(() => {
      this._storage.sql.exec(
        `UPDATE app_runs SET status = 'interrupted', finished_at = ?, error_text = 'Runtime restarted before the run finished'
         WHERE status = 'running'${excluded.length > 0 ? ` AND id NOT IN (${excluded.map(() => '?').join(', ')})` : ''}`,
        finished,
        ...excluded,
      );
      return Number(this._storage.sql.exec('SELECT changes() AS count').one().count);
    });
  }

  /**
   * @param {string} id
   * @returns {RunRecord|null} Including the run's per-source health rows.
   */
  get(id) {
    if (typeof id !== 'string' || id === '' || id.length > 100) return null;
    const [row] = this._storage.sql.exec(`SELECT ${RUN_COLUMNS} FROM app_runs WHERE id = ?`, id).toArray();
    if (!row) return null;
    const sourceHealth = this._storage.sql.exec(
      `SELECT source_id, source_name, status, article_count, error_class, observed_at
       FROM app_source_health WHERE run_id = ? ORDER BY source_id`,
      id,
    ).toArray().map(entry => ({
      sourceId: entry.source_id,
      sourceName: entry.source_name ?? null,
      status: entry.status,
      articleCount: Number(entry.article_count),
      errorClass: entry.error_class ?? null,
      observedAt: entry.observed_at,
    }));
    return { ...toRecord(row), sourceHealth };
  }

  /**
   * Runs of one channel, newest first.
   * @param {string} channelId
   * @param {{ limit?: number|string, offset?: number|string }} [page]
   * @returns {{ runs: RunRecord[], page: { limit: number, offset: number, total: number } }}
   * @throws {ValidationError}
   */
  list(channelId, page = {}) {
    const { limit, offset } = readPage(page);
    const { sql } = this._storage;
    const total = Number(sql.exec('SELECT COUNT(*) AS total FROM app_runs WHERE channel_id = ?', String(channelId)).one().total);
    const runs = sql.exec(
      `SELECT ${RUN_COLUMNS} FROM app_runs WHERE channel_id = ?
       ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      String(channelId), limit, offset,
    ).toArray().map(toRecord);
    return { runs, page: { limit, offset, total } };
  }

  /**
   * @param {string} channelId
   * @returns {RunRecord|null} The most recently started run of the channel.
   */
  latest(channelId) {
    const [row] = this._storage.sql.exec(
      `SELECT ${RUN_COLUMNS} FROM app_runs WHERE channel_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      String(channelId),
    ).toArray();
    return row ? toRecord(row) : null;
  }

  /**
   * Delete finished runs started before `before`, and source health observed
   * before it, in one transaction.
   * @param {{ before: Date }} options
   * @returns {{ runs: number, sourceHealth: number }}
   */
  prune({ before }) {
    const cutoff = requireDate(before, 'Run retention cutoff').toISOString();
    return this._storage.transactionSync(() => {
      const { sql } = this._storage;
      sql.exec('DELETE FROM app_source_health WHERE observed_at < ?', cutoff);
      const sourceHealth = Number(sql.exec('SELECT changes() AS count').one().count);
      sql.exec("DELETE FROM app_runs WHERE started_at < ? AND status <> 'running'", cutoff);
      const runs = Number(sql.exec('SELECT changes() AS count').one().count);
      return { runs, sourceHealth };
    });
  }
}

function readPage(page) {
  const issues = new IssueCollector();
  const value = readObject(issues, page ?? {}, '', { allowed: ['limit', 'offset'] }) ?? {};
  const limit = readQueryInteger(issues, value.limit, 'limit', 1, MAX_RUN_PAGE_SIZE, DEFAULT_RUN_PAGE_SIZE);
  const offset = readQueryInteger(issues, value.offset, 'offset', 0, MAX_RUN_OFFSET, 0);
  if (issues.hasIssues) throw new ValidationError('Run page is invalid', issues.issues);
  return { limit, offset };
}

function toRecord(row) {
  const startedAt = Date.parse(row.started_at);
  const finishedAt = row.finished_at ? Date.parse(row.finished_at) : NaN;
  return {
    id: row.id,
    channelId: row.channel_id,
    triggerType: row.trigger_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: Number.isFinite(finishedAt) && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
    stats: parseStats(row.stats_json),
    aiInputTokens: numberOrNull(row.ai_input_tokens),
    aiOutputTokens: numberOrNull(row.ai_output_tokens),
    outputsTotal: numberOrNull(row.outputs_total),
    outputsSucceeded: numberOrNull(row.outputs_succeeded),
    outputsFailed: numberOrNull(row.outputs_failed),
    error: row.error_text ?? null,
  };
}

function serializeStats(stats) {
  if (stats === null || stats === undefined) return null;
  const json = JSON.stringify(stats);
  if (Buffer.byteLength(json, 'utf8') > MAX_STATS_BYTES) throw new Error('Run stats exceed the stored size limit');
  return json;
}

function parseStats(json) {
  if (typeof json !== 'string') return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function countOrNull(value) {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function boundedOrNull(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, maximum);
}

function requireText(value, label, maximum) {
  if (typeof value !== 'string' || value === '' || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function requireDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid Date`);
  return value;
}
