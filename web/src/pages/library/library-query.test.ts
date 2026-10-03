import { describe, expect, it } from 'vitest';

import { libraryParams, parseLibraryParams, toContentQuery, validateFilters } from './library-query';

describe('library query', () => {
  it('reads the URL, drops invalid values, and writes it back without defaults', () => {
    const view = parseLibraryParams(new URLSearchParams(
      'channel=telegram-ops&status=delivered,bogus,rejected,delivered&source=Rust+Blog&dateField=delivered'
      + '&from=2026-10-01&to=2026-02-30&q=%20rust%20&page=3&limit=20',
    ));
    expect(view).toEqual({
      channelId: 'telegram-ops',
      statuses: ['delivered', 'rejected'],
      source: 'Rust Blog',
      dateField: 'delivered',
      from: '2026-10-01',
      to: '',
      keyword: 'rust',
      page: 3,
      limit: 20,
    });
    expect(libraryParams(view).toString()).toBe(
      'channel=telegram-ops&status=delivered%2Crejected&source=Rust+Blog&dateField=delivered&from=2026-10-01&q=rust&page=3&limit=20',
    );

    const defaults = parseLibraryParams(new URLSearchParams('dateField=nope&page=-2&limit=7'));
    expect(defaults).toMatchObject({ dateField: 'seen', page: 1, limit: 50, statuses: [] });
    expect(libraryParams(defaults).toString()).toBe('');
  });

  it('turns Vietnam days into an inclusive-exclusive instant range and the page into an offset', () => {
    const view = parseLibraryParams(new URLSearchParams('from=2026-10-01&to=2026-10-02&page=2&limit=100&status=rejected'));
    expect(toContentQuery(view)).toEqual({
      channelId: undefined,
      status: ['rejected'],
      source: undefined,
      dateField: 'seen',
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-02T17:00:00.000Z',
      keyword: undefined,
      limit: 100,
      offset: 100,
    });
  });

  it('caps the page at the largest offset the API accepts', () => {
    expect(parseLibraryParams(new URLSearchParams('page=999999&limit=100')).page).toBe(1001);
  });

  it('rejects a range that ends before it starts', () => {
    const filters = parseLibraryParams(new URLSearchParams('from=2026-10-02&to=2026-10-01'));
    expect(validateFilters(filters)).toEqual({ to: 'Đến ngày phải bằng hoặc sau Từ ngày.' });
  });
});
