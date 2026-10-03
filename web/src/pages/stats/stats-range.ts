/**
 * Statistics range ↔ URL ↔ `GET /api/stats` parameters.
 *
 * URL: `range` = `7` | `30` | `90` (the last N days including today, the
 * default is 30) or `custom` with `from`/`to` (calendar days, both
 * included); `channel` filters one channel. Days are Vietnam days: the API
 * gets `from` = 00:00 of the first day and `to` = 00:00 after the last day
 * (exclusive) in UTC+7, plus `utcOffsetMinutes=420` so it groups by the same
 * days.
 */

import { VIETNAM_UTC_OFFSET_MINUTES } from '../../api/endpoints';
import type { StatsQuery } from '../../api/types';
import { addDays, dayStartInstant, daySpan, eachDay, isDay } from '../../lib/days';

export const RANGE_PRESETS = ['7', '30', '90'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = '30';
/** Fallback of `meta.stats.maxRangeDays`. */
export const DEFAULT_MAX_RANGE_DAYS = 400;

export interface StatsView {
  preset: RangePreset | 'custom';
  /** Custom range (`YYYY-MM-DD` or `''`); unused by presets. */
  from: string;
  to: string;
  /** `''` = every channel. */
  channelId: string;
}

export type ResolvedRange =
  | { ok: true; fromDay: string; toDay: string; days: string[]; query: StatsQuery }
  | { ok: false; error: string };

export function parseStatsParams(params: URLSearchParams): StatsView {
  const range = params.get('range');
  const preset = range === 'custom' ? 'custom' : RANGE_PRESETS.find(entry => entry === range) ?? DEFAULT_PRESET;
  const from = params.get('from');
  const to = params.get('to');
  return {
    preset,
    from: isDay(from) ? from : '',
    to: isDay(to) ? to : '',
    channelId: (params.get('channel') ?? '').trim(),
  };
}

/** The URL form of a view; the default preset and unused dates are left out. */
export function statsParams(view: StatsView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.preset !== DEFAULT_PRESET) params.set('range', view.preset);
  if (view.preset === 'custom') {
    if (view.from) params.set('from', view.from);
    if (view.to) params.set('to', view.to);
  }
  if (view.channelId) params.set('channel', view.channelId);
  return params;
}

/** Why a custom range cannot be requested, or `null`. */
export function customRangeError(from: string, to: string, maxRangeDays: number): string | null {
  if (!isDay(from) || !isDay(to)) return 'Chọn cả Từ ngày và Đến ngày.';
  const span = daySpan(from, to);
  if (span < 1) return 'Đến ngày phải bằng hoặc sau Từ ngày.';
  if (span > maxRangeDays) return `Khoảng thời gian tối đa ${maxRangeDays} ngày.`;
  return null;
}

/** Days and API query of a view; `today` is today in Vietnam time. */
export function resolveStatsRange(view: StatsView, { today, maxRangeDays }: { today: string; maxRangeDays: number }): ResolvedRange {
  let fromDay: string;
  let toDay: string;
  if (view.preset === 'custom') {
    const error = customRangeError(view.from, view.to, maxRangeDays);
    if (error) return { ok: false, error };
    fromDay = view.from;
    toDay = view.to;
  } else {
    toDay = today;
    fromDay = addDays(today, 1 - Number(view.preset));
  }
  const query: StatsQuery = {
    from: dayStartInstant(fromDay),
    to: dayStartInstant(addDays(toDay, 1)),
    ...(view.channelId ? { channelId: view.channelId } : {}),
    utcOffsetMinutes: VIETNAM_UTC_OFFSET_MINUTES,
  };
  return { ok: true, fromDay, toDay, days: eachDay(fromDay, toDay), query };
}
