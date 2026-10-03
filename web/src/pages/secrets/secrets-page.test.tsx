import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { credential } from '../../test/fixtures';
import { renderApp, type MockHandler } from '../../test/render-app';

const SECRET = '123456:TOP-secret-token-value';

function secretsRoutes(overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/credentials': {
      body: {
        credentials: [
          credential({ id: 'cred-bot', label: 'Bot chính', usedBy: ['telegram-main'] }),
          credential({ id: 'cred-key', label: 'Claude key', kind: 'ai_api_key', isSet: true, usedBy: [] }),
        ],
      },
    },
    ...overrides,
  };
}

describe('SecretsPage', () => {
  it('lists metadata only, with usage and the delete action blocked while in use', async () => {
    renderApp({ route: '/secrets', routes: secretsRoutes() });

    const row = (await screen.findByText('Bot chính')).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('Telegram bot token')).toBeInTheDocument();
    expect(cells.getByText('Đã đặt')).toBeInTheDocument();
    expect(cells.getByRole('link', { name: 'telegram-main' })).toHaveAttribute('href', '/channels/telegram-main/edit');
    const deleteInUse = cells.getByRole('button', { name: 'Xoá credential Bot chính' });
    expect(deleteInUse).toBeDisabled();
    expect(deleteInUse).toHaveAttribute('title', 'Đang được dùng bởi: telegram-main');
    expect(screen.getByRole('button', { name: 'Xoá credential Claude key' })).toBeEnabled();
  });

  it('creates a credential without ever rendering the value', async () => {
    const { user, mock } = renderApp({
      route: '/secrets',
      routes: secretsRoutes({
        'POST /api/credentials': {
          status: 201,
          body: credential({ id: 'cred-new', label: 'Bot mới', kind: 'telegram_bot_token', usedBy: [] }),
        },
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Thêm credential' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm credential' });
    const value = within(dialog).getByLabelText(/Giá trị/);
    expect(value).toHaveAttribute('type', 'password');
    // Not a login password: no autofill, no save prompts, no name for password managers to key on.
    expect(value).toHaveAttribute('autocomplete', 'off');
    expect(value).toHaveAttribute('data-1p-ignore', 'true');
    expect(value).not.toHaveAttribute('name');
    expect(value).toHaveValue('');

    await user.type(within(dialog).getByLabelText(/Tên/), 'Bot mới');
    await user.type(value, SECRET);
    expect(value).not.toHaveAttribute('value');
    expect(document.body.innerHTML).not.toContain(SECRET);

    await user.click(within(dialog).getByRole('button', { name: 'Lưu credential' }));
    await waitFor(() => expect(mock.callsTo('POST', '/api/credentials')).toHaveLength(1));
    expect(mock.callsTo('POST', '/api/credentials')[0]?.body).toEqual({ label: 'Bot mới', kind: 'telegram_bot_token', value: SECRET });
    expect(value).toHaveValue('');
    expect(await screen.findByText('Đã lưu credential Bot mới')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps no copy of the value in the mutation cache after success or failure', async () => {
    let attempts = 0;
    const { user, queryClient } = renderApp({
      route: '/secrets',
      routes: secretsRoutes({
        'POST /api/credentials': () => {
          attempts += 1;
          return attempts === 1
            ? { status: 503, body: { error: 'runtime_stopped', message: 'Ứng dụng đang dừng.' } }
            : { status: 201, body: credential({ id: 'cred-new', label: 'Bot mới', usedBy: [] }) };
        },
      }),
    });
    const cached = () => JSON.stringify(queryClient.getMutationCache().getAll().map(entry => entry.state));

    await user.click(await screen.findByRole('button', { name: 'Thêm credential' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm credential' });
    await user.type(within(dialog).getByLabelText(/Tên/), 'Bot mới');
    await user.type(within(dialog).getByLabelText(/Giá trị/), SECRET);
    await user.click(within(dialog).getByRole('button', { name: 'Lưu credential' }));
    expect(await within(dialog).findByText('Ứng dụng đang dừng.')).toBeInTheDocument();
    expect(cached()).not.toContain(SECRET);

    await user.click(within(dialog).getByRole('button', { name: 'Lưu credential' }));
    expect(await screen.findByText('Đã lưu credential Bot mới')).toBeInTheDocument();
    expect(cached()).not.toContain(SECRET);
  });

  it('shows the server format error for the value but never the value itself', async () => {
    const { user } = renderApp({
      route: '/secrets',
      routes: secretsRoutes({
        'POST /api/credentials': {
          status: 400,
          body: {
            error: 'validation_failed',
            message: 'Dữ liệu không hợp lệ.',
            issues: [{ field: 'value', code: 'invalid_format', message: 'Bot token Telegram có dạng <số>:<chuỗi ký tự>, ví dụ 123456:ABC-xyz.' }],
          },
        },
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Thêm credential' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm credential' });
    await user.type(within(dialog).getByLabelText(/Tên/), 'Bot');
    await user.type(within(dialog).getByLabelText(/Giá trị/), 'not-a-token');
    await user.click(within(dialog).getByRole('button', { name: 'Lưu credential' }));

    expect(await within(dialog).findAllByText(/Bot token Telegram có dạng/)).not.toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('not-a-token');
  });

  it('replaces a value through an empty, never-prefilled input', async () => {
    const { user, mock } = renderApp({
      route: '/secrets',
      routes: secretsRoutes({
        'PUT /api/credentials/cred-key': { body: credential({ id: 'cred-key', label: 'Claude key', kind: 'ai_api_key' }) },
      }),
    });

    const row = (await screen.findByText('Claude key')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Thay giá trị' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thay giá trị: Claude key' });
    const value = within(dialog).getByLabelText(/Giá trị/);
    expect(value).toHaveValue('');
    expect(value).toHaveAttribute('type', 'password');

    await user.click(within(dialog).getByRole('button', { name: 'Thay giá trị' }));
    expect(await within(dialog).findByText('Bắt buộc.')).toBeInTheDocument();
    expect(mock.callsTo('PUT', '/api/credentials/cred-key')).toHaveLength(0);

    await user.type(value, 'sk-new-key');
    await user.click(within(dialog).getByRole('button', { name: 'Thay giá trị' }));
    await waitFor(() => expect(mock.callsTo('PUT', '/api/credentials/cred-key')).toHaveLength(1));
    expect(mock.callsTo('PUT', '/api/credentials/cred-key')[0]?.body).toEqual({ value: 'sk-new-key' });
  });

  it('hides mutation controls for viewers', async () => {
    renderApp({ role: 'viewer', route: '/secrets', routes: secretsRoutes() });

    await screen.findByText('Claude key');
    expect(screen.getByRole('button', { name: 'Thêm credential' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: /Thay giá trị|Xoá credential/ })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Cần quyền operator');
    }
  });
});
