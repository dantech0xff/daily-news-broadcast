import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { channelRecord, contentItem } from '../../test/fixtures';
import { renderApp, type MockHandler, type RecordedRequest } from '../../test/render-app';

const FILTERED_ROUTE = '/library?channel=telegram-ops&status=delivered,rejected&source=Rust%20Blog&dateField=delivered'
  + '&from=2026-10-01&to=2026-10-02&q=rust&page=2&limit=20';

function libraryRoutes(overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/channels': { body: { channels: [channelRecord()] } },
    'GET /api/content': (request: RecordedRequest) => ({
      body: {
        items: [
          contentItem(),
          contentItem({
            id: 'item-2',
            articleKey: 'b'.repeat(64),
            title: 'Bài bị loại',
            status: 'rejected',
            rejectReason: 'not_tech',
            deliveryId: null,
            messageId: null,
            deliveredAt: null,
            summaryPreview: null,
          }),
        ],
        page: { limit: Number(request.search.get('limit') ?? 50), offset: Number(request.search.get('offset') ?? 0), total: 22 },
      },
    }),
    ...overrides,
  };
}

function lastContentCall(mock: ReturnType<typeof renderApp>['mock']): Record<string, string> {
  return Object.fromEntries(mock.callsTo('GET', '/api/content').at(-1)?.search ?? []);
}

describe('LibraryPage', () => {
  it('requests the filters of the URL and shows them in the form', async () => {
    const { mock } = renderApp({ route: FILTERED_ROUTE, routes: libraryRoutes() });

    const table = await screen.findByRole('table', { name: 'Danh sách bài' });
    expect(lastContentCall(mock)).toEqual({
      channelId: 'telegram-ops',
      status: 'delivered,rejected',
      source: 'Rust Blog',
      dateField: 'delivered',
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-02T17:00:00.000Z',
      keyword: 'rust',
      limit: '20',
      offset: '20',
    });

    const form = screen.getByRole('form', { name: 'Bộ lọc thư viện' });
    expect(within(form).getByLabelText('Kênh')).toHaveValue('telegram-ops');
    expect(within(form).getByLabelText('Nguồn')).toHaveValue('Rust Blog');
    expect(within(form).getByLabelText('Từ khoá')).toHaveValue('rust');
    expect(within(form).getByLabelText('Mốc thời gian')).toHaveValue('delivered');
    expect(within(form).getByLabelText('Từ ngày')).toHaveValue('2026-10-01');
    expect(within(form).getByLabelText('Đến ngày')).toHaveValue('2026-10-02');
    const statuses = within(form).getByRole('group', { name: 'Trạng thái' });
    expect(within(statuses).getByRole('checkbox', { name: 'Đã đăng' })).toBeChecked();
    expect(within(statuses).getByRole('checkbox', { name: 'Bị loại' })).toBeChecked();
    expect(within(statuses).getByRole('checkbox', { name: 'Đang chờ' })).not.toBeChecked();

    expect(within(table).getByText('Bị loại: Không thuộc chủ đề công nghệ')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /Rust 2\.0 ra mắt/ })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Hiển thị 21–22 / 22')).toBeInTheDocument();
  });

  it('applies edited filters to the URL and the API, back to page one', async () => {
    const { user, mock, router } = renderApp({ route: FILTERED_ROUTE, routes: libraryRoutes() });

    await screen.findByRole('table', { name: 'Danh sách bài' });
    const form = screen.getByRole('form', { name: 'Bộ lọc thư viện' });
    const keyword = within(form).getByLabelText('Từ khoá');
    await user.clear(keyword);
    await user.type(keyword, 'kubernetes');
    await user.click(within(form).getByRole('checkbox', { name: 'Bị loại' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Gửi lỗi' }));
    await user.selectOptions(within(form).getByLabelText('Mốc thời gian'), 'published');
    await user.click(within(form).getByRole('button', { name: 'Lọc' }));

    await waitFor(() => expect(lastContentCall(mock).keyword).toBe('kubernetes'));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
      channel: 'telegram-ops',
      status: 'delivered,failed',
      source: 'Rust Blog',
      dateField: 'published',
      from: '2026-10-01',
      to: '2026-10-02',
      q: 'kubernetes',
      limit: '20',
    });
    expect(lastContentCall(mock)).toMatchObject({ status: 'delivered,failed', dateField: 'published', offset: '0', limit: '20' });

    // Paging keeps the filters.
    await user.click(await screen.findByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(lastContentCall(mock).offset).toBe('20'));
    expect(new URLSearchParams(router.state.location.search).get('page')).toBe('2');
    expect(lastContentCall(mock).keyword).toBe('kubernetes');
  });

  it('rejects a date range that ends before it starts, without navigating', async () => {
    const { user, router } = renderApp({ route: '/library', routes: libraryRoutes() });

    const form = await screen.findByRole('form', { name: 'Bộ lọc thư viện' });
    await user.type(within(form).getByLabelText('Từ ngày'), '2026-10-05');
    await user.type(within(form).getByLabelText('Đến ngày'), '2026-10-01');
    await user.click(within(form).getByRole('button', { name: 'Lọc' }));

    expect(await within(form).findByText('Đến ngày phải bằng hoặc sau Từ ngày.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });

  it('filters by a source from the table and clears every filter', async () => {
    const { user, router, mock } = renderApp({ route: '/library?q=rust', routes: libraryRoutes() });

    const table = await screen.findByRole('table', { name: 'Danh sách bài' });
    await user.click(within(table).getAllByRole('button', { name: 'Rust Blog' })[0] as HTMLElement);
    await waitFor(() => expect(lastContentCall(mock).source).toBe('Rust Blog'));
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('rust');

    await user.click(screen.getByRole('button', { name: 'Xoá bộ lọc' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(within(screen.getByRole('form', { name: 'Bộ lọc thư viện' })).getByLabelText('Nguồn')).toHaveValue('');
  });

  it('shows an item in a dialog with its AI summary as plain text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)> Tiêu đề';
    const { user, mock } = renderApp({
      role: 'viewer',
      route: '/library',
      routes: libraryRoutes({
        'GET /api/content': { body: { items: [contentItem({ title: hostile })], page: { limit: 50, offset: 0, total: 1 } } },
        'GET /api/content/item-1': {
          body: contentItem({ title: hostile, summaryText: '<script>alert(1)</script>\n<b>Đậm</b> dòng 2' }),
        },
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Chi tiết' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chi tiết bài' });
    const summary = await within(dialog).findByText(/<script>alert\(1\)<\/script>/);
    expect(summary.tagName).toBe('PRE');
    expect(summary.textContent).toBe('<script>alert(1)</script>\n<b>Đậm</b> dòng 2');
    expect(within(dialog).getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('script, img, b')).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'https://example.test/rust' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(dialog).getByText('42')).toBeInTheDocument();
    expect(within(dialog).getByText('d-0')).toBeInTheDocument();
    expect(mock.callsTo('GET', '/api/content/item-1')).toHaveLength(1);
    // Viewers browse the library like operators: there is nothing to mutate here.
    expect(mock.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
