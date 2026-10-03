/**
 * Cron helpers for the channel schedule form. The grammar mirrors the server
 * (`validateCronExpression` in `src/channels/runner.js`): five fields
 * "minute hour day month weekday", each a comma list of `*`, `*\/n`, `a-b`,
 * `a-b/n`, or a number. Run times follow the app scheduler, which fires on
 * node-cron ticks that also pass `shouldRun`: a time matches only when every
 * field matches (AND), and weekday 0 and 7 are Sunday.
 * The server stays authoritative; these helpers only give instant feedback,
 * a Vietnamese description, and the next run times.
 */

const LIMITS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const DAY_MS = 86_400_000;
/** Far enough to find yearly and leap-day schedules. */
const SEARCH_DAYS = 366 * 4 + 1;

interface CronPart {
  range: '*' | [number, number] | number;
  step: number;
  /** Raw text of the range, needed for the weekday `7` rule. */
  text: string;
}

export interface ParsedCron {
  fields: string[];
  parts: CronPart[][];
}

export function parseCron(expression: string): ParsedCron | null {
  if (typeof expression !== 'string') return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parts: CronPart[][] = [];
  for (const [index, field] of fields.entries()) {
    const limits = LIMITS[index];
    if (!limits || field === '') return null;
    const fieldParts: CronPart[] = [];
    for (const part of field.split(',')) {
      const parsed = parsePart(part, limits);
      if (!parsed) return null;
      fieldParts.push(parsed);
    }
    parts.push(fieldParts);
  }
  return { fields, parts };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

function parsePart(part: string, [min, max]: readonly [number, number]): CronPart | null {
  const pieces = part.split('/');
  if (pieces.length > 2) return null;
  const [range = '', stepText] = pieces;
  let step = 1;
  if (stepText !== undefined) {
    if (!isIntegerIn(stepText, 1, max - min + 1)) return null;
    step = Number(stepText);
  }
  if (range === '*') return { range: '*', step, text: range };
  if (range.includes('-')) {
    const bounds = range.split('-');
    const [low = '', high = ''] = bounds;
    if (bounds.length !== 2 || !isIntegerIn(low, min, max) || !isIntegerIn(high, min, max) || Number(low) > Number(high)) return null;
    return { range: [Number(low), Number(high)], step, text: range };
  }
  if (stepText !== undefined || !isIntegerIn(range, min, max)) return null;
  return { range: Number(range), step, text: range };
}

function isIntegerIn(text: string, min: number, max: number): boolean {
  return /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max;
}

const WEEKDAY_FIELD = 4;

function matchesPart(part: CronPart, value: number, min: number, weekday: boolean): boolean {
  // Weekday 7 is Sunday (0). Only the weekday field: node-cron fires a bare
  // "7" in the minute or hour field at 7 alone, and that is when runs happen.
  const normalized = weekday && value === 0 && part.text === '7' ? 7 : value;
  if (part.range === '*') return (normalized - min) % part.step === 0;
  if (Array.isArray(part.range)) {
    const [low, high] = part.range;
    return normalized >= low && normalized <= high && (normalized - low) % part.step === 0;
  }
  return normalized === part.range;
}

function matchesField(parts: CronPart[], value: number, index: number): boolean {
  const min = LIMITS[index]?.[0] ?? 0;
  return parts.some(part => matchesPart(part, value, min, index === WEEKDAY_FIELD));
}

function valuesOf(parts: CronPart[], index: number): number[] {
  const [min, max] = LIMITS[index] ?? [0, 0];
  const values: number[] = [];
  for (let value = min; value <= max; value += 1) if (matchesField(parts, value, index)) values.push(value);
  return values;
}

// ---------------------------------------------------------------------------
// Next run times in a time zone

const partFormats = new Map<string, Intl.DateTimeFormat>();

function wallClockParts(instant: number, timeZone: string): [number, number, number, number, number] {
  let format = partFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    partFormats.set(timeZone, format);
  }
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return [values.year ?? 0, values.month ?? 1, values.day ?? 1, (values.hour ?? 0) % 24, values.minute ?? 0];
}

// The instant whose wall-clock time in `timeZone` is the given one, or null
// when that time does not exist there (a daylight-saving gap).
function wallClockToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [y, mo, d, h, mi] = wallClockParts(instant, timeZone);
    const offset = Date.UTC(y, mo - 1, d, h, mi) - instant;
    const next = target - offset;
    if (next === instant) break;
    instant = next;
  }
  const [y, mo, d, h, mi] = wallClockParts(instant, timeZone);
  return y === year && mo === month && d === day && h === hour && mi === minute ? instant : null;
}

/** The next `count` run times strictly after `from`, evaluated in `timeZone`. */
export function nextRuns(expression: string, timeZone: string, count = 5, from: Date = new Date()): Date[] {
  const parsed = parseCron(expression);
  if (!parsed || count < 1) return [];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return [];
  }
  const [minuteParts = [], hourParts = [], dayParts = [], monthParts = [], weekdayParts = []] = parsed.parts;
  const minutes = valuesOf(minuteParts, 0);
  const hours = valuesOf(hourParts, 1);
  const start = from.getTime();
  const [startYear, startMonth, startDay, startHour, startMinute] = wallClockParts(start, timeZone);
  const startDate = Date.UTC(startYear, startMonth - 1, startDay);
  const runs: Date[] = [];

  for (let offset = 0; offset < SEARCH_DAYS && runs.length < count; offset += 1) {
    const date = new Date(startDate + offset * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!matchesField(monthParts, month, 3) || !matchesField(dayParts, day, 2) || !matchesField(weekdayParts, date.getUTCDay(), 4)) continue;
    for (const hour of hours) {
      // On the first day, skip slots already past on the wall clock (cheap; the instant check below stays exact).
      if (offset === 0 && hour < startHour) continue;
      for (const minute of minutes) {
        if (offset === 0 && hour === startHour && minute < startMinute) continue;
        const instant = wallClockToInstant(year, month, day, hour, minute, timeZone);
        if (instant !== null && instant > start) {
          runs.push(new Date(instant));
          if (runs.length >= count) return runs;
        }
      }
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Vietnamese description

const pad = (value: number) => String(value).padStart(2, '0');

function describeParts(parts: CronPart[], unit: (value: number) => string): string {
  return parts.map(part => {
    if (part.range === '*') return part.step === 1 ? 'mọi giá trị' : `mỗi ${part.step}`;
    if (Array.isArray(part.range)) {
      const span = `${unit(part.range[0])}–${unit(part.range[1])}`;
      return part.step === 1 ? span : `${span} (mỗi ${part.step})`;
    }
    return unit(part.range);
  }).join(', ');
}

function singleValue(parts: CronPart[]): number | null {
  const [only] = parts;
  return parts.length === 1 && only && typeof only.range === 'number' ? only.range : null;
}

function singleValues(parts: CronPart[]): number[] | null {
  const values = parts.map(part => (typeof part.range === 'number' ? part.range : null));
  return values.every((value): value is number => value !== null) ? values : null;
}

function isEvery(parts: CronPart[]): boolean {
  const [only] = parts;
  return parts.length === 1 && only?.range === '*' && only.step === 1;
}

function describeTime(minuteParts: CronPart[], hourParts: CronPart[]): string {
  const minute = singleValue(minuteParts);
  const hourList = singleValues(hourParts);
  const [hourPart] = hourParts;
  if (minute !== null && hourList) return `lúc ${hourList.map(hour => `${pad(hour)}:${pad(minute)}`).join(', ')}`;
  const atMinute = minute === 0 ? 'đầu mỗi giờ' : minute !== null ? `phút ${minute} mỗi giờ` : null;
  if (atMinute && isEvery(hourParts)) return atMinute;
  if (atMinute && hourParts.length === 1 && hourPart && Array.isArray(hourPart.range)) {
    const [low, high] = hourPart.range;
    const every = hourPart.step === 1 ? '' : `, cách ${hourPart.step} giờ`;
    return `${atMinute} từ ${low} giờ đến ${high} giờ${every}`;
  }
  if (atMinute && hourParts.length === 1 && hourPart?.range === '*') return `${atMinute.replace('mỗi giờ', `mỗi ${hourPart.step} giờ`)}`;
  if (isEvery(minuteParts) && isEvery(hourParts)) return 'mỗi phút';
  const [minutePart] = minuteParts;
  if (minuteParts.length === 1 && minutePart?.range === '*' && isEvery(hourParts)) return `mỗi ${minutePart.step} phút`;
  return `phút ${describeParts(minuteParts, String)}, giờ ${describeParts(hourParts, String)}`;
}

function describeDays(dayParts: CronPart[], monthParts: CronPart[], weekdayParts: CronPart[]): string {
  const segments: string[] = [];
  if (!isEvery(weekdayParts)) segments.push(`vào ${describeParts(weekdayParts, value => WEEKDAYS[value] ?? String(value))}`);
  if (!isEvery(dayParts)) segments.push(`ngày ${describeParts(dayParts, String)} trong tháng`);
  if (!isEvery(monthParts)) segments.push(`tháng ${describeParts(monthParts, String)}`);
  return segments.length > 0 ? segments.join(', ') : 'hằng ngày';
}

/** "Đầu mỗi giờ từ 0 giờ đến 17 giờ, hằng ngày" — or null when the expression is invalid. */
export function describeCron(expression: string): string | null {
  const parsed = parseCron(expression);
  if (!parsed) return null;
  const [minuteParts = [], hourParts = [], dayParts = [], monthParts = [], weekdayParts = []] = parsed.parts;
  const text = `${describeTime(minuteParts, hourParts)}, ${describeDays(dayParts, monthParts, weekdayParts)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
