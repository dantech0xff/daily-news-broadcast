/**
 * Values shared by the E2E harness (`start-test-server.js`, `global-setup.js`),
 * its fake plugins, and the browser specs. Everything here is test data: the
 * "secrets" are fake values that only ever reach the fake Telegram output.
 */

/** Fixed port of the E2E server; a busy port is resolved by `global-setup.js`, never by picking another one. */
export const E2E_PORT = 4310;
export const E2E_HOST = '127.0.0.1';
/** Exact origin the browser uses; the app requires it as `Origin` on every mutation. */
export const E2E_ORIGIN = `http://${E2E_HOST}:${E2E_PORT}`;

/** Environment variable through which global setup hands the harness description to the specs. */
export const HARNESS_INFO_ENV = 'E2E_HARNESS_INFO_FILE';
/** Line prefix the harness prints on stdout once the server listens. */
export const HARNESS_READY_PREFIX = 'E2E_HARNESS_READY ';
/** Set by global setup: the harness shuts down when its stdin pipe closes (the runner went away). */
export const HARNESS_LIFELINE_ENV = 'E2E_HARNESS_STDIN_LIFELINE';
/** Name prefix of the harness temp directory (under the OS temp directory). */
export const HARNESS_TEMP_PREFIX = 'content-radar-e2e-';

/**
 * Time zone of the test browser: Vietnam time, UTC+7 all year (no daylight
 * saving), the same day boundary the dashboard uses for statistics.
 */
export const BROWSER_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const BROWSER_UTC_OFFSET_MINUTES = 420;

/** Header Cloudflare Access adds in production; the specs add it to every request of a browser context. */
export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
export const ACCESS_TEAM_DOMAIN = 'https://content-radar-e2e.cloudflareaccess.com';
export const ACCESS_AUD = 'content-radar-e2e';
export const TOKEN_TTL_SECONDS = 4 * 60 * 60;

/** Signed-in identities; `unmapped` passes Access but has no dashboard role. */
export const IDENTITIES = Object.freeze({
  operator: 'operator@e2e.test',
  viewer: 'viewer@e2e.test',
  unmapped: 'stranger@e2e.test',
});

/** Credentials the operator enters through the UI (fake values in the formats the app validates). */
export const E2E_CREDENTIALS = Object.freeze({
  botToken: Object.freeze({ label: 'E2E Bot token', kind: 'telegram_bot_token', kindLabel: 'Telegram bot token', value: '7000000001:E2E_fake_bot_token_value' }),
  chatId: Object.freeze({ label: 'E2E Chat ID', kind: 'telegram_chat_id', kindLabel: 'Telegram chat ID', value: '-1009990001234' }),
  aiKey: Object.freeze({ label: 'E2E AI key', kind: 'ai_api_key', kindLabel: 'AI API key', value: 'sk-e2e-fake-ai-key-0001' }),
});

/** The channel the specs create through the UI. */
export const E2E_CHANNEL = Object.freeze({
  id: 'e2e-radar',
  name: 'E2E Radar',
  audience: 'Kỹ sư phần mềm và tech lead ở Việt Nam',
  initialModel: 'claude-e2e-sonnet',
  editedProvider: 'openai',
  editedModel: 'gpt-e2e-mini',
  customSystemPrompt: 'Viết như biên tập viên công nghệ: ngắn gọn, nêu rõ tác động với kỹ sư Việt Nam.',
});

export const SEEDED_CHANNEL = Object.freeze({ id: 'telegram-main', name: 'Telegram Main' });

/** The one source every E2E channel fetches from (whatever its configured sources are). */
export const FIXTURE_SOURCE = Object.freeze({
  id: 'e2e-fixture',
  name: 'E2E Fixture Feed',
  feedUrl: 'https://fixture.e2e.invalid/feed.xml',
});

/**
 * Fixture articles, published before and after the cutover instant the specs
 * set (`CUTOVER_HOURS_AGO`), relative to when the harness started. Both are
 * in trusted technology categories, so only the cutover filter tells them apart.
 */
export const FIXTURE_ARTICLES = Object.freeze({
  older: Object.freeze({
    id: 'e2e-older-rust-parallel-frontend',
    title: 'Rust compiler ships a parallel front-end by default',
    category: 'Developer Tools',
    hoursAgo: 5,
  }),
  newer: Object.freeze({
    id: 'e2e-newer-kubernetes-wasm',
    title: 'Kubernetes adds native WebAssembly workloads',
    category: 'Cloud',
    hoursAgo: 1,
  }),
});
export const CUTOVER_HOURS_AGO = 3;

/** Token usage the fake AI reports for every call. */
export const FAKE_AI_USAGE = Object.freeze({ input: 120, output: 45 });
/** Message id the fake Telegram output returns for its first send; later sends count up. */
export const FIRST_MESSAGE_ID = 1001;

/**
 * Text the fake AI returns. It names the provider/model it was built with and
 * whether a custom system prompt reached it, so specs can prove config edits apply.
 * @param {{ provider: string, model?: string|null, titles: string[], customSystemPrompt?: boolean }} input
 */
export function fakeSummaryText({ provider, model, titles, customSystemPrompt = false }) {
  const engine = `${provider}/${model ?? 'model mặc định'}`;
  const style = customSystemPrompt ? ' Viết theo system prompt riêng của kênh.' : '';
  return `Tóm tắt E2E (${engine}): ${titles.join(' · ')}.${style}`;
}

/**
 * Fixture articles and the cutover instant for one harness start.
 * @param {Date} anchor When the harness started.
 */
export function buildFixture(anchor) {
  const at = hoursAgo => new Date(anchor.getTime() - hoursAgo * 3_600_000).toISOString();
  const articles = Object.entries(FIXTURE_ARTICLES).map(([key, article]) => ({
    key,
    id: article.id,
    title: article.title,
    url: `https://fixture.e2e.invalid/articles/${article.id}`,
    content: `${article.title}. Bài kiểm thử E2E: chi tiết kỹ thuật cho đội ngũ nền tảng và DevOps.`,
    source: FIXTURE_SOURCE.name,
    category: article.category,
    author: 'E2E Fixture',
    publishedAt: at(article.hoursAgo),
  }));
  // The cutover field has minute precision, so the instant is a whole minute.
  const cutover = new Date(anchor.getTime() - CUTOVER_HOURS_AGO * 3_600_000);
  cutover.setUTCSeconds(0, 0);
  return { articles, notBefore: cutover.toISOString() };
}
