import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { channelRecord, channelStatus } from '../test/fixtures';
import { renderApp } from '../test/render-app';

describe('SessionProvider', () => {
  it('shows the session-expired screen with a reload button when the first load is redirected to Access', async () => {
    const { mock } = renderApp({ routes: { 'GET /api/me': { status: 401, body: { error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' } } } });

    expect(await screen.findByRole('heading', { name: 'Phiên đăng nhập đã hết hạn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải lại trang' })).toBeInTheDocument();
    expect(mock.calls.filter(call => call.path === '/api/me')).toHaveLength(1);
  });

  it('shows the forbidden screen for an identity without a role', async () => {
    renderApp({ routes: { 'GET /api/me': { status: 403, body: { error: 'forbidden', message: 'Tài khoản của bạn không có quyền thực hiện thao tác này.' } } } });

    expect(await screen.findByRole('heading', { name: 'Bạn không có quyền truy cập' })).toBeInTheDocument();
  });

  it('blocks the app with a reload dialog when the session expires mid-use, without retrying', async () => {
    const { user, mock } = renderApp({
      routes: {
        'GET /api/channels': { body: { channels: [channelRecord()] } },
        'GET /api/channels/telegram-ops/status': { body: channelStatus() },
        'GET /api/channels/telegram-ops/unresolved': { body: { channel: null, targets: [], page: { limit: 100, offset: 0, total: 0 } } },
        'POST /api/channels/telegram-ops/run': { status: 401, body: { error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' } },
      },
    });

    const run = await screen.findByRole('button', { name: 'Chạy ngay' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);

    const dialog = await screen.findByRole('alertdialog', { name: 'Phiên đăng nhập đã hết hạn' });
    expect(within(dialog).getByRole('button', { name: 'Tải lại trang' })).toBeInTheDocument();
    const callsAfterExpiry = mock.calls.length;

    await user.click(within(dialog).getByRole('button', { name: 'Để sau' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const banner = screen.getByText(/Phiên đăng nhập đã hết hạn — dữ liệu không được cập nhật/).closest('[role="alert"]');
    expect(banner && within(banner as HTMLElement).getByRole('button', { name: 'Tải lại trang' })).toBeInTheDocument();
    // The page under the dialog is still there, and nothing hit the network again.
    expect(screen.getByRole('link', { name: 'Telegram Ops' })).toBeInTheDocument();
    expect(mock.calls).toHaveLength(callsAfterExpiry);
  });
});
