/** IANA time zones for the schedule form, common ones first. */

export const COMMON_TIME_ZONES = [
  'Asia/Ho_Chi_Minh',
  'UTC',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
] as const;

let cached: string[] | null = null;

/** Every zone the browser supports (plus UTC), sorted. */
export function allTimeZones(): string[] {
  if (!cached) {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    cached = [...new Set(['UTC', ...COMMON_TIME_ZONES, ...supported])].sort((left, right) => left.localeCompare(right));
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
