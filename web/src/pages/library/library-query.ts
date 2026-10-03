/**
 * Library filters ↔ URL query string ↔ `GET /api/content` parameters.
 *
 * URL (the applied filters, so a view can be linked and reloaded):
 * `channel`, `status` (comma list), `source`, `dateField`, `from` and `to`
 * (calendar days in Vietnam time, both included), `q` (keyword), `page`
 * (1-based), `limit`. Defaults are left out and invalid values ignored.
 *
 * API: `from` is 00:00 of the `from` day and `to` 00:00 of the day after
 * `to` (exclusive), both in Vietnam time like the statistics, so a library
 * day matches the same day in the charts.
 */

import type { ContentDateField, ContentQuery, ContentStatus } from '../../api/types';
import { addDays, dayStartInstant, isDay } from '../../lib/days';
import { CONTENT_DATE_FIELD_LABELS, CONTENT_STATUS_LABELS } from '../../lib/labels';

export const CONTENT_STATUS_OPTIONS = Object.keys(CONTENT_STATUS_LABELS) as ContentStatus[];
export const DATE_FIELD_OPTIONS = Object.keys(CONTENT_DATE_FIELD_LABELS) as ContentDateField[];
export const PAGE_SIZE_OPTIONS: readonly number[] = [20, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_DATE_FIELD: ContentDateField = 'seen';
export const TEXT_FILTER_MAX_LENGTH = 200;
const CHANNEL_ID_MAX_LENGTH = 64;
/** The API's largest offset. */
const MAX_OFFSET = 100_000;

export interface LibraryFilters {
  /** `''` = every channel. */
  channelId: string;
  /** Empty = every status. */
  statuses: ContentStatus[];
  source: string;
  dateField: ContentDateField;
  /** `YYYY-MM-DD` or `''`. */
  from: string;
  /** `YYYY-MM-DD` or `''` (included). */
  to: string;
  keyword: string;
}

export interface LibraryView extends LibraryFilters {
  page: number;
  limit: number;
}

export const DEFAULT_FILTERS: LibraryFilters = Object.freeze({
  channelId: '',
  statuses: [],
  source: '',
  dateField: DEFAULT_DATE_FIELD,
  from: '',
  to: '',
  keyword: '',
});

export function parseLibraryParams(params: URLSearchParams): LibraryView {
  const statuses = (params.get('status') ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(isContentStatus);
  const dateField = params.get('dateField');
  const limit = Number(params.get('limit'));
  const pageSize = PAGE_SIZE_OPTIONS.includes(limit) ? limit : DEFAULT_PAGE_SIZE;
  const page = Number(params.get('page'));
  const lastPage = Math.floor(MAX_OFFSET / pageSize) + 1;
  return {
    channelId: text(params.get('channel'), CHANNEL_ID_MAX_LENGTH),
    statuses: [...new Set(statuses)],
    source: text(params.get('source'), TEXT_FILTER_MAX_LENGTH),
    dateField: isDateField(dateField) ? dateField : DEFAULT_DATE_FIELD,
    from: dayOrEmpty(params.get('from')),
    to: dayOrEmpty(params.get('to')),
    keyword: text(params.get('q'), TEXT_FILTER_MAX_LENGTH),
    page: Number.isSafeInteger(page) && page >= 1 ? Math.min(page, lastPage) : 1,
    limit: pageSize,
  };
}

/** The URL form of a view; default values are left out. */
export function libraryParams(view: LibraryView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.channelId) params.set('channel', view.channelId);
  if (view.statuses.length > 0) params.set('status', view.statuses.join(','));
  if (view.source.trim()) params.set('source', view.source.trim());
  if (view.dateField !== DEFAULT_DATE_FIELD) params.set('dateField', view.dateField);
  if (view.from) params.set('from', view.from);
  if (view.to) params.set('to', view.to);
  if (view.keyword.trim()) params.set('q', view.keyword.trim());
  if (view.page > 1) params.set('page', String(view.page));
  if (view.limit !== DEFAULT_PAGE_SIZE) params.set('limit', String(view.limit));
  return params;
}

/** `GET /api/content` parameters of a view. */
export function toContentQuery(view: LibraryView): ContentQuery {
  return {
    channelId: view.channelId || undefined,
    status: view.statuses.length > 0 ? view.statuses : undefined,
    source: view.source.trim() || undefined,
    dateField: view.dateField,
    from: view.from ? dayStartInstant(view.from) : undefined,
    to: view.to ? dayStartInstant(addDays(view.to, 1)) : undefined,
    keyword: view.keyword.trim() || undefined,
    limit: view.limit,
    offset: (view.page - 1) * view.limit,
  };
}

export type FilterErrors = Partial<Record<keyof LibraryFilters, string>>;

export function validateFilters(filters: LibraryFilters): FilterErrors {
  const errors: FilterErrors = {};
  if (filters.from && filters.to && filters.to < filters.from) errors.to = 'Đến ngày phải bằng hoặc sau Từ ngày.';
  if (filters.source.trim().length > TEXT_FILTER_MAX_LENGTH) errors.source = `Tối đa ${TEXT_FILTER_MAX_LENGTH} ký tự.`;
  if (filters.keyword.trim().length > TEXT_FILTER_MAX_LENGTH) errors.keyword = `Tối đa ${TEXT_FILTER_MAX_LENGTH} ký tự.`;
  return errors;
}

/** Whether any filter differs from the defaults. */
export function hasFilters(filters: LibraryFilters): boolean {
  return Boolean(filters.channelId || filters.statuses.length > 0 || filters.source.trim() || filters.from || filters.to
    || filters.keyword.trim() || filters.dateField !== DEFAULT_DATE_FIELD);
}

function isContentStatus(value: string): value is ContentStatus {
  return CONTENT_STATUS_OPTIONS.some(status => status === value);
}

function isDateField(value: string | null): value is ContentDateField {
  return DATE_FIELD_OPTIONS.some(field => field === value);
}

function text(value: string | null, maximum: number): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length <= maximum ? trimmed : '';
}

function dayOrEmpty(value: string | null): string {
  return isDay(value) ? value : '';
}
