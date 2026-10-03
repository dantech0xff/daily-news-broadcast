import { describe, expect, it } from 'vitest';

import { describeCron, isValidCron, nextRuns } from './cron';

describe('cron helpers', () => {
  it('accepts the same grammar as the server', () => {
    for (const expression of ['0 0-17 * * *', '*/15 * * * *', '0 1,7,13 * * *', '30 8 * * 1-5', '0 9 1 1 7', '0 0-23/2 * * *']) {
      expect(isValidCron(expression), expression).toBe(true);
    }
    for (const expression of ['', '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '5/2 * * * *', '0 5-3 * * *', '0 * * * MON']) {
      expect(isValidCron(expression), expression).toBe(false);
    }
  });

  it('describes common schedules in Vietnamese', () => {
    expect(describeCron('0 0-17 * * *')).toBe('Đầu mỗi giờ từ 0 giờ đến 17 giờ, hằng ngày');
    expect(describeCron('0 1,7,13 * * *')).toBe('Lúc 01:00, 07:00, 13:00, hằng ngày');
    expect(describeCron('*/15 * * * *')).toBe('Mỗi 15 phút, hằng ngày');
    expect(describeCron('30 8 * * 1-5')).toBe('Lúc 08:30, vào Thứ Hai–Thứ Sáu');
    expect(describeCron('bogus')).toBeNull();
  });

  it('lists the next runs in the channel timezone', () => {
    const from = new Date('2026-10-03T16:30:00.000Z');
    expect(nextRuns('0 0-17 * * *', 'UTC', 3, from).map(date => date.toISOString())).toEqual([
      '2026-10-03T17:00:00.000Z',
      '2026-10-04T00:00:00.000Z',
      '2026-10-04T01:00:00.000Z',
    ]);
    // 07:00 in Ho Chi Minh City (UTC+7) is 00:00 UTC.
    expect(nextRuns('0 7 * * *', 'Asia/Ho_Chi_Minh', 2, from).map(date => date.toISOString())).toEqual([
      '2026-10-04T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
    ]);
  });

  it('applies every field together, like the server', () => {
    // Friday the 13th only (AND of day-of-month and weekday).
    const runs = nextRuns('0 9 13 * 5', 'UTC', 2, new Date('2026-10-03T00:00:00.000Z')).map(date => date.toISOString());
    expect(runs).toEqual(['2026-11-13T09:00:00.000Z', '2027-08-13T09:00:00.000Z']);
    // Weekday 7 is Sunday; a bare 7 in another field means 7 only.
    expect(nextRuns('0 12 * * 7', 'UTC', 1, new Date('2026-10-03T00:00:00.000Z'))[0]?.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(nextRuns('7 7 * * *', 'UTC', 2, new Date('2026-10-03T00:00:00.000Z')).map(date => date.toISOString()))
      .toEqual(['2026-10-03T07:07:00.000Z', '2026-10-04T07:07:00.000Z']);
  });

  it('skips wall-clock times that do not exist in a daylight-saving gap', () => {
    // 2027-03-14 02:30 does not exist in New York (clocks jump from 02:00 to 03:00).
    const runs = nextRuns('30 2 * * *', 'America/New_York', 2, new Date('2027-03-13T12:00:00.000Z')).map(date => date.toISOString());
    expect(runs).toEqual(['2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z']);
  });

  it('returns nothing for invalid input', () => {
    expect(nextRuns('nope', 'UTC')).toEqual([]);
    expect(nextRuns('0 * * * *', 'Not/AZone')).toEqual([]);
  });
});
