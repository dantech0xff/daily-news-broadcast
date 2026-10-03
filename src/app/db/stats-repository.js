/**
 * Dashboard statistics aggregated in SQL over the app tables: posts per day
 * per channel, source health per day per source, AI generation and output
 * failure rates per day, and AI token usage per day. Every query takes an
 * instant range (`from` inclusive, `to` exclusive) on an indexed timestamp,
 * an optional channel filter (which uses the channel-leading indexes), and a
 * fixed UTC offset that decides where each day starts.
 */

import { CHANNEL_ID_PATTERN } from '../channels/config-schema.js';
import { IssueCollector, ValidationError, readIsoInstant, readObject, readString } from '../channels/validation.js';
import { readQueryInteger } from './content-repository.js';

export const MAX_STATS_RANGE_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_UTC_OFFSET_MINUTES = -720;
const MAX_UTC_OFFSET_MINUTES = 840;
const QUERY_KEYS = Object.freeze(['from', 'to', 'channelId', 'utcOffsetMinutes']);
const FAILED_RUN_STATUSES = Object.freeze(['failed', 'error', 'ambiguous', 'partial']);

/**
 * @typedef {object} StatsQuery
 * @property {string} from ISO instant, inclusive.
 * @property {string} to ISO instant, exclusive; at most `MAX_STATS_RANGE_DAYS` after `from`.
 * @property {string} [channelId]
 * @property {number|string} [utcOffsetMinutes] Day boundary offset, -720…840 (default 0 = UTC days).
 */

export class StatsRepository {
  /**
   * @param {{ storage: import('./node-sql-storage.js').NodeSqlStorage }} options
   */
  constructor({ storage } = {}) {
    if (typeof storage?.sql?.exec !== 'function') {
      throw new TypeError('StatsRepository requires SQL storage with exec()');
    }
    this._sql = storage.sql;
  }

  /**
   * All dashboard series for one range.
   * @param {StatsQuery} query
   * @returns {{
   *   range: { from: string, to: string, channelId: string|null, utcOffsetMinutes: number },
   *   postsPerDay: ReturnType<StatsRepository['postsPerDay']>,
   *   sourceHealthPerDay: ReturnType<StatsRepository['sourceHealthPerDay']>,
   *   failureRatesPerDay: ReturnType<StatsRepository['failureRatesPerDay']>,
   *   tokenUsagePerDay: ReturnType<StatsRepository['tokenUsagePerDay']>,
   * }}
   * @throws {ValidationError}
   */
  getStats(query) {
    const range = readStatsQuery(query);
    return {
      range,
      postsPerDay: this._postsPerDay(range),
      sourceHealthPerDay: this._sourceHealthPerDay(range),
      failureRatesPerDay: this._failureRatesPerDay(range),
      tokenUsagePerDay: this._tokenUsagePerDay(range),
    };
  }

  /**
   * Delivered library items per day and channel.
   * @param {StatsQuery} query
   * @returns {{ day: string, channelId: string, posts: number }[]}
   */
  postsPerDay(query) {
    return this._postsPerDay(readStatsQuery(query));
  }

  /**
   * Source fetch outcomes per day and source.
   * @param {StatsQuery} query
   * @returns {{ day: string, sourceId: string, sourceName: string|null, healthy: number, empty: number, failed: number, articles: number }[]}
   */
  sourceHealthPerDay(query) {
    return this._sourceHealthPerDay(readStatsQuery(query));
  }

  /**
   * Finished runs per day with AI generation and output failure rates
   * (`null` when nothing was attempted that day).
   * @param {StatsQuery} query
   * @returns {{
   *   day: string, runs: number, failedRuns: number,
   *   generationAttempts: number, generationFailures: number, generationFailureRate: number|null,
   *   outputAttempts: number, outputFailures: number, outputFailureRate: number|null,
   * }[]}
   */
  failureRatesPerDay(query) {
    return this._failureRatesPerDay(readStatsQuery(query));
  }

  /**
   * AI tokens reported by providers per day.
   * @param {StatsQuery} query
   * @returns {{ day: string, inputTokens: number, outputTokens: number, totalTokens: number }[]}
   */
  tokenUsagePerDay(query) {
    return this._tokenUsagePerDay(readStatsQuery(query));
  }

  _postsPerDay(range) {
    const { clause, params } = channelClause(range);
    return this._sql.exec(
      `SELECT date(delivered_at, ?) AS day, channel_id, COUNT(*) AS posts
       FROM app_content_items
       WHERE delivered_at >= ? AND delivered_at < ? AND status = 'delivered'${clause}
       GROUP BY day, channel_id
       ORDER BY day, channel_id`,
      dayModifier(range), range.from, range.to, ...params,
    ).toArray().map(row => ({ day: row.day, channelId: row.channel_id, posts: Number(row.posts) }));
  }

  _sourceHealthPerDay(range) {
    const { clause, params } = channelClause(range);
    return this._sql.exec(
      `SELECT date(observed_at, ?) AS day, source_id, MAX(source_name) AS source_name,
              SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
              SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(article_count) AS articles
       FROM app_source_health
       WHERE observed_at >= ? AND observed_at < ?${clause}
       GROUP BY day, source_id
       ORDER BY day, source_id`,
      dayModifier(range), range.from, range.to, ...params,
    ).toArray().map(row => ({
      day: row.day,
      sourceId: row.source_id,
      sourceName: row.source_name ?? null,
      healthy: Number(row.healthy),
      empty: Number(row.empty),
      failed: Number(row.failed),
      articles: Number(row.articles),
    }));
  }

  _failureRatesPerDay(range) {
    const { clause, params } = channelClause(range);
    return this._sql.exec(
      `SELECT day, runs, failed_runs, generation_attempts, generation_failures,
              CASE WHEN generation_attempts > 0
                THEN CAST(generation_failures AS REAL) / generation_attempts END AS generation_failure_rate,
              output_attempts, output_failures,
              CASE WHEN output_attempts > 0
                THEN CAST(output_failures AS REAL) / output_attempts END AS output_failure_rate
       FROM (
         SELECT date(started_at, ?) AS day,
                COUNT(*) AS runs,
                SUM(CASE WHEN status IN (${FAILED_RUN_STATUSES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END) AS failed_runs,
                SUM(COALESCE(json_extract(stats_json, '$.generation.attempted'), 0)) AS generation_attempts,
                SUM(COALESCE(json_extract(stats_json, '$.generation.failed'), 0)) AS generation_failures,
                SUM(COALESCE(outputs_total, 0)) AS output_attempts,
                SUM(COALESCE(outputs_failed, 0)) AS output_failures
         FROM app_runs
         WHERE started_at >= ? AND started_at < ? AND status <> 'running'${clause}
         GROUP BY day
       )
       ORDER BY day`,
      dayModifier(range), ...FAILED_RUN_STATUSES, range.from, range.to, ...params,
    ).toArray().map(row => ({
      day: row.day,
      runs: Number(row.runs),
      failedRuns: Number(row.failed_runs),
      generationAttempts: Number(row.generation_attempts),
      generationFailures: Number(row.generation_failures),
      generationFailureRate: row.generation_failure_rate === null ? null : Number(row.generation_failure_rate),
      outputAttempts: Number(row.output_attempts),
      outputFailures: Number(row.output_failures),
      outputFailureRate: row.output_failure_rate === null ? null : Number(row.output_failure_rate),
    }));
  }

  _tokenUsagePerDay(range) {
    const { clause, params } = channelClause(range);
    return this._sql.exec(
      `SELECT date(started_at, ?) AS day,
              SUM(COALESCE(ai_input_tokens, 0)) AS input_tokens,
              SUM(COALESCE(ai_output_tokens, 0)) AS output_tokens
       FROM app_runs
       WHERE started_at >= ? AND started_at < ?${clause}
       GROUP BY day
       ORDER BY day`,
      dayModifier(range), range.from, range.to, ...params,
    ).toArray().map(row => ({
      day: row.day,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.input_tokens) + Number(row.output_tokens),
    }));
  }
}

/**
 * @param {unknown} query
 * @returns {{ from: string, to: string, channelId: string|null, utcOffsetMinutes: number }}
 * @throws {ValidationError}
 */
export function readStatsQuery(query) {
  const issues = new IssueCollector();
  const value = readObject(issues, query ?? {}, '', { allowed: QUERY_KEYS }) ?? {};
  const range = {
    from: readIsoInstant(issues, value.from, 'from'),
    to: readIsoInstant(issues, value.to, 'to'),
    channelId: readString(issues, value.channelId, 'channelId', {
      max: 64,
      pattern: CHANNEL_ID_PATTERN,
      patternMessage: 'ID kênh không hợp lệ.',
    }),
    utcOffsetMinutes: readQueryInteger(
      issues, value.utcOffsetMinutes, 'utcOffsetMinutes', MIN_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES, 0,
    ),
  };
  if (range.from === null) issues.add('from', 'required', 'Bắt buộc.');
  if (range.to === null) issues.add('to', 'required', 'Bắt buộc.');
  if (typeof range.from === 'string' && typeof range.to === 'string') {
    const span = Date.parse(range.to) - Date.parse(range.from);
    if (span <= 0) issues.add('to', 'invalid_range', '"to" phải sau "from".');
    else if (span > MAX_STATS_RANGE_DAYS * DAY_MS) {
      issues.add('to', 'range_too_long', `Khoảng thời gian tối đa ${MAX_STATS_RANGE_DAYS} ngày.`);
    }
  }
  if (issues.hasIssues) throw new ValidationError('Stats query is invalid', issues.issues);
  return range;
}

function channelClause(range) {
  return range.channelId
    ? { clause: ' AND channel_id = ?', params: [range.channelId] }
    : { clause: '', params: [] };
}

// A bound SQLite date modifier such as "+420 minutes".
function dayModifier(range) {
  const minutes = range.utcOffsetMinutes;
  return `${minutes < 0 ? '-' : '+'}${Math.abs(minutes)} minutes`;
}
