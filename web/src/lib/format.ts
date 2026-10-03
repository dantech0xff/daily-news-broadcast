/** Vietnamese date, time, and number formatting. Missing or invalid values render as "—". */

const EMPTY = '—';
const LOCALE = 'vi-VN';

const numberFormat = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });
const relativeFormat = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    });
    dateTimeFormats.set(key, format);
  }
  return format;
}

export function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `03/10/2026 15:04` in the browser time zone (or `timeZone`). */
export function formatDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  const date = value instanceof Date ? value : parseInstant(value);
  if (!date) return EMPTY;
  try {
    return dateTimeFormat(timeZone).format(date);
  } catch {
    return dateTimeFormat().format(date);
  }
}

/** `5 phút trước`, `hôm qua`, `trong 2 giờ nữa`. */
export function formatRelative(value: string | Date | null | undefined, now: number = Date.now()): string {
  const date = value instanceof Date ? value : parseInstant(value);
  if (!date) return EMPTY;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'vừa xong';
  if (abs < 45 * 60) return relativeFormat.format(Math.round(seconds / 60), 'minute');
  if (abs < 22 * 3600) return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  if (abs < 26 * 86400) return relativeFormat.format(Math.round(seconds / 86400), 'day');
  return formatDateTime(date);
}

/** `850 ms`, `12,4 giây`, `3 phút 5 giây`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(seconds)} giây`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} phút ${rest} giây` : `${minutes} phút`;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? EMPTY : numberFormat.format(value);
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? EMPTY : percentFormat.format(ratio);
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
export function formatDay(day: string | null | undefined): string {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : EMPTY;
}

/** `YYYY-MM-DD` → `DD/MM` (chart axes). */
export function formatShortDay(day: string | null | undefined): string {
  const match = day ? /^\d{4}-(\d{2})-(\d{2})$/.exec(day) : null;
  return match ? `${match[2]}/${match[1]}` : EMPTY;
}

/** Value for `<input type="datetime-local">` (browser time zone, minute precision). */
export function toLocalInputValue(value: string | null | undefined): string {
  const date = parseInstant(value);
  if (!date) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `<input type="datetime-local">` value (browser time zone) → ISO instant, or `null` when empty/invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
