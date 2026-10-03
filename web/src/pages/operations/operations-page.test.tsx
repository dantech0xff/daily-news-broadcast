import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PreviewResult, RecoveryTarget } from '../../api/types';
import { channelRecord, channelStatus, queueView, runDetail, runRecord, unresolvedView } from '../../test/fixtures';
import { renderApp, type MockHandler } from '../../test/render-app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE = '/operations?channel=telegram-ops';
const PAUSED_CHANNEL = { channelId: 'telegram-ops', state: 'paused' as const, expectedVersion: 9, allowedActions: ['resume' as const] };

const DELIVERY_TARGET: RecoveryTarget = {
  kind: 'delivery',
  deliveryId: 'd-1',
  state: 'output_exhausted',
  expectedVersion: 2,
  allowedActions: ['abandon'],
  title: 'Bài hết lượt gửi',
  articleCount: 1,
  mode: 'drip',
  publishingDay: '2026-10-03',
};
const AMBIGUOUS_OUTPUT: RecoveryTarget = {
  kind: 'output',
  deliveryId: 'd-3',
  outputKey: 'o-1',
  state: 'needs_reconciliation',
  expectedVersion: 4,
  allowedActions: ['confirm-delivered', 'retry-output'],
  title: 'Bài không rõ kết quả',
  articleCount: 1,
  mode: 'drip',
  publishingDay: '2026-10-03',
};
const DEAD_LETTER: RecoveryTarget = {
  kind: 'outbox',
  outboxId: 'ob-1',
  state: 'dead_letter',
  expectedVersion: 6,
  allowedActions: ['retry-maintenance'],
};

function opsRoutes(overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/channels': { body: { channels: [channelRecord()] } },
    'GET /api/channels/telegram-ops/status': { body: channelStatus() },
    'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([]) },
    'GET /api/channels/telegram-ops/queue': request => ({ body: queueView(request.search.get('day') ?? '2026-10-03') }),
    'GET /api/channels/telegram-ops/runs': { body: { runs: [runRecord()], page: { limit: 20, offset: 0, total: 1 } } },
    'GET /api/runs/run-1': { body: runDetail() },
    ...overrides,
  };
}

function targetRow(title: string): HTMLElement {
  const row = within(screen.getByRole('list', { name: 'Danh sách mục kẹt' })).getByText(title).closest('li');
  if (!row) throw new Error(`No recovery target titled ${title}`);
  return row;
}

function controlCalls(mock: ReturnType<typeof renderApp>['mock'], action: string) {
  return mock.callsTo('POST', `/api/channels/telegram-ops/control/${action}`);
}

describe('OperationsPage', () => {
  it('offers only the allowed actions of each target and confirms a delivery with its Telegram message ID', async () => {
    const { user, mock } = renderApp({
      route: ROUTE,
      routes: opsRoutes({
        'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([DELIVERY_TARGET, AMBIGUOUS_OUTPUT, DEAD_LETTER]) },
        'POST /api/channels/telegram-ops/control/confirm-delivered': {
          body: { channelId: 'telegram-ops', action: 'confirm-delivered', status: 'confirmed', replayed: false, deliveryId: 'd-3', deliveryState: 'succeeded', version: 5 },
        },
      }),
    });

    await screen.findByRole('list', { name: 'Danh sách mục kẹt' });
    const actions = (title: string) => within(targetRow(title)).getAllByRole('button').map(button => button.textContent);
    expect(actions('Bài hết lượt gửi')).toEqual(['Bỏ mục này']);
    expect(actions('Bài không rõ kết quả')).toEqual(['Xác nhận đã gửi', 'Gửi lại']);
    expect(actions('Ghi cache bảo trì')).toEqual(['Chạy lại bảo trì']);

    await user.click(within(targetRow('Bài không rõ kết quả')).getByRole('button', { name: 'Xác nhận đã gửi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xác nhận đã gửi?' });
    const messageId = within(dialog).getByLabelText(/Telegram message ID/);
    await user.type(messageId, '12 34');
    await user.type(within(dialog).getByLabelText(/Lý do/), 'Đã thấy bài trên kênh');
    const confirm = within(dialog).getByRole('button', { name: 'Xác nhận đã gửi' });
    // Spaces are not a valid message id.
    expect(confirm).toBeDisabled();
    await user.clear(messageId);
    await user.type(messageId, '1234');
    await user.click(confirm);

    await waitFor(() => expect(controlCalls(mock, 'confirm-delivered')).toHaveLength(1));
    expect(controlCalls(mock, 'confirm-delivered')[0]?.body).toEqual({
      deliveryId: 'd-3',
      outputKey: 'o-1',
      messageId: '1234',
      idempotencyKey: expect.stringMatching(UUID),
      expectedVersion: 4,
      reason: 'Đã thấy bài trên kênh',
    });
    expect(await screen.findByText('Đã thực hiện: Xác nhận đã gửi — trạng thái mới: Đã đăng.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('requires the duplicate-risk and paused-channel confirmations before retrying an ambiguous output', async () => {
    const { user, mock } = renderApp({
      route: ROUTE,
      routes: opsRoutes({
        'GET /api/channels/telegram-ops/status': { body: channelStatus({ paused: true, version: 9, allowedActions: ['resume'] }) },
        'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([AMBIGUOUS_OUTPUT], { channel: PAUSED_CHANNEL }) },
        'POST /api/channels/telegram-ops/control/retry-output': {
          body: { channelId: 'telegram-ops', action: 'retry-output', status: 'succeeded', replayed: false, deliveryId: 'd-3', deliveryState: 'succeeded', version: 6 },
        },
      }),
    });

    await user.click(await within(await screen.findByRole('list', { name: 'Danh sách mục kẹt' })).findByRole('button', { name: 'Gửi lại' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gửi lại lên Telegram?' });
    expect(within(dialog).getByText(/bài có thể đã lên Telegram/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Lý do/), 'Đã kiểm tra, bài chưa lên kênh');
    const confirm = within(dialog).getByRole('button', { name: 'Gửi lại' });
    expect(confirm).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Tôi đã kiểm tra và chấp nhận rủi ro đăng trùng' }));
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Thực hiện dù kênh đang tạm dừng' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(controlCalls(mock, 'retry-output')).toHaveLength(1));
    expect(controlCalls(mock, 'retry-output')[0]?.body).toEqual({
      deliveryId: 'd-3',
      outputKey: 'o-1',
      confirmDuplicateRisk: true,
      confirmPausedMutation: true,
      idempotencyKey: expect.stringMatching(UUID),
      expectedVersion: 4,
      reason: 'Đã kiểm tra, bài chưa lên kênh',
    });
  });

  it('retries dead-letter maintenance by outbox id and abandons a delivery by delivery id', async () => {
    const { user, mock } = renderApp({
      route: ROUTE,
      routes: opsRoutes({
        'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([DELIVERY_TARGET, DEAD_LETTER]) },
        'POST /api/channels/telegram-ops/control/retry-maintenance': {
          body: { channelId: 'telegram-ops', action: 'retry-maintenance', status: 'completed', replayed: false, outboxId: 'ob-1', outboxState: 'completed', version: 7 },
        },
        'POST /api/channels/telegram-ops/control/abandon': {
          body: { channelId: 'telegram-ops', action: 'abandon', status: 'abandoned', replayed: false, deliveryId: 'd-1', deliveryState: 'abandoned', version: 3 },
        },
      }),
    });

    await screen.findByRole('list', { name: 'Danh sách mục kẹt' });
    await user.click(within(targetRow('Ghi cache bảo trì')).getByRole('button', { name: 'Chạy lại bảo trì' }));
    let dialog = await screen.findByRole('dialog', { name: 'Chạy lại bảo trì?' });
    // An active channel needs no paused-channel confirmation.
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Lý do/), 'Cache đã ổn định');
    await user.click(within(dialog).getByRole('button', { name: 'Chạy lại bảo trì' }));
    await waitFor(() => expect(controlCalls(mock, 'retry-maintenance')).toHaveLength(1));
    expect(controlCalls(mock, 'retry-maintenance')[0]?.body).toEqual({
      outboxId: 'ob-1',
      idempotencyKey: expect.stringMatching(UUID),
      expectedVersion: 6,
      reason: 'Cache đã ổn định',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(targetRow('Bài hết lượt gửi')).getByRole('button', { name: 'Bỏ mục này' }));
    dialog = await screen.findByRole('dialog', { name: 'Bỏ mục này?' });
    await user.type(within(dialog).getByLabelText(/Lý do/), 'Bài đã cũ');
    await user.click(within(dialog).getByRole('button', { name: 'Bỏ mục này' }));
    await waitFor(() => expect(controlCalls(mock, 'abandon')).toHaveLength(1));
    const abandon = controlCalls(mock, 'abandon')[0]?.body as Record<string, unknown>;
    expect(abandon).toEqual({ deliveryId: 'd-1', idempotencyKey: expect.stringMatching(UUID), expectedVersion: 2, reason: 'Bài đã cũ' });
    expect(abandon.idempotencyKey).not.toBe((controlCalls(mock, 'retry-maintenance')[0]?.body as Record<string, unknown>).idempotencyKey);
  });

  it('switches the queue day through the day controls and the URL', async () => {
    const { user, mock, router } = renderApp({ route: ROUTE, routes: opsRoutes() });
    const queueCalls = () => mock.callsTo('GET', '/api/channels/telegram-ops/queue');

    expect(await screen.findByRole('table', { name: 'Queue ngày 03/10/2026' })).toBeInTheDocument();
    expect(queueCalls()[0]?.search.has('day')).toBe(false);
    // Unsafe URLs stay plain text.
    expect(screen.getByRole('link', { name: /Bài đã đăng 2026-10-03/ })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Bài đang chờ 2026-10-03').closest('a')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ngày trước' }));
    expect(await screen.findByRole('table', { name: 'Queue ngày 02/10/2026' })).toBeInTheDocument();
    expect(queueCalls().at(-1)?.search.get('day')).toBe('2026-10-02');
    expect(router.state.location.search).toBe('?channel=telegram-ops&day=2026-10-02');

    fireEvent.change(screen.getByLabelText('Ngày'), { target: { value: '2026-09-15' } });
    expect(await screen.findByRole('table', { name: 'Queue ngày 15/09/2026' })).toBeInTheDocument();
    expect(queueCalls().at(-1)?.search.get('day')).toBe('2026-09-15');

    await user.click(screen.getByRole('button', { name: 'Ngày sau' }));
    expect(await screen.findByRole('table', { name: 'Queue ngày 16/09/2026' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hôm nay' }));
    expect(await screen.findByRole('table', { name: 'Queue ngày 03/10/2026' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?channel=telegram-ops');
  });

  it('shows a run with its timings, selection, outputs, and per-source health', async () => {
    const { user } = renderApp({ route: ROUTE, routes: opsRoutes() });

    await user.click(await screen.findByRole('button', { name: /^Chi tiết run lúc/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chi tiết run' });
    expect(await within(dialog).findByText('Lấy về: 40 → Mới: 10 → Đúng chủ đề: 6 → Sau chấm điểm: 3 → Xếp hàng: 1')).toBeInTheDocument();
    expect(within(dialog).getByText('1/1 lần gửi thành công · 0 lỗi')).toBeInTheDocument();

    const health = within(dialog).getByRole('table', { name: 'Sức khoẻ từng nguồn' });
    const rows = within(health).getAllByRole('row').slice(1);
    // Failed sources first, then empty, then healthy.
    expect(rows.map(row => within(row).getAllByRole('cell')[1]?.textContent)).toEqual(['Lỗi', 'Rỗng', 'Ổn']);
    expect(rows[0]).toHaveTextContent('Hacker News');
    expect(rows[0]).toHaveTextContent('Lỗi HTTP (http)');
    expect(rows[1]).toHaveTextContent('devto');
    expect(rows[2]).toHaveTextContent('Rust Blog');
    expect(within(rows[2] as HTMLElement).getAllByRole('cell')[2]).toHaveTextContent('5');
  });

  it('locks Resume, Run now, and output retries while the cutover instant is missing', async () => {
    renderApp({
      route: ROUTE,
      routes: opsRoutes({
        'GET /api/channels': { body: { channels: [channelRecord({ cutoverRequired: true })] } },
        'GET /api/channels/telegram-ops/status': {
          body: channelStatus({ paused: true, version: 9, allowedActions: ['resume'], cutoverRequired: true, notBefore: null }),
        },
        'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([AMBIGUOUS_OUTPUT], { channel: PAUSED_CHANNEL }) },
      }),
    });

    expect(await screen.findByText('Cần đặt mốc cutover trước khi kênh đăng bài')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Đặt mốc cutover' })).toHaveAttribute('href', '/channels/telegram-ops/edit#section-cutover');
    expect(await screen.findByText('Chưa đặt — bắt buộc với kênh này')).toBeInTheDocument();
    const resume = await screen.findByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAttribute('title', 'Cần đặt mốc cutover (notBefore) trước khi resume');
    const run = screen.getByRole('button', { name: 'Chạy ngay' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Cần đặt mốc cutover (notBefore) trước khi chạy');
    const retry = await within(screen.getByRole('list', { name: 'Danh sách mục kẹt' })).findByRole('button', { name: 'Gửi lại' });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('title', 'Cần đặt mốc cutover (notBefore) trước khi gửi lại');
    // Confirming a delivery by hand sends nothing, so it stays available.
    expect(within(targetRow('Bài không rõ kết quả')).getByRole('button', { name: 'Xác nhận đã gửi' })).toBeEnabled();
  });

  it('previews inline and says that the preview sends nothing', async () => {
    const preview: PreviewResult = {
      channelId: 'telegram-ops',
      status: 'dry_run',
      reason: null,
      mode: 'drip',
      publishingDay: '2026-10-03',
      content: '<b>Nội dung</b> xem trước',
      items: [],
      stats: { articles: 1, sources: 3, durationMs: 1200, selection: null },
      sourceHealth: null,
      sources: [],
      aiUsage: { attempted: 1, succeeded: 1, failed: 0, inputTokens: 100, outputTokens: 50 },
    };
    const { user, mock } = renderApp({
      route: ROUTE,
      routes: opsRoutes({ 'POST /api/channels/telegram-ops/preview': { body: preview } }),
    });

    expect(await screen.findByText('Preview không gửi bài')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chạy preview' }));
    expect(await screen.findByText('<b>Nội dung</b> xem trước')).toBeInTheDocument();
    expect(screen.getByText('Không gửi — chỉ xem trước')).toBeInTheDocument();
    expect(document.querySelector('main b')).toBeNull();
    expect(mock.callsTo('POST', '/api/channels/telegram-ops/preview')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Chạy lại preview' })).toBeEnabled();
  });

  it('keeps viewers read-only: no recovery actions and disabled status actions', async () => {
    renderApp({
      role: 'viewer',
      route: '/operations',
      routes: opsRoutes({ 'GET /api/channels/telegram-ops/unresolved': { body: unresolvedView([DELIVERY_TARGET, AMBIGUOUS_OUTPUT]) } }),
    });

    // Without ?channel the first channel is shown.
    expect(await screen.findByText('Bài không rõ kết quả')).toBeInTheDocument();
    expect(screen.getByText(/chỉ operator mới xử lý được các mục này/)).toBeInTheDocument();
    for (const name of ['Bỏ mục này', 'Gửi lại', 'Xác nhận đã gửi']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    for (const name of ['Chạy ngay', 'Pause', 'Chạy preview']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Cần quyền operator');
    }
  });

  it('explains an unknown channel in the URL', async () => {
    renderApp({ route: '/operations?channel=deleted-channel', routes: opsRoutes() });

    expect(await screen.findByText('Không tìm thấy kênh')).toBeInTheDocument();
    expect(screen.getByLabelText('Kênh')).toHaveValue('deleted-channel');
  });
});
