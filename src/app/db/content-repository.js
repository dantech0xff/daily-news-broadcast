/**
 * Content library backed by `app_content_items`: one row per channel article,
 * keyed by the delivery store's canonical article key (`channelArticleHash`),
 * so scan observations and delivery projections land on the same row and
 * repeated runs never duplicate it.
 *
 * Two writers feed the library:
 * - scan observations record each candidate a run's selection chain saw as
 *   `selected` or `rejected` (with a reason); they never overwrite a row that
 *   already carries a delivery status;
 * - delivery projections copy the delivery store's state (queued … delivered)
 *   over the row and are idempotent, so re-syncing changes nothing.
 * Delivered rows are kept forever; retention only prunes settled rows that
 * were never delivered.
 */

import { randomUUID } from 'node:crypto';

import { CHANNEL_ID_PATTERN } from '../channels/config-schema.js';
import {
  IssueCollector,
  ValidationError,
  readEnum,
  readIsoInstant,
  readObject,
  readString,
} from '../channels/validation.js';

/** Statuses written by scan observations. */
export const SCAN_STATUSES = Object.freeze(['selected', 'rejected']);
/** Statuses projected from the delivery store. */
export const DELIVERY_CONTENT_STATUSES = Object.freeze([
  'queued', 'generating', 'delivering', 'delivered', 'generation_failed', 'failed', 'ambiguous', 'blocked', 'abandoned',
]);
export const CONTENT_STATUSES = Object.freeze([...SCAN_STATUSES, ...DELIVERY_CONTENT_STATUSES]);
/** Why a selection stage dropped a candidate. */
export const REJECT_REASONS = Object.freeze(['before_cutoff', 'not_tech', 'low_score', 'duplicate']);
/** Settled, never-delivered statuses that retention may prune. */
export const PRUNABLE_CONTENT_STATUSES = Object.freeze(['selected', 'rejected', 'abandoned']);
/** Library date filters and the column each one reads. */
export const CONTENT_DATE_FIELDS = Object.freeze({ seen: 'last_seen_at', published: 'published_at', delivered: 'delivered_at' });

export const MAX_CONTENT_PAGE_SIZE = 100;
const DEFAULT_CONTENT_PAGE_SIZE = 50;
const MAX_CONTENT_OFFSET = 100_000;
const MAX_STATUS_FILTERS = CONTENT_STATUSES.length;
const MAX_KEYWORD_LENGTH = 200;
const SUMMARY_PREVIEW_LENGTH = 300;
const QUERY_KEYS = Object.freeze(['channelId', 'status', 'source', 'dateField', 'from', 'to', 'keyword', 'limit', 'offset']);

const ITEM_COLUMNS = `
  id, channel_id, article_key, title, url, source_id, source_name, category, published_at,
  first_seen_at, last_seen_at, status, reject_reason, delivery_id, message_id, delivered_at, run_id, updated_at
`;

const UPSERT_SCAN_SQL = `
  INSERT INTO app_content_items (
    id, channel_id, article_key, title, url, source_id, source_name, category, published_at,
    first_seen_at, last_seen_at, status, reject_reason, run_id, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(channel_id, article_key) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    source_id = COALESCE(excluded.source_id, app_content_items.source_id),
    source_name = excluded.source_name,
    category = COALESCE(excluded.category, app_content_items.category),
    published_at = COALESCE(excluded.published_at, app_content_items.published_at),
    last_seen_at = MAX(app_content_items.last_seen_at, excluded.last_seen_at),
    status = excluded.status,
    reject_reason = excluded.reject_reason,
    run_id = excluded.run_id,
    updated_at = excluded.updated_at
  WHERE app_content_items.status IN ('selected', 'rejected')
`;

// The WHERE clause skips no-op updates so a repeated sync leaves rows untouched.
const UPSERT_DELIVERY_SQL = `
  INSERT INTO app_content_items (
    id, channel_id, article_key, title, url, source_id, source_name, category, published_at,
    first_seen_at, last_seen_at, status, reject_reason, delivery_id, summary_text, message_id,
    delivered_at, run_id, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(channel_id, article_key) DO UPDATE SET
    title = excluded.title,
    url = COALESCE(excluded.url, app_content_items.url),
    source_name = excluded.source_name,
    category = COALESCE(excluded.category, app_content_items.category),
    published_at = COALESCE(excluded.published_at, app_content_items.published_at),
    status = excluded.status,
    reject_reason = NULL,
    delivery_id = excluded.delivery_id,
    summary_text = COALESCE(excluded.summary_text, app_content_items.summary_text),
    message_id = COALESCE(excluded.message_id, app_content_items.message_id),
    delivered_at = COALESCE(app_content_items.delivered_at, excluded.delivered_at),
    run_id = COALESCE(app_content_items.run_id, excluded.run_id),
    updated_at = excluded.updated_at
  WHERE app_content_items.status IS NOT excluded.status
    OR app_content_items.delivery_id IS NOT excluded.delivery_id
    OR app_content_items.reject_reason IS NOT NULL
    OR app_content_items.title IS NOT excluded.title
    OR (excluded.summary_text IS NOT NULL AND app_content_items.summary_text IS NOT excluded.summary_text)
    OR (excluded.message_id IS NOT NULL AND app_content_items.message_id IS NOT excluded.message_id)
    OR (app_content_items.delivered_at IS NULL AND excluded.delivered_at IS NOT NULL)
`;

/**
 * @typedef {object} ScanObservation
 * @property {string} channelId
 * @property {string} articleKey Canonical delivery-store article key.
 * @property {string} title
 * @property {string|null} url
 * @property {string|null} sourceId Source plugin id when it is known.
 * @property {string} sourceName
 * @property {string|null} category
 * @property {string|null} publishedAt ISO instant.
 * @property {'selected'|'rejected'} status
 * @property {string|null} rejectReason One of `REJECT_REASONS` when rejected.
 * @property {string|null} runId
 * @property {string} seenAt ISO instant of the scan.
 */

/**
 * @typedef {object} DeliveryProjection
 * @property {string} channelId
 * @property {string} articleKey
 * @property {string} title
 * @property {string|null} url
 * @property {string} sourceName
 * @property {string|null} category
 * @property {string|null} publishedAt
 * @property {string} status One of `DELIVERY_CONTENT_STATUSES`.
 * @property {string} deliveryId
 * @property {string|null} summaryText Generated content.
 * @property {string|null} messageId Provider message id(s), comma separated.
 * @property {string|null} deliveredAt
 * @property {string} firstSeenAt Used only when the row is new.
 * @property {string|null} runId Used only when the row has none.
 */

/**
 * @typedef {object} ContentItem
 * @property {string} id
 * @property {string} channelId
 * @property {string} articleKey
 * @property {string|null} title
 * @property {string|null} url
 * @property {string|null} sourceId
 * @property {string|null} sourceName
 * @property {string|null} category
 * @property {string|null} publishedAt
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {string} status
 * @property {string|null} rejectReason
 * @property {string|null} deliveryId
 * @property {string|null} messageId
 * @property {string|null} deliveredAt
 * @property {string|null} runId
 * @property {string} updatedAt
 * @property {string|null} [summaryPreview] List results: first characters of the summary.
 * @property {string|null} [summaryText] `get()` results: the full generated summary.
 */

export class ContentRepository {
  /**
   * @param {{
   *   storage: import('./node-sql-storage.js').NodeSqlStorage,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ storage, clock = () => new Date() } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('ContentRepository requires SQL storage with exec() and transactionSync()');
    }
    if (typeof clock !== 'function') throw new TypeError('ContentRepository clock must be a function');
    this._storage = storage;
    this._clock = clock;
  }

  /**
   * Upsert scan observations in one transaction. Rows that already carry a
   * delivery status keep it: a scan can never downgrade a queued or
   * delivered article.
   * @param {ScanObservation[]} observations
   * @returns {number} Rows written.
   */
  recordScanObservations(observations) {
    if (!Array.isArray(observations)) throw new TypeError('Scan observations must be an array');
    if (observations.length === 0) return 0;
    const updatedAt = this._now();
    return this._storage.transactionSync(() => {
      for (const row of observations) {
        assertScanObservation(row);
        this._storage.sql.exec(
          UPSERT_SCAN_SQL,
          randomUUID(), row.channelId, row.articleKey, row.title, row.url, row.sourceId, row.sourceName,
          row.category, row.publishedAt, row.seenAt, row.seenAt, row.status,
          row.status === 'rejected' ? row.rejectReason : null, row.runId, updatedAt,
        );
      }
      return observations.length;
    });
  }

  /**
   * Upsert delivery projections in one transaction, in the given order (pass
   * oldest first so the newest state of an article wins). No-op updates are
   * skipped, so projecting the same delivery state twice changes nothing.
   * @param {DeliveryProjection[]} projections
   * @returns {number} Rows inserted or changed.
   */
  applyDeliveryProjections(projections) {
    if (!Array.isArray(projections)) throw new TypeError('Delivery projections must be an array');
    if (projections.length === 0) return 0;
    const updatedAt = this._now();
    return this._storage.transactionSync(() => {
      let changed = 0;
      for (const row of projections) {
        assertDeliveryProjection(row);
        this._storage.sql.exec(
          UPSERT_DELIVERY_SQL,
          randomUUID(), row.channelId, row.articleKey, row.title, row.url, row.sourceName, row.category,
          row.publishedAt, row.firstSeenAt, row.firstSeenAt, row.status, row.deliveryId, row.summaryText,
          row.messageId, row.deliveredAt, row.runId, updatedAt,
        );
        changed += this._changes();
      }
      return changed;
    });
  }

  /**
   * Filtered, paginated library listing ordered by the chosen date field,
   * newest first (rows without that date last).
   * @param {{
   *   channelId?: string,
   *   status?: string|string[],
   *   source?: string,
   *   dateField?: 'seen'|'published'|'delivered',
   *   from?: string,
   *   to?: string,
   *   keyword?: string,
   *   limit?: number,
   *   offset?: number,
   * }} [query] `status` also accepts a comma-separated list; `source` matches
   *   the source name or id; `from` is inclusive and `to` exclusive; `keyword`
   *   searches title, URL, and summary.
   * @returns {{ items: ContentItem[], page: { limit: number, offset: number, total: number } }}
   * @throws {ValidationError}
   */
  list(query = {}) {
    const filters = readContentQuery(query);
    const where = [];
    const params = [];
    if (filters.channelId) {
      where.push('channel_id = ?');
      params.push(filters.channelId);
    }
    if (filters.statuses) {
      where.push(`status IN (${filters.statuses.map(() => '?').join(', ')})`);
      params.push(...filters.statuses);
    }
    if (filters.source) {
      where.push('(source_name = ? OR source_id = ?)');
      params.push(filters.source, filters.source);
    }
    const dateColumn = CONTENT_DATE_FIELDS[filters.dateField];
    if (filters.from) {
      where.push(`${dateColumn} >= ?`);
      params.push(filters.from);
    }
    if (filters.to) {
      where.push(`${dateColumn} < ?`);
      params.push(filters.to);
    }
    if (filters.keyword) {
      const pattern = `%${escapeLike(filters.keyword)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR summary_text LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { sql } = this._storage;
    const total = Number(sql.exec(`SELECT COUNT(*) AS total FROM app_content_items ${whereSql}`, ...params).one().total);
    const rows = sql.exec(
      `SELECT ${ITEM_COLUMNS}, substr(summary_text, 1, ${SUMMARY_PREVIEW_LENGTH}) AS summary_preview
       FROM app_content_items ${whereSql}
       ORDER BY ${dateColumn} IS NULL, ${dateColumn} DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...params,
      filters.limit,
      filters.offset,
    ).toArray();
    return {
      items: rows.map(row => ({ ...toItem(row), summaryPreview: row.summary_preview ?? null })),
      page: { limit: filters.limit, offset: filters.offset, total },
    };
  }

  /**
   * @param {string} id
   * @returns {ContentItem|null} With the full `summaryText`.
   */
  get(id) {
    if (typeof id !== 'string' || id === '' || id.length > 100) return null;
    const [row] = this._storage.sql.exec(
      `SELECT ${ITEM_COLUMNS}, summary_text FROM app_content_items WHERE id = ?`,
      id,
    ).toArray();
    return row ? { ...toItem(row), summaryText: row.summary_text ?? null } : null;
  }

  /**
   * Delete settled, never-delivered rows whose last scan and last change are
   * both older than `before`. Delivered rows and rows still in a delivery
   * state are never touched.
   * @param {{ before: Date }} options
   * @returns {number} Rows deleted.
   */
  pruneUndelivered({ before } = {}) {
    const cutoff = requireDate(before, 'Content retention cutoff').toISOString();
    return this._storage.transactionSync(() => {
      this._storage.sql.exec(
        `DELETE FROM app_content_items
         WHERE status IN (${PRUNABLE_CONTENT_STATUSES.map(() => '?').join(', ')})
           AND last_seen_at < ? AND updated_at < ?`,
        ...PRUNABLE_CONTENT_STATUSES,
        cutoff,
        cutoff,
      );
      return this._changes();
    });
  }

  _changes() {
    return Number(this._storage.sql.exec('SELECT changes() AS count').one().count);
  }

  _now() {
    return requireDate(this._clock(), 'ContentRepository clock').toISOString();
  }
}

/**
 * Validate and normalize library query input.
 * @param {unknown} query
 * @returns {{
 *   channelId: string|null, statuses: string[]|null, source: string|null,
 *   dateField: 'seen'|'published'|'delivered', from: string|null, to: string|null,
 *   keyword: string|null, limit: number, offset: number,
 * }}
 * @throws {ValidationError}
 */
export function readContentQuery(query) {
  const issues = new IssueCollector();
  const value = readObject(issues, query ?? {}, '', { allowed: QUERY_KEYS }) ?? {};
  const filters = {
    channelId: readString(issues, value.channelId, 'channelId', {
      max: 64,
      pattern: CHANNEL_ID_PATTERN,
      patternMessage: 'ID kênh không hợp lệ.',
    }),
    statuses: readStatuses(issues, value.status),
    source: readString(issues, value.source, 'source', { max: 200 }),
    dateField: readEnum(issues, value.dateField, 'dateField', Object.keys(CONTENT_DATE_FIELDS), { defaultValue: 'seen' }),
    from: readIsoInstant(issues, value.from, 'from'),
    to: readIsoInstant(issues, value.to, 'to'),
    keyword: readString(issues, value.keyword, 'keyword', { max: MAX_KEYWORD_LENGTH }),
    limit: readQueryInteger(issues, value.limit, 'limit', 1, MAX_CONTENT_PAGE_SIZE, DEFAULT_CONTENT_PAGE_SIZE),
    offset: readQueryInteger(issues, value.offset, 'offset', 0, MAX_CONTENT_OFFSET, 0),
  };
  if (typeof filters.from === 'string' && typeof filters.to === 'string' && filters.from >= filters.to) {
    issues.add('to', 'invalid_range', '"to" phải sau "from".');
  }
  if (issues.hasIssues) throw new ValidationError('Content query is invalid', issues.issues);
  return filters;
}

/**
 * Integer query parameter that may arrive as a decimal string from a URL.
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {number} defaultValue
 * @returns {number|undefined}
 */
export function readQueryInteger(issues, value, field, min, max, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const number = typeof value === 'string' && /^-?\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    return issues.add(field, 'invalid_type', 'Phải là số nguyên.');
  }
  if (number < min || number > max) return issues.add(field, 'out_of_range', `Phải từ ${min} đến ${max}.`);
  return number;
}

function readStatuses(issues, value) {
  if (value === undefined || value === null || value === '') return null;
  const list = typeof value === 'string' ? value.split(',').map(entry => entry.trim()).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_STATUS_FILTERS
    || list.some(entry => typeof entry !== 'string' || !CONTENT_STATUSES.includes(entry))) {
    return issues.add('status', 'invalid_value', `Trạng thái hợp lệ: ${CONTENT_STATUSES.join(', ')}.`);
  }
  return [...new Set(list)];
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, character => `\\${character}`);
}

function toItem(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    articleKey: row.article_key,
    title: row.title ?? null,
    url: row.url ?? null,
    sourceId: row.source_id ?? null,
    sourceName: row.source_name ?? null,
    category: row.category ?? null,
    publishedAt: row.published_at ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    rejectReason: row.reject_reason ?? null,
    deliveryId: row.delivery_id ?? null,
    messageId: row.message_id ?? null,
    deliveredAt: row.delivered_at ?? null,
    runId: row.run_id ?? null,
    updatedAt: row.updated_at,
  };
}

function assertScanObservation(row) {
  assertRowIdentity(row);
  if (!SCAN_STATUSES.includes(row.status)) throw new TypeError(`Invalid scan status: ${String(row.status)}`);
  if (row.status === 'rejected' && !REJECT_REASONS.includes(row.rejectReason)) {
    throw new TypeError(`Invalid reject reason: ${String(row.rejectReason)}`);
  }
  requireIso(row.seenAt, 'seenAt');
}

function assertDeliveryProjection(row) {
  assertRowIdentity(row);
  if (!DELIVERY_CONTENT_STATUSES.includes(row.status)) throw new TypeError(`Invalid delivery content status: ${String(row.status)}`);
  if (typeof row.deliveryId !== 'string' || row.deliveryId === '') throw new TypeError('Delivery projection requires a deliveryId');
  requireIso(row.firstSeenAt, 'firstSeenAt');
}

function assertRowIdentity(row) {
  if (!row || typeof row !== 'object') throw new TypeError('Content row must be an object');
  if (typeof row.channelId !== 'string' || !CHANNEL_ID_PATTERN.test(row.channelId)) {
    throw new TypeError('Content row requires a channel id');
  }
  if (typeof row.articleKey !== 'string' || !/^[a-f0-9]{64}$/.test(row.articleKey)) {
    throw new TypeError('Content row requires a canonical article key');
  }
  if (typeof row.title !== 'string' || row.title === '') throw new TypeError('Content row requires a title');
  if (typeof row.sourceName !== 'string' || row.sourceName === '') throw new TypeError('Content row requires a source name');
}

function requireIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO instant`);
}

function requireDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid Date`);
  return value;
}
