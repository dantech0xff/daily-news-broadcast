import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { channelRecord, channelStatus } from '../../test/fixtures';
import { renderApp, type MockHandler } from '../../test/render-app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function overviewRoutes(overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/channels': { body: { channels: [channelRecord()] } },
    'GET /api/channels/telegram-ops/status': { body: channelStatus() },
    'GET /api/channels/telegram-ops/unresolved': {
      body: {
        channel: { channelId: 'telegram-ops', state: 'active', expectedVersion: 7, allowedActions: ['pause'] },
        targets: [
          { kind: 'delivery', deliveryId: 'd-1', state: 'output_exhausted', expectedVersion: 2, allowedActions: ['abandon'] },
          { kind: 'delivery', deliveryId: 'd-2', state: 'pending_generation', expectedVersion: 1, allowedActions: ['abandon'] },
          { kind: 'output', deliveryId: 'd-3', outputKey: 'o-1', state: 'needs_reconciliation', expectedVersion: 4, allowedActions: ['confirm-delivered', 'retry-output'] },
        ],
        page: { limit: 100, offset: 0, total: 3 },
      },
    },
    'GET /api/content': {
      body: {
        items: [{
          id: 'item-1',
          channelId: 'telegram-ops',
          articleKey: 'a'.repeat(64),
          title: 'Rust 2.0 ra mắt <script>alert(1)</script>',
          url: 'https://example.test/rust',
          sourceId: 'rust-blog',
          sourceName: 'Rust Blog',
          category: null,
          publishedAt: null,
          firstSeenAt: '2026-10-03T06:00:00.000Z',
          lastSeenAt: '2026-10-03T06:00:00.000Z',
          status: 'delivered',
          rejectReason: null,
          deliveryId: 'd-0',
          messageId: '42',
          deliveredAt: '2026-10-03T07:00:00.000Z',
          runId: 'run-1',
          updatedAt: '2026-10-03T07:00:00.000Z',
          summaryPreview: '<b>Tóm tắt</b> an toàn',
        }],
        page: { limit: 8, offset: 0, total: 1 },
      },
    },
    ...overrides,
  };
}

describe('OverviewPage', () => {
  it('shows metric cards, channel rows, and recent posts as plain text', async () => {
    renderApp({ routes: overviewRoutes() });

    expect(await screen.findByText('3 / 18')).toBeInTheDocument();
    const stuckCard = screen.getByText('Mục kẹt').closest('div');
    expect(stuckCard && within(stuckCard).getByText('2')).toBeInTheDocument();
    expect(screen.getByText('2 / 16')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Telegram Ops' })).toHaveAttribute('href', '/channels/telegram-ops/edit');
    expect(screen.getByText('Đang hoạt động')).toBeInTheDocument();

    const post = await screen.findByRole('link', { name: /Rust 2\.0 ra mắt <script>/ });
    expect(post).toHaveAttribute('target', '_blank');
    expect(post).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('<b>Tóm tắt</b> an toàn')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('keeps mutation controls disabled for viewers', async () => {
    renderApp({ role: 'viewer', routes: overviewRoutes() });

    await screen.findByText('3 / 18');
    for (const name of ['Preview', 'Chạy ngay', 'Pause']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Cần quyền operator');
    }
    expect(screen.queryByRole('link', { name: 'Tạo kênh' })).not.toBeInTheDocument();
  });

  it('pauses only after a reason, sending a fresh idempotency key and the status version', async () => {
    const { user, mock } = renderApp({
      routes: overviewRoutes({
        'POST /api/channels/telegram-ops/control/pause': {
          body: { channelId: 'telegram-ops', action: 'pause', status: 'paused', replayed: false, paused: true, version: 8 },
        },
      }),
    });

    const pause = await screen.findByRole('button', { name: 'Pause' });
    // Disabled until the channel status (and its version) has loaded.
    await waitFor(() => expect(pause).toBeEnabled());
    await user.click(pause);
    const dialog = await screen.findByRole('dialog', { name: 'Pause kênh Telegram Ops?' });
    const confirm = within(dialog).getByRole('button', { name: 'Pause kênh' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Lý do/), '  Bảo trì nguồn  ');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(mock.callsTo('POST', '/api/channels/telegram-ops/control/pause')).toHaveLength(1));
    const [call] = mock.callsTo('POST', '/api/channels/telegram-ops/control/pause');
    const body = call?.body as Record<string, unknown>;
    expect(body).toEqual({ idempotencyKey: expect.stringMatching(UUID), expectedVersion: 7, reason: 'Bảo trì nguồn' });
    expect(call?.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(await screen.findByText('Đã pause kênh Telegram Ops.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and the same key when a control fails', async () => {
    let attempts = 0;
    const { user, mock } = renderApp({
      routes: overviewRoutes({
        'GET /api/channels/telegram-ops/status': { body: channelStatus({ paused: true, version: 9, allowedActions: ['resume'] }) },
        'POST /api/channels/telegram-ops/control/resume': () => {
          attempts += 1;
          return attempts === 1
            ? { status: 422, body: { error: 'missing_credential', message: 'Kênh thiếu credential bắt buộc.', details: { fields: ['telegram.chatIdCredentialId'] } } }
            : { body: { channelId: 'telegram-ops', action: 'resume', status: 'resumed', replayed: false, paused: false, version: 10 } };
        },
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume kênh Telegram Ops?' });
    await user.type(within(dialog).getByLabelText(/Lý do/), 'Đã nhập đủ credential');
    await user.click(within(dialog).getByRole('button', { name: 'Resume kênh' }));

    expect(await within(dialog).findByText('Kênh thiếu credential bắt buộc.')).toBeInTheDocument();
    expect(within(dialog).getByText('Còn thiếu: Telegram chat ID.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Resume kênh' }));

    await waitFor(() => expect(mock.callsTo('POST', '/api/channels/telegram-ops/control/resume')).toHaveLength(2));
    const [first, second] = mock.callsTo('POST', '/api/channels/telegram-ops/control/resume').map(call => call.body as { idempotencyKey: string; expectedVersion: number });
    expect(first?.expectedVersion).toBe(9);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });

  it('locks the reason after a failure whose outcome is unknown, so the retry replays', async () => {
    const { user } = renderApp({
      routes: overviewRoutes({
        'POST /api/channels/telegram-ops/control/pause': { status: 502, body: { error: 'bad_gateway', message: 'Bad gateway' } },
      }),
    });

    const pause = await screen.findByRole('button', { name: 'Pause' });
    await waitFor(() => expect(pause).toBeEnabled());
    await user.click(pause);
    const dialog = await screen.findByRole('dialog', { name: 'Pause kênh Telegram Ops?' });
    const reason = within(dialog).getByLabelText(/Lý do/);
    await user.type(reason, 'Bảo trì');
    await user.click(within(dialog).getByRole('button', { name: 'Pause kênh' }));

    expect(await within(dialog).findByText('Bad gateway')).toBeInTheDocument();
    expect(reason).toHaveAttribute('readonly');
    expect(within(dialog).getByText(/dùng đúng idempotency key/)).toBeInTheDocument();
  });
});
