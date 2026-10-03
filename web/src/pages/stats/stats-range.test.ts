import { describe, expect, it } from 'vitest';

import { customRangeError, parseStatsParams, resolveStatsRange, statsParams } from './stats-range';

const TODAY = '2026-10-03';

describe('stats range', () => {
  it('defaults to the last 30 Vietnam days including today', () => {
    const range = resolveStatsRange(parseStatsParams(new URLSearchParams()), { today: TODAY, maxRangeDays: 400 });
    expect(range).toMatchObject({
      ok: true,
      fromDay: '2026-09-04',
      toDay: TODAY,
      query: { from: '2026-09-03T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', utcOffsetMinutes: 420 },
    });
    expect(range.ok && range.days).toHaveLength(30);
    expect(range.ok && 'channelId' in range.query).toBe(false);
  });

  it('resolves presets and channel filters, and writes the URL without defaults', () => {
    const view = parseStatsParams(new URLSearchParams('range=7&channel=telegram-ops&from=2026-01-01'));
    expect(view).toEqual({ preset: '7', from: '2026-01-01', to: '', channelId: 'telegram-ops' });
    expect(resolveStatsRange(view, { today: TODAY, maxRangeDays: 400 })).toMatchObject({
      ok: true,
      query: { from: '2026-09-26T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', channelId: 'telegram-ops', utcOffsetMinutes: 420 },
    });
    expect(statsParams(view).toString()).toBe('range=7&channel=telegram-ops');
    expect(statsParams({ ...view, preset: '30', channelId: '' }).toString()).toBe('');
  });

  it('validates custom ranges against the API maximum', () => {
    expect(customRangeError('2026-09-01', '2026-09-30', 400)).toBeNull();
    expect(customRangeError('2026-09-30', '2026-09-01', 400)).toBe('Đến ngày phải bằng hoặc sau Từ ngày.');
    expect(customRangeError('2025-01-01', '2026-09-30', 400)).toBe('Khoảng thời gian tối đa 400 ngày.');
    expect(customRangeError('', '2026-09-30', 400)).toBe('Chọn cả Từ ngày và Đến ngày.');

    const custom = parseStatsParams(new URLSearchParams('range=custom&from=2026-09-01&to=2026-09-30'));
    expect(resolveStatsRange(custom, { today: TODAY, maxRangeDays: 400 })).toMatchObject({
      ok: true,
      query: { from: '2026-08-31T17:00:00.000Z', to: '2026-09-30T17:00:00.000Z' },
    });
    expect(resolveStatsRange({ ...custom, to: '' }, { today: TODAY, maxRangeDays: 400 })).toEqual({ ok: false, error: 'Chọn cả Từ ngày và Đến ngày.' });
  });
});
