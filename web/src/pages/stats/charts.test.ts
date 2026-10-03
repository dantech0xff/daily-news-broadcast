import { describe, expect, it } from 'vitest';

import { niceScale, seriesColor } from './charts';

describe('chart scales', () => {
  it('covers the data with about four round integer steps', () => {
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(18)).toEqual({ max: 20, ticks: [0, 5, 10, 15, 20] });
    expect(niceScale(12_000)).toEqual({ max: 15_000, ticks: [0, 5_000, 10_000, 15_000] });
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('cycles the palette for many series', () => {
    expect(seriesColor(0)).toEqual(seriesColor(8));
    expect(seriesColor(1)).not.toEqual(seriesColor(0));
  });
});
