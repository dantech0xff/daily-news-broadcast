import { describe, expect, it } from 'vitest';

import { addDays, dayAt, dayStartInstant, daySpan, eachDay, isDay, todayInVietnam } from './days';

describe('Vietnam calendar days', () => {
  it('accepts real calendar days only', () => {
    expect(isDay('2026-10-03')).toBe(true);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-1-3')).toBe(false);
    expect(isDay('2026-10-03T00:00')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(isDay(null)).toBe(false);
  });

  it('starts each day at 00:00 UTC+7', () => {
    expect(dayAt(Date.parse('2026-10-02T16:59:59.999Z'))).toBe('2026-10-02');
    expect(dayAt(Date.parse('2026-10-02T17:00:00.000Z'))).toBe('2026-10-03');
    expect(todayInVietnam(Date.parse('2026-10-03T08:00:00.000Z'))).toBe('2026-10-03');
    expect(dayStartInstant('2026-10-03')).toBe('2026-10-02T17:00:00.000Z');
  });

  it('moves across month and year boundaries and counts days inclusively', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daySpan('2026-10-01', '2026-10-03')).toBe(3);
    expect(daySpan('2026-10-03', '2026-10-01')).toBe(-1);
    expect(eachDay('2026-09-29', '2026-10-01')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(eachDay('2026-10-02', '2026-10-01')).toEqual([]);
  });

  it('rejects malformed days instead of computing garbage', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => dayStartInstant('03/10/2026')).toThrow(RangeError);
  });
});
