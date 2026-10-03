import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stats } from '../../api/types';
import { channelRecord, emptyStats } from '../../test/fixtures';
import { renderApp, type MockHandler } from '../../test/render-app';

const NOW = new Date('2026-10-03T08:00:00.000Z');

function statsRoutes(stats: Stats = emptyStats(), overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/channels': { body: { channels: [channelRecord(), channelRecord({ id: 'telegram-ai', name: 'Telegram AI' })] } },
    'GET /api/stats': { body: stats },
    ...overrides,
  };
}

function lastStatsCall(mock: ReturnType<typeof renderApp>['mock']): Record<string, string> {
  return Object.fromEntries(mock.callsTo('GET', '/api/stats').at(-1)?.search ?? []);
}

describe('StatsPage', () => {
  beforeEach(() => {
    // Only Date is faked: timers stay real for Testing Library and TanStack Query.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests Vietnam days with utcOffsetMinutes=420 for presets and the channel filter', async () => {
    const { user, mock, router } = renderApp({ route: '/stats', routes: statsRoutes() });

    await screen.findByText('Chưa có bài nào được đăng trong khoảng này');
    expect(lastStatsCall(mock)).toEqual({ from: '2026-09-03T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', utcOffsetMinutes: '420' });
    expect(screen.getByRole('button', { name: '30 ngày' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/\(30 ngày\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '7 ngày' }));
    await waitFor(() => expect(lastStatsCall(mock).from).toBe('2026-09-26T17:00:00.000Z'));
    expect(lastStatsCall(mock)).toEqual({ from: '2026-09-26T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', utcOffsetMinutes: '420' });
    expect(router.state.location.search).toBe('?range=7');

    await user.selectOptions(screen.getByLabelText('Kênh'), 'telegram-ai');
    await waitFor(() => expect(lastStatsCall(mock).channelId).toBe('telegram-ai'));
    expect(lastStatsCall(mock)).toMatchObject({ from: '2026-09-26T17:00:00.000Z', utcOffsetMinutes: '420' });
    expect(router.state.location.search).toBe('?range=7&channel=telegram-ai');

    await user.click(screen.getByRole('button', { name: '90 ngày' }));
    await waitFor(() => expect(lastStatsCall(mock).from).toBe('2026-07-05T17:00:00.000Z'));
  });

  it('validates a custom range before requesting it', async () => {
    const { user, mock, router } = renderApp({ route: '/stats?range=7', routes: statsRoutes() });

    await screen.findByText('Chưa có bài nào được đăng trong khoảng này');
    await user.click(screen.getByRole('button', { name: 'Tuỳ chọn' }));
    // The custom form starts from the range that was shown.
    const form = await screen.findByRole('form', { name: 'Khoảng thời gian tuỳ chọn' });
    expect(within(form).getByLabelText('Từ ngày')).toHaveValue('2026-09-27');
    expect(router.state.location.search).toBe('?range=custom&from=2026-09-27&to=2026-10-03');

    const from = within(form).getByLabelText('Từ ngày');
    await user.clear(from);
    await user.type(from, '2025-01-01');
    const callsBefore = mock.callsTo('GET', '/api/stats').length;
    await user.click(within(form).getByRole('button', { name: 'Áp dụng' }));
    expect(await within(form).findByText('Khoảng thời gian tối đa 400 ngày.')).toBeInTheDocument();
    expect(mock.callsTo('GET', '/api/stats')).toHaveLength(callsBefore);

    await user.clear(from);
    await user.type(from, '2026-09-01');
    await user.click(within(form).getByRole('button', { name: 'Áp dụng' }));
    await waitFor(() => expect(lastStatsCall(mock).from).toBe('2026-08-31T17:00:00.000Z'));
    expect(lastStatsCall(mock)).toEqual({ from: '2026-08-31T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', utcOffsetMinutes: '420' });
  });

  it('shows empty states and the retention note when there is no data', async () => {
    renderApp({ route: '/stats', routes: statsRoutes() });

    expect(await screen.findByText('Chưa có bài nào được đăng trong khoảng này')).toBeInTheDocument();
    expect(screen.getByText('Chưa có dữ liệu sức khoẻ nguồn trong khoảng này')).toBeInTheDocument();
    expect(screen.getByText('Chưa có lượt gọi AI hay lần gửi nào trong khoảng này')).toBeInTheDocument();
    expect(screen.getByText('Chưa có token nào được ghi nhận trong khoảng này')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/Lịch sử run và sức khoẻ nguồn được giữ 180 ngày; bài quét chưa đăng giữ 30 ngày; bài đã đăng giữ vĩnh viễn\./)).toBeInTheDocument();
  });

  it('draws posts per channel, source health, failure rates, and token usage', async () => {
    const stats = emptyStats({
      postsPerDay: [
        { day: '2026-10-02', channelId: 'telegram-ops', posts: 3 },
        { day: '2026-10-03', channelId: 'telegram-ops', posts: 2 },
        { day: '2026-10-03', channelId: 'telegram-ai', posts: 4 },
      ],
      sourceHealthPerDay: [
        { day: '2026-10-02', sourceId: 'rust-blog', sourceName: 'Rust Blog', healthy: 3, empty: 0, failed: 0, articles: 9 },
        { day: '2026-10-03', sourceId: 'hn', sourceName: 'Hacker News', healthy: 1, empty: 0, failed: 2, articles: 4 },
      ],
      failureRatesPerDay: [{
        day: '2026-10-03',
        runs: 4,
        failedRuns: 1,
        generationAttempts: 5,
        generationFailures: 1,
        generationFailureRate: 0.2,
        outputAttempts: 4,
        outputFailures: 0,
        outputFailureRate: 0,
      }],
      tokenUsagePerDay: [{ day: '2026-10-03', inputTokens: 12000, outputTokens: 3000, totalTokens: 15000 }],
    });
    renderApp({ route: '/stats', routes: statsRoutes(stats) });

    const posts = await screen.findByRole('img', { name: 'Biểu đồ bài đã đăng theo ngày' });
    const postsCard = posts.closest('section') as HTMLElement;
    expect(within(postsCard).getByText('Tổng 9 bài trên 2 kênh.')).toBeInTheDocument();
    expect(within(postsCard).getByRole('list', { name: 'Chú thích' })).toHaveTextContent('Telegram AITelegram Ops');
    const postsTable = within(postsCard).getByRole('table', { name: 'Số bài đã đăng theo ngày' });
    expect(within(postsTable).getByRole('row', { name: /03\/10\/2026/ })).toHaveTextContent('03/10/2026426');

    const health = screen.getByRole('table', { name: 'Sức khoẻ từng nguồn theo thời gian' });
    const rows = within(health).getAllByRole('row').slice(1);
    // The source with failures comes first.
    expect(rows[0]).toHaveTextContent('Hacker News');
    expect(within(rows[0] as HTMLElement).getByRole('img')).toHaveAccessibleName(
      'Hacker News: 1 ngày có lỗi, 0 ngày chỉ rỗng, 0 ngày ổn, 29 ngày không có dữ liệu',
    );
    expect(rows[1]).toHaveTextContent('Rust Blog');

    expect(screen.getByRole('img', { name: 'Biểu đồ tỉ lệ lỗi AI và output theo ngày' })).toBeInTheDocument();
    expect(screen.getByText('4 run (1 lỗi) · AI lỗi 1/5 · output lỗi 0/4.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Biểu đồ token usage theo ngày' })).toBeInTheDocument();
    expect(screen.getByText('Tổng 12.000 token đầu vào và 3.000 token đầu ra.')).toBeInTheDocument();
  });
});
