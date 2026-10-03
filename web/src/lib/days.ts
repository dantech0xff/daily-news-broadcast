/**
 * Calendar days (`YYYY-MM-DD`) at a fixed UTC offset. Statistics and the
 * library's date filters use Vietnam time (UTC+7, no daylight saving): the
 * same day boundary the stats API applies with `utcOffsetMinutes=420`, so a
 * day in a chart and the same day in a library filter cover the same posts.
 */

import { VIETNAM_UTC_OFFSET_MINUTES } from '../api/endpoints';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds of 00:00 UTC on `day`, or `NaN` when it is not a real calendar day. */
function utcMidnight(day: string): number {
  const match = DAY_PATTERN.exec(day);
  if (!match) return Number.NaN;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Round-tripping rejects impossible dates that Date would roll over (30 February).
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : Number.NaN;
}

function requireDay(day: string): number {
  const time = utcMidnight(day);
  if (Number.isNaN(time)) throw new RangeError(`Not a calendar day: ${day}`);
  return time;
}

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && !Number.isNaN(utcMidnight(value));
}

/** The calendar day of `instant` at `offsetMinutes` from UTC. */
export function dayAt(instant: number, offsetMinutes: number = VIETNAM_UTC_OFFSET_MINUTES): string {
  return new Date(instant + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/** Today in Vietnam time. */
export function todayInVietnam(now: number = Date.now()): string {
  return dayAt(now);
}

/** `day` moved by `delta` days. */
export function addDays(day: string, delta: number): string {
  return new Date(requireDay(day) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** ISO instant of 00:00 on `day` at `offsetMinutes` from UTC: the inclusive start of that day. */
export function dayStartInstant(day: string, offsetMinutes: number = VIETNAM_UTC_OFFSET_MINUTES): string {
  return new Date(requireDay(day) - offsetMinutes * MINUTE_MS).toISOString();
}

/** Days from `from` to `to`, both included (0 or less when `to` is before `from`). */
export function daySpan(from: string, to: string): number {
  return Math.round((requireDay(to) - requireDay(from)) / DAY_MS) + 1;
}

/** Every day from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const count = daySpan(from, to);
  return Array.from({ length: Math.max(0, count) }, (_, index) => addDays(from, index));
}
