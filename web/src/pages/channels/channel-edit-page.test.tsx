import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChannelRecord } from '../../api/types';
import { channelRecord, channelStatus, credential } from '../../test/fixtures';
import { renderApp, type MockHandler, type RecordedRequest } from '../../test/render-app';

const CREDENTIALS = [
  credential({ id: 'cred-bot', label: 'Bot chính', kind: 'telegram_bot_token', usedBy: ['telegram-ops'] }),
  credential({ id: 'cred-chat', label: 'Chat chính', kind: 'telegram_chat_id', usedBy: ['telegram-ops'] }),
  credential({ id: 'cred-chat-2', label: 'Chat phụ', kind: 'telegram_chat_id' }),
  credential({ id: 'cred-gateway', label: 'Gateway', kind: 'ai_gateway_token', usedBy: ['telegram-ops'] }),
];

function editRoutes(overrides: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /api/channels/telegram-ops': { body: channelRecord() },
    'GET /api/channels/telegram-ops/status': { body: channelStatus() },
    'GET /api/credentials': { body: { credentials: CREDENTIALS } },
    ...overrides,
  };
}

describe('ChannelEditPage', () => {
  it('saves every field with the version it was loaded from', async () => {
    const saved = channelRecord({ name: 'Telegram Ops 2', version: 4, telegram: { botTokenCredentialId: 'cred-bot', chatIdCredentialId: 'cred-chat-2' } });
    const { user, mock } = renderApp({
      route: '/channels/telegram-ops/edit',
      routes: editRoutes({ 'PUT /api/channels/telegram-ops': { body: saved } }),
    });

    const name = await screen.findByLabelText(/Tên kênh/);
    const save = screen.getByRole('button', { name: 'Lưu thay đổi' });
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'Telegram Ops 2');
    await user.selectOptions(screen.getByLabelText(/^Telegram chat ID/), 'cred-chat-2');
    await user.click(save);

    await waitFor(() => expect(mock.callsTo('PUT', '/api/channels/telegram-ops')).toHaveLength(1));
    const body = mock.callsTo('PUT', '/api/channels/telegram-ops')[0]?.body as Record<string, unknown>;
    const { id: _id, platform: _platform, createdAt: _createdAt, updatedAt: _updatedAt, updatedBy: _updatedBy, version: _version, ...rest } = channelRecord();
    expect(body).toEqual({
      ...rest,
      version: 3,
      name: 'Telegram Ops 2',
      telegram: { botTokenCredentialId: 'cred-bot', chatIdCredentialId: 'cred-chat-2' },
    });
    expect(await screen.findByText('Đã lưu cấu hình kênh')).toBeInTheDocument();
  });

  it('shows server field issues next to the matching inputs', async () => {
    const { user } = renderApp({
      route: '/channels/telegram-ops/edit',
      routes: editRoutes({
        'PUT /api/channels/telegram-ops': {
          status: 400,
          body: {
            error: 'validation_failed',
            message: 'Dữ liệu không hợp lệ.',
            issues: [
              { field: 'sources.1.config.feedUrl', code: 'invalid_url', message: 'Feed không truy cập được từ máy chủ.' },
              { field: 'telegram.botTokenCredentialId', code: 'credential_kind_mismatch', message: 'Cần credential loại telegram_bot_token.' },
            ],
          },
        },
      }),
    });

    const name = await screen.findByLabelText(/Tên kênh/);
    await user.type(name, '!');
    await user.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));

    const feedUrl = await screen.findByLabelText(/URL feed/);
    expect(feedUrl).toHaveAttribute('aria-invalid', 'true');
    expect(feedUrl).toHaveAccessibleDescription('Feed không truy cập được từ máy chủ.');
    const summary = screen.getByText('Có 2 lỗi cần sửa').closest('div');
    expect(summary && within(summary).getByText(/Nguồn #2 › URL feed/)).toBeInTheDocument();
    expect(screen.getByText('Cần credential loại telegram_bot_token.')).toBeInTheDocument();

    // Editing the field clears its server error.
    await user.type(feedUrl, 'x');
    expect(feedUrl).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('Có 1 lỗi cần sửa')).toBeInTheDocument();
  });

  it('blocks submission on client errors without calling the API', async () => {
    const { user, mock } = renderApp({ route: '/channels/telegram-ops/edit', routes: editRoutes() });

    const cron = await screen.findByLabelText(/Cron/);
    await user.clear(cron);
    await user.type(cron, 'every hour');
    await user.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));

    expect(await screen.findByText(/Cron cần đúng 5 trường/, { selector: '#channel-cron-error' })).toBeInTheDocument();
    expect(mock.callsTo('PUT', '/api/channels/telegram-ops')).toHaveLength(0);
  });

  it('offers to reload after a version conflict', async () => {
    let record: ChannelRecord = channelRecord();
    const { user, mock } = renderApp({
      route: '/channels/telegram-ops/edit',
      routes: editRoutes({
        'GET /api/channels/telegram-ops': () => ({ body: record }),
        'PUT /api/channels/telegram-ops': (_request: RecordedRequest) => {
          record = channelRecord({ name: 'Changed elsewhere', version: 5 });
          return { status: 409, body: { error: 'version_conflict', message: 'Dữ liệu đã được thay đổi ở nơi khác; hãy tải lại rồi thử lại.', details: { currentVersion: 5 } } };
        },
      }),
    });

    await user.type(await screen.findByLabelText(/Tên kênh/), ' mới');
    await user.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));

    expect(await screen.findByText('Không lưu được: cấu hình đã bị thay đổi ở nơi khác')).toBeInTheDocument();
    expect(screen.getByText(/trên máy chủ hiện là phiên bản 5/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tải lại cấu hình' }));

    await waitFor(() => expect(screen.getByLabelText(/Tên kênh/)).toHaveValue('Changed elsewhere'));
    expect(mock.callsTo('GET', '/api/channels/telegram-ops').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the editor and unsaved edits when a background refresh fails', async () => {
    let failing = false;
    const { user, queryClient } = renderApp({
      route: '/channels/telegram-ops/edit',
      routes: editRoutes({
        'GET /api/channels/telegram-ops': () => (failing
          ? { status: 500, body: { error: 'internal_error', message: 'Request failed' } }
          : { body: channelRecord() }),
      }),
    });

    const name = await screen.findByLabelText(/Tên kênh/);
    await user.type(name, ' (đang sửa)');
    failing = true;
    await queryClient.refetchQueries({ queryKey: ['channel', 'telegram-ops'] });

    expect(await screen.findByText(/Không tải lại được dữ liệu mới nhất/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tên kênh/)).toHaveValue('Telegram Ops (đang sửa)');
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeEnabled();
  });

  it('asks before leaving with unsaved changes', async () => {
    const { user, router } = renderApp({ route: '/channels/telegram-ops/edit', routes: editRoutes() });

    await user.type(await screen.findByLabelText(/Tên kênh/), '!');
    await user.click(screen.getByRole('link', { name: 'Kênh' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rời trang khi còn thay đổi chưa lưu?' });
    await user.click(within(dialog).getByRole('button', { name: 'Ở lại' }));
    expect(router.state.location.pathname).toBe('/channels/telegram-ops/edit');
    expect(screen.getByLabelText(/Tên kênh/)).toHaveValue('Telegram Ops!');

    await user.click(screen.getByRole('link', { name: 'Kênh' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Rời trang khi còn thay đổi chưa lưu?' })).getByRole('button', { name: 'Bỏ thay đổi và rời trang' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/channels'));
  });

  it('is read-only for viewers', async () => {
    renderApp({ role: 'viewer', route: '/channels/telegram-ops/edit', routes: editRoutes() });

    expect(await screen.findByLabelText(/Tên kênh/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Lưu thay đổi' })).not.toBeInTheDocument();
    expect(screen.getByText(/chế độ chỉ xem/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xoá kênh' })).toBeDisabled();
  });
});

describe('ChannelCreatePage', () => {
  it('explains that new channels start paused and posts the new channel', async () => {
    const created = channelRecord({ id: 'telegram-ai', name: 'Telegram AI', version: 1 });
    const { user, mock } = renderApp({
      route: '/channels/new',
      routes: {
        'GET /api/credentials': { body: { credentials: CREDENTIALS } },
        'POST /api/channels': { status: 201, body: created },
        'GET /api/channels/telegram-ai': { body: created },
        'GET /api/channels/telegram-ai/status': { body: channelStatus({ channelId: 'telegram-ai', paused: true }) },
      },
    });

    expect(await screen.findByText('Kênh mới luôn được tạo ở trạng thái tạm dừng (paused)')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/ID kênh/), 'telegram-ai');
    await user.type(screen.getByLabelText(/Tên kênh/), 'Telegram AI');
    await user.type(screen.getByLabelText(/Audience/), 'Kỹ sư AI');
    await user.selectOptions(screen.getByLabelText('Thêm preset'), 'aiNewsSources');
    await user.click(screen.getAllByRole('button', { name: 'Thêm' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Tạo kênh' }));

    await waitFor(() => expect(mock.callsTo('POST', '/api/channels')).toHaveLength(1));
    const body = mock.callsTo('POST', '/api/channels')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'telegram-ai',
      name: 'Telegram AI',
      enabled: true,
      mode: 'drip',
      sources: [{ type: 'preset', preset: 'aiNewsSources', enabled: true }],
      prompt: { language: 'vi', style: 'digest', audience: 'Kỹ sư AI', customSystemPrompt: null },
      notBefore: null,
    });
    expect(await screen.findByRole('heading', { name: 'Telegram AI' })).toBeInTheDocument();
  });
});
