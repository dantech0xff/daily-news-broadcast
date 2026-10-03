/**
 * The dashboard journey, in order, on one E2E server: an
 * operator stores credentials, creates and edits a Telegram channel, previews
 * it, sets the cutover instant, resumes it, and runs it; then the queue,
 * library, statistics, and pause/resume are checked, and a viewer sees the
 * data without being able to change anything. What the fake Telegram output
 * received (a JSONL file in the server's data directory) proves what was and
 * was not sent.
 */

import {
  E2E_CHANNEL,
  E2E_CREDENTIALS,
  FAKE_AI_USAGE,
  FIRST_MESSAGE_ID,
  FIXTURE_ARTICLES,
  FIXTURE_SOURCE,
  IDENTITIES,
  SEEDED_CHANNEL,
  fakeSummaryText,
} from './fixtures/constants.js';
import {
  MUTATION_HEADERS,
  addDays,
  browserDay,
  browserInputValue,
  card,
  expect,
  formatDay,
  readBlockedNetworkAttempts,
  readSentMessages,
  test,
} from './fixtures/dashboard-test.js';

test.describe.configure({ mode: 'serial' });

const CREDENTIALS = Object.values(E2E_CREDENTIALS);
const SECRET_VALUES = CREDENTIALS.map(credential => credential.value);
const { newer: NEWER, older: OLDER } = FIXTURE_ARTICLES;
const FIRST_MESSAGE = String(FIRST_MESSAGE_ID);
const CHANNEL_PATH = `/api/channels/${E2E_CHANNEL.id}`;
/** What the AI writes for an article once the provider, model, and system prompt were edited. */
const editedSummary = article => fakeSummaryText({
  provider: E2E_CHANNEL.editedProvider,
  model: E2E_CHANNEL.editedModel,
  titles: [article.title],
  customSystemPrompt: true,
});

async function getJson(request, path) {
  const response = await request.get(path);
  expect(response.status(), `GET ${path}`).toBe(200);
  return response.json();
}

/** Pause or resume through the status card: a confirmation dialog that needs a reason. */
async function confirmControl(page, statusCard, { button, dialogTitle, confirmLabel, reason, toast }) {
  await statusCard.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogTitle });
  const confirm = dialog.getByRole('button', { name: confirmLabel, exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Lý do', exact: true }).fill(reason);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(toast)).toBeVisible();
}

test('operator stores credentials that the dashboard only ever reports as set', async ({ page, request }) => {
  const apiBodies = [];
  page.on('response', response => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith('/api/') && pathname !== '/api/events') apiBodies.push(response.text().catch(() => ''));
  });

  await page.goto('/secrets');
  await expect(page.getByRole('heading', { level: 1, name: 'AI & secret' })).toBeVisible();
  for (const credential of CREDENTIALS) {
    await page.getByRole('button', { name: 'Thêm credential' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thêm credential' });
    await dialog.getByRole('textbox', { name: 'Tên', exact: true }).fill(credential.label);
    await dialog.getByRole('combobox', { name: 'Loại', exact: true }).selectOption(credential.kind);
    await dialog.getByRole('textbox', { name: 'Giá trị', exact: true }).fill(credential.value);
    await dialog.getByRole('button', { name: 'Lưu credential' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Đã lưu credential ${credential.label}`)).toBeVisible();
  }

  const rows = page.getByRole('table').getByRole('row');
  for (const credential of CREDENTIALS) {
    const row = rows.filter({ hasText: credential.label });
    await expect(row).toContainText(credential.kindLabel);
    await expect(row).toContainText('Đã đặt');
  }

  // Write-only: replacing a value starts from an empty field, never the stored one.
  await rows.filter({ hasText: E2E_CREDENTIALS.botToken.label }).getByRole('button', { name: 'Thay giá trị' }).click();
  const replace = page.getByRole('dialog', { name: `Thay giá trị: ${E2E_CREDENTIALS.botToken.label}` });
  await expect(replace.getByRole('textbox', { name: 'Giá trị', exact: true })).toHaveValue('');
  await replace.getByRole('button', { name: 'Huỷ' }).click();
  await expect(replace).toBeHidden();

  const html = await page.content();
  const fieldValues = await page.locator('input, textarea').evaluateAll(fields => fields.map(field => field.value));
  for (const value of SECRET_VALUES) {
    expect(html).not.toContain(value);
    expect(fieldValues.some(field => field.includes(value))).toBe(false);
  }

  const listed = await request.get('/api/credentials');
  expect(listed.status()).toBe(200);
  const listedText = await listed.text();
  for (const value of SECRET_VALUES) expect(listedText).not.toContain(value);
  const stored = JSON.parse(listedText).credentials.filter(entry => CREDENTIALS.some(credential => credential.label === entry.label));
  expect(stored).toHaveLength(CREDENTIALS.length);
  for (const entry of stored) {
    expect(entry.isSet).toBe(true);
    expect(Object.keys(entry)).not.toContain('value');
  }

  // Nothing the browser received from the API carried a value either (the
  // captured bodies do include the credential metadata, so they were read).
  const bodies = await Promise.all(apiBodies);
  expect(bodies.some(body => body.includes(E2E_CREDENTIALS.botToken.label))).toBe(true);
  for (const value of SECRET_VALUES) expect(bodies.filter(body => body.includes(value))).toEqual([]);
});

test('operator creates a Telegram channel, which starts paused', async ({ page, request }) => {
  await page.goto('/channels');
  await page.getByRole('link', { name: 'Tạo kênh' }).click();
  await expect(page).toHaveURL(/\/channels\/new$/);
  const form = page.getByRole('form', { name: 'Tạo kênh' });
  await form.getByRole('textbox', { name: 'ID kênh', exact: true }).fill(E2E_CHANNEL.id);
  await form.getByRole('textbox', { name: 'Tên kênh', exact: true }).fill(E2E_CHANNEL.name);
  await expect(form.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('drip');

  // One RSS source; the harness gives every channel the fixture feed.
  await form.getByRole('combobox', { name: 'Thêm nguồn riêng', exact: true }).selectOption('rss');
  await form.getByRole('button', { name: 'Thêm', exact: true, disabled: false }).click();
  await form.getByRole('textbox', { name: 'ID nguồn', exact: true }).fill(FIXTURE_SOURCE.id);
  await form.getByRole('textbox', { name: 'Tên hiển thị', exact: true }).fill(FIXTURE_SOURCE.name);
  await form.getByRole('textbox', { name: 'URL feed', exact: true }).fill(FIXTURE_SOURCE.feedUrl);

  await expect(form.getByRole('combobox', { name: 'AI provider', exact: true })).toHaveValue('claude');
  await form.getByRole('textbox', { name: 'Model', exact: true }).fill(E2E_CHANNEL.initialModel);
  await form.getByRole('combobox', { name: /^AI API key/ }).selectOption({ label: E2E_CREDENTIALS.aiKey.label });
  await form.getByRole('textbox', { name: 'Audience (đối tượng đọc)', exact: true }).fill(E2E_CHANNEL.audience);
  await form.getByRole('combobox', { name: /^Telegram bot token/ }).selectOption({ label: E2E_CREDENTIALS.botToken.label });
  await form.getByRole('combobox', { name: /^Telegram chat ID/ }).selectOption({ label: E2E_CREDENTIALS.chatId.label });

  await form.getByRole('button', { name: 'Tạo kênh' }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${E2E_CHANNEL.id}/edit$`));
  await expect(page.getByText(`Đã tạo kênh ${E2E_CHANNEL.name}`)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: E2E_CHANNEL.name })).toBeVisible();
  await expect(page.getByText('Tạm dừng', { exact: true })).toBeVisible();
  await expect(page.getByText(/Phiên bản 1 · cập nhật/)).toBeVisible();

  await page.goto('/channels');
  const row = page.getByRole('row').filter({ hasText: E2E_CHANNEL.id });
  await expect(row).toContainText('Tạm dừng');
  await expect(row).toContainText(E2E_CHANNEL.initialModel);

  expect(await getJson(request, `${CHANNEL_PATH}/status`)).toMatchObject({ paused: true, enabled: true });
  const record = await getJson(request, CHANNEL_PATH);
  expect(record).toMatchObject({
    version: 1,
    mode: 'drip',
    sources: [{ type: 'rss', enabled: true, config: { id: FIXTURE_SOURCE.id, name: FIXTURE_SOURCE.name, feedUrl: FIXTURE_SOURCE.feedUrl } }],
    ai: { provider: 'claude', model: E2E_CHANNEL.initialModel },
    prompt: { audience: E2E_CHANNEL.audience, customSystemPrompt: null },
  });
});

test('operator edits the system prompt and the AI provider/model; the version increments', async ({ page, request }) => {
  await page.goto(`/channels/${E2E_CHANNEL.id}/edit`);
  await expect(page.getByText(/Phiên bản 1 · cập nhật/)).toBeVisible();
  const form = page.getByRole('form', { name: 'Cấu hình kênh' });
  const prompt = form.getByRole('textbox', { name: 'System prompt riêng (tuỳ chọn)', exact: true });
  const provider = form.getByRole('combobox', { name: 'AI provider', exact: true });
  const model = form.getByRole('textbox', { name: 'Model', exact: true });
  await prompt.fill(E2E_CHANNEL.customSystemPrompt);
  await provider.selectOption(E2E_CHANNEL.editedProvider);
  await model.fill(E2E_CHANNEL.editedModel);
  await form.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByText('Đã lưu cấu hình kênh')).toBeVisible();
  await expect(page.getByText(/Phiên bản 2 · cập nhật/)).toBeVisible();

  await page.reload();
  await expect(prompt).toHaveValue(E2E_CHANNEL.customSystemPrompt);
  await expect(provider).toHaveValue(E2E_CHANNEL.editedProvider);
  await expect(model).toHaveValue(E2E_CHANNEL.editedModel);
  expect(await getJson(request, CHANNEL_PATH)).toMatchObject({
    version: 2,
    ai: { provider: E2E_CHANNEL.editedProvider, model: E2E_CHANNEL.editedModel, apiKeyCredentialId: expect.any(String) },
    prompt: { customSystemPrompt: E2E_CHANNEL.customSystemPrompt },
  });
});

test('preview shows what the AI generates and sends nothing', async ({ page }) => {
  await page.goto('/operations');
  await page.getByRole('combobox', { name: 'Kênh', exact: true }).selectOption(E2E_CHANNEL.id);
  await expect(page).toHaveURL(new RegExp(`channel=${E2E_CHANNEL.id}`));
  await expect(card(page, 'Trạng thái kênh')).toContainText(E2E_CHANNEL.name);

  const preview = card(page, 'Preview');
  await expect(preview.getByText('Preview không gửi bài')).toBeVisible();
  await preview.getByRole('button', { name: 'Chạy preview' }).click();
  await expect(preview.getByText('Preview hoàn tất')).toBeVisible();
  await expect(preview.getByText('Không gửi — chỉ xem trước')).toBeVisible();
  // No cutover instant yet: both fixture articles would be posted, written with the edited provider, model, and prompt.
  await expect(preview.getByRole('heading', { name: 'Bài sẽ được đăng (2)' })).toBeVisible();
  for (const article of [NEWER, OLDER]) {
    await expect(preview.getByText(editedSummary(article), { exact: true })).toBeVisible();
  }

  expect(readSentMessages()).toEqual([]);
  await expect(card(page, 'Lịch sử run').getByText('Chưa có lượt chạy nào')).toBeVisible();
});

test('with the cutover instant set, a resumed channel posts only the article published after it', async ({ page, request, harness }) => {
  const { notBefore } = harness.fixture;
  await page.goto(`/channels/${E2E_CHANNEL.id}/edit`);
  const form = page.getByRole('form', { name: 'Cấu hình kênh' });
  await form.getByLabel('Không đăng bài trước (giờ trình duyệt)', { exact: true }).fill(browserInputValue(notBefore));
  const save = form.getByRole('button', { name: 'Lưu thay đổi' });
  await save.click();
  await expect(form.getByRole('alert')).toContainText('Hãy xác nhận thay đổi mốc cutover.');
  await form.getByRole('checkbox', { name: /^Tôi hiểu tác động và muốn thay đổi mốc cutover/ }).check();
  await save.click();
  await expect(page.getByText('Đã lưu cấu hình kênh')).toBeVisible();
  await expect(page.getByText(/Phiên bản 3 · cập nhật/)).toBeVisible();
  expect((await getJson(request, CHANNEL_PATH)).notBefore).toBe(notBefore);

  await page.goto(`/operations?channel=${E2E_CHANNEL.id}`);
  await expect(page.getByText('Realtime: đã kết nối')).toBeVisible();
  const statusCard = card(page, 'Trạng thái kênh');
  const runNow = statusCard.getByRole('button', { name: 'Chạy ngay' });
  await expect(statusCard.getByText('Tạm dừng', { exact: true })).toBeVisible();
  await expect(runNow).toBeDisabled();
  await confirmControl(page, statusCard, {
    button: 'Resume',
    dialogTitle: `Resume kênh ${E2E_CHANNEL.name}?`,
    confirmLabel: 'Resume kênh',
    reason: 'E2E: đã đặt mốc cutover, mở kênh',
    toast: `Đã resume kênh ${E2E_CHANNEL.name}.`,
  });
  await expect(statusCard.getByText('Đang hoạt động', { exact: true })).toBeVisible();

  await expect(runNow).toBeEnabled();
  await runNow.click();
  await expect(page.getByText('Đã xếp lượt chạy')).toBeVisible();
  // The result arrives through live events; no reload.
  const runRow = page.getByRole('table', { name: 'Lịch sử run' }).getByRole('row').filter({ hasText: 'Chạy tay' });
  await expect(runRow).toContainText('Thành công');
  await expect(runRow).toContainText('1/1 thành công');
  await expect(runRow).toContainText(`${FAKE_AI_USAGE.input} in · ${FAKE_AI_USAGE.output} out`);

  const { runs } = await getJson(request, `${CHANNEL_PATH}/runs`);
  expect(runs).toHaveLength(1);
  const [run] = runs;
  expect(run).toMatchObject({ status: 'success', triggerType: 'manual', outputsSucceeded: 1, outputsFailed: 0 });
  const day = run.stats.publishingDay;

  await page.goto(`/operations?channel=${E2E_CHANNEL.id}&day=${day}`);
  const queue = page.getByRole('table', { name: `Queue ngày ${formatDay(day)}` });
  const queued = queue.getByRole('row').filter({ hasText: NEWER.title });
  await expect(queued).toContainText('Đã đăng');
  await expect(queued).toContainText(FIXTURE_SOURCE.name);
  await expect(queue.getByRole('row').filter({ hasText: OLDER.title })).toHaveCount(0);

  await page.getByRole('button', { name: /^Chi tiết run lúc/ }).click();
  const detail = page.getByRole('dialog', { name: 'Chi tiết run' });
  await expect(detail.getByRole('table', { name: 'Kết quả gửi' })).toContainText(FIRST_MESSAGE);
  await expect(detail.getByRole('table', { name: 'Bài trong lượt chạy' })).toContainText(NEWER.title);
  await expect(detail.getByRole('table', { name: 'Sức khoẻ từng nguồn', exact: true })).toContainText(FIXTURE_SOURCE.name);
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  await page.goto('/library');
  const library = page.getByRole('table', { name: 'Danh sách bài' });
  const delivered = library.getByRole('row').filter({ hasText: NEWER.title });
  const rejected = library.getByRole('row').filter({ hasText: OLDER.title });
  await expect(delivered).toContainText('Đã đăng');
  await expect(delivered).toContainText(FIRST_MESSAGE);
  await expect(rejected).toContainText('Bị loại: Đăng trước mốc cutover');

  const filters = page.getByRole('form', { name: 'Bộ lọc thư viện' });
  await filters.getByRole('combobox', { name: 'Kênh', exact: true }).selectOption(E2E_CHANNEL.id);
  await filters.getByRole('group', { name: 'Trạng thái' }).getByRole('checkbox', { name: 'Bị loại', exact: true }).check();
  await filters.getByRole('button', { name: 'Lọc', exact: true }).click();
  await expect(rejected).toBeVisible();
  await expect(delivered).toHaveCount(0);
  await filters.getByRole('button', { name: 'Xoá bộ lọc' }).click();
  await expect(delivered).toBeVisible();

  await delivered.getByRole('button', { name: 'Chi tiết' }).click();
  const item = page.getByRole('dialog', { name: 'Chi tiết bài' });
  await expect(item).toContainText(editedSummary(NEWER));
  await expect(item).toContainText(FIRST_MESSAGE);
  await expect(item).toContainText(E2E_CHANNEL.name);
  await page.keyboard.press('Escape');
  await expect(item).toBeHidden();

  const { items } = await getJson(request, `/api/content?channelId=${E2E_CHANNEL.id}`);
  const byTitle = Object.fromEntries(items.map(entry => [entry.title, entry]));
  expect(byTitle[NEWER.title]).toMatchObject({ status: 'delivered', messageId: FIRST_MESSAGE, sourceId: FIXTURE_SOURCE.id });
  expect(byTitle[OLDER.title]).toMatchObject({ status: 'rejected', rejectReason: 'before_cutoff', messageId: null });

  // Exactly one message reached "Telegram": the newer article, to the stored chat.
  const sent = readSentMessages();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    messageId: FIRST_MESSAGE,
    chatId: E2E_CREDENTIALS.chatId.value,
    articleTitle: NEWER.title,
    content: editedSummary(NEWER),
  });
});

test('statistics show the run', async ({ page, request }) => {
  const { runs: [run] } = await getJson(request, `${CHANNEL_PATH}/runs`);
  // The range is computed from the browser clock: pin it to the run, so "today" is the run's day.
  await page.clock.setFixedTime(new Date(run.finishedAt));
  const today = browserDay(run.finishedAt);

  await page.goto('/stats');
  const ranges = page.getByRole('group', { name: 'Khoảng thời gian' });
  await ranges.getByRole('button', { name: '7 ngày' }).click();
  await expect(ranges.getByRole('button', { name: '7 ngày' })).toHaveAttribute('aria-pressed', 'true');
  await expect(ranges.getByRole('button', { name: '30 ngày' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('p').filter({ hasText: '(7 ngày)' }))
    .toContainText(`Từ ${formatDay(addDays(today, -6))} đến ${formatDay(today)} (7 ngày) · mọi kênh`);

  const posts = card(page, 'Bài đã đăng theo ngày');
  await expect(posts.getByRole('img', { name: 'Biểu đồ bài đã đăng theo ngày' })).toBeVisible();
  await expect(posts).toContainText('Tổng 1 bài trên 1 kênh.');
  await posts.getByText('Xem dạng bảng').click();
  const postsToday = posts.getByRole('table', { name: 'Số bài đã đăng theo ngày' }).getByRole('row').filter({ hasText: formatDay(today) });
  await expect(postsToday.getByRole('cell')).toHaveText(['1', '1']);

  const failures = card(page, 'Tỉ lệ lỗi AI / output theo ngày');
  await expect(failures.getByRole('img', { name: 'Biểu đồ tỉ lệ lỗi AI và output theo ngày' })).toBeVisible();
  await expect(failures).toContainText('1 run (0 lỗi) · AI lỗi 0/1 · output lỗi 0/1.');

  const tokens = card(page, 'Token usage theo ngày');
  await expect(tokens.getByRole('img', { name: 'Biểu đồ token usage theo ngày' })).toBeVisible();
  await expect(tokens).toContainText(`Tổng ${FAKE_AI_USAGE.input} token đầu vào và ${FAKE_AI_USAGE.output} token đầu ra.`);

  const health = page.getByRole('table', { name: 'Sức khoẻ từng nguồn theo thời gian' });
  await expect(health.getByRole('img', {
    name: `${FIXTURE_SOURCE.name}: 0 ngày có lỗi, 0 ngày chỉ rỗng, 1 ngày ổn, 6 ngày không có dữ liệu`,
  })).toBeVisible();

  // The channel filter narrows every chart: the seeded channel never posted.
  await page.getByRole('combobox', { name: 'Kênh', exact: true }).selectOption(SEEDED_CHANNEL.id);
  await expect(posts.getByText('Chưa có bài nào được đăng trong khoảng này')).toBeVisible();
});

test('pause and resume from the dashboard need a confirmation and a reason', async ({ page, request }) => {
  await page.goto(`/operations?channel=${E2E_CHANNEL.id}`);
  const statusCard = card(page, 'Trạng thái kênh');
  await expect(statusCard.getByText('Đang hoạt động', { exact: true })).toBeVisible();

  // Cancelling the confirmation changes nothing.
  await statusCard.getByRole('button', { name: 'Pause', exact: true }).click();
  const pauseDialog = page.getByRole('dialog', { name: `Pause kênh ${E2E_CHANNEL.name}?` });
  await pauseDialog.getByRole('button', { name: 'Huỷ' }).click();
  await expect(pauseDialog).toBeHidden();
  expect((await getJson(request, `${CHANNEL_PATH}/status`)).paused).toBe(false);

  await confirmControl(page, statusCard, {
    button: 'Pause',
    dialogTitle: `Pause kênh ${E2E_CHANNEL.name}?`,
    confirmLabel: 'Pause kênh',
    reason: 'E2E: tạm dừng để kiểm tra',
    toast: `Đã pause kênh ${E2E_CHANNEL.name}.`,
  });
  await expect(statusCard.getByText('Tạm dừng', { exact: true })).toBeVisible();
  await expect(statusCard.getByText('paused', { exact: true })).toBeVisible();
  await expect(statusCard.getByRole('button', { name: 'Chạy ngay' })).toBeDisabled();
  expect((await getJson(request, `${CHANNEL_PATH}/status`)).paused).toBe(true);

  await confirmControl(page, statusCard, {
    button: 'Resume',
    dialogTitle: `Resume kênh ${E2E_CHANNEL.name}?`,
    confirmLabel: 'Resume kênh',
    reason: 'E2E: mở lại sau khi kiểm tra',
    toast: `Đã resume kênh ${E2E_CHANNEL.name}.`,
  });
  await expect(statusCard.getByText('Đang hoạt động', { exact: true })).toBeVisible();
  await expect(statusCard.getByText('active', { exact: true })).toBeVisible();
  expect((await getJson(request, `${CHANNEL_PATH}/status`)).paused).toBe(false);
  expect(readSentMessages()).toHaveLength(1);
});

test.describe('viewer', () => {
  test.use({ role: 'viewer' });

  test('sees the data but no usable mutation control, and the API refuses its mutations', async ({ page, request, apiAs }) => {
    await page.goto('/channels');
    await expect(page.getByText(IDENTITIES.viewer, { exact: true })).toBeVisible();
    await expect(page.getByText('viewer (chỉ xem)')).toBeVisible();
    const channelRow = page.getByRole('row').filter({ hasText: E2E_CHANNEL.id });
    await expect(channelRow).toContainText('Đang hoạt động');
    await expect(channelRow.getByRole('link', { name: 'Xem', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: SEEDED_CHANNEL.id })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tạo kênh' })).toHaveCount(0);

    const { runs: [run] } = await getJson(request, `${CHANNEL_PATH}/runs`);
    await page.goto(`/operations?channel=${E2E_CHANNEL.id}&day=${run.stats.publishingDay}`);
    await expect(page.getByRole('table', { name: `Queue ngày ${formatDay(run.stats.publishingDay)}` })).toContainText(NEWER.title);
    await expect(page.getByRole('table', { name: 'Lịch sử run' })).toContainText('Thành công');
    for (const name of ['Chạy ngay', 'Pause', 'Chạy preview']) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute('title', 'Cần quyền operator');
    }

    await page.goto(`/channels/${E2E_CHANNEL.id}/edit`);
    await expect(page.getByText('Bạn đang ở chế độ chỉ xem (viewer). Cần quyền operator để thay đổi cấu hình.')).toBeVisible();
    const form = page.getByRole('form', { name: 'Cấu hình kênh' });
    await expect(form.getByRole('textbox', { name: 'System prompt riêng (tuỳ chọn)', exact: true })).toHaveValue(E2E_CHANNEL.customSystemPrompt);
    await expect(form.getByRole('textbox', { name: 'Tên kênh', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Lưu thay đổi' })).toHaveCount(0);
    for (const name of ['Preview', 'Pause', 'Xoá kênh']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    }

    await page.goto('/secrets');
    await expect(page.getByRole('button', { name: 'Thêm credential' })).toBeDisabled();
    const credentialRow = page.getByRole('row').filter({ hasText: E2E_CREDENTIALS.botToken.label });
    await expect(credentialRow).toContainText('Đã đặt');
    await expect(credentialRow.getByRole('button', { name: 'Thay giá trị' })).toBeDisabled();

    await page.goto('/library');
    await expect(page.getByRole('table', { name: 'Danh sách bài' }).getByRole('row').filter({ hasText: NEWER.title })).toContainText('Đã đăng');

    // The server decides: every mutation with the viewer's token is refused.
    const status = await getJson(request, `${CHANNEL_PATH}/status`);
    const record = await getJson(request, CHANNEL_PATH);
    const attempts = [
      ['POST', `${CHANNEL_PATH}/run`, {}],
      ['POST', `${CHANNEL_PATH}/preview`, {}],
      ['POST', `${CHANNEL_PATH}/control/pause`, { idempotencyKey: 'e2e-viewer-pause', expectedVersion: status.version, reason: 'Viewer attempt' }],
      ['PUT', CHANNEL_PATH, { version: record.version, name: 'Renamed by a viewer' }],
      ['DELETE', CHANNEL_PATH, { expectedVersion: record.version }],
      ['POST', '/api/credentials', { label: 'Viewer secret', kind: 'ai_api_key', value: 'sk-viewer-attempt' }],
    ];
    for (const [method, path, data] of attempts) {
      const response = await request.fetch(path, { method, headers: MUTATION_HEADERS, data });
      expect(response.status(), `${method} ${path}`).toBe(403);
      expect(await response.json(), `${method} ${path}`).toMatchObject({ error: 'forbidden' });
    }

    const operator = await apiAs('operator');
    expect(await getJson(operator, `${CHANNEL_PATH}/status`)).toMatchObject({ paused: false, version: status.version });
    expect(await getJson(operator, CHANNEL_PATH)).toMatchObject({ version: record.version, name: E2E_CHANNEL.name });
    const { credentials } = await getJson(operator, '/api/credentials');
    expect(credentials.map(entry => entry.label)).not.toContain('Viewer secret');
    expect(readSentMessages()).toHaveLength(1);
  });
});

test('the server never tried to reach the network', () => {
  expect(readBlockedNetworkAttempts()).toEqual([]);
});
