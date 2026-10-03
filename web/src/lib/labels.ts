/**
 * Vietnamese labels for API enumerations. Unknown values fall back to the raw
 * machine value, so a new backend value still renders.
 */

import type {
  ChannelMode,
  ContentStatus,
  ControlAction,
  CredentialKind,
  LimitKey,
  RunStatus,
  TriggerType,
} from '../api/types';

export function labelOf(map: Readonly<Record<string, string>>, value: string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return map[value] ?? value;
}

export const ROLE_LABELS: Readonly<Record<string, string>> = {
  operator: 'operator',
  viewer: 'viewer (chỉ xem)',
};

export const MODE_LABELS: Readonly<Record<ChannelMode, string>> = {
  drip: 'Drip — đăng rải từng bài trong ngày',
  digest: 'Digest — bản tin tổng hợp',
};

export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  running: 'Đang chạy',
  success: 'Thành công',
  partial: 'Thành công một phần',
  failed: 'Thất bại',
  ambiguous: 'Không rõ kết quả',
  skipped: 'Bỏ qua',
  error: 'Lỗi',
  interrupted: 'Bị gián đoạn',
};

export const TRIGGER_LABELS: Readonly<Record<TriggerType, string>> = {
  scheduled: 'Theo lịch',
  manual: 'Chạy tay',
};

export const RUN_REASON_LABELS: Readonly<Record<string, string>> = {
  channel_paused: 'kênh đang tạm dừng',
  not_due: 'chưa tới lịch',
  already_complete: 'đã hoàn tất trước đó',
  no_articles: 'không có bài mới',
  sources_failed: 'mọi nguồn đều lỗi',
  scan_failed: 'quét nguồn thất bại',
  channel_build_failed: 'không dựng được kênh (thiếu credential hoặc cấu hình lỗi)',
  output_topology_changed: 'cấu hình output đã thay đổi',
  channel_blocked_ambiguous: 'kênh bị chặn vì có mục không rõ kết quả',
  channel_busy: 'kênh đang chạy',
  runtime_not_leased: 'instance chưa giữ runtime lease',
  runtime_stopped: 'ứng dụng đang dừng',
};

export const CONTENT_STATUS_LABELS: Readonly<Record<ContentStatus, string>> = {
  selected: 'Được chọn',
  rejected: 'Bị loại',
  queued: 'Đang chờ',
  generating: 'Đang tạo nội dung',
  delivering: 'Đang gửi',
  delivered: 'Đã đăng',
  generation_failed: 'Tạo nội dung lỗi',
  failed: 'Gửi lỗi',
  ambiguous: 'Không rõ kết quả',
  blocked: 'Bị chặn',
  abandoned: 'Đã bỏ',
};

export const REJECT_REASON_LABELS: Readonly<Record<string, string>> = {
  before_cutoff: 'Đăng trước mốc cutover',
  not_tech: 'Không thuộc chủ đề công nghệ',
  low_score: 'Điểm thấp',
  duplicate: 'Trùng câu chuyện',
};

export const CONTROL_ACTION_LABELS: Readonly<Record<ControlAction, string>> = {
  pause: 'Pause',
  resume: 'Resume',
  'retry-generation': 'Tạo lại nội dung',
  'retry-output': 'Gửi lại',
  'restore-topology': 'Khôi phục topology',
  'confirm-delivered': 'Xác nhận đã gửi',
  abandon: 'Bỏ mục này',
  'retry-maintenance': 'Chạy lại bảo trì',
};

export const CREDENTIAL_KIND_LABELS: Readonly<Record<CredentialKind, string>> = {
  telegram_bot_token: 'Telegram bot token',
  telegram_chat_id: 'Telegram chat ID',
  ai_api_key: 'AI API key',
  ai_gateway_token: 'AI Gateway token',
};

export const CREDENTIAL_KIND_HINTS: Readonly<Record<CredentialKind, string>> = {
  telegram_bot_token: 'Dạng <số>:<chuỗi ký tự>, lấy từ @BotFather.',
  telegram_chat_id: 'Số (ví dụ -1001234567890) hoặc @tên_kênh.',
  ai_api_key: 'API key của AI provider (Claude, OpenAI, Gemini…).',
  ai_gateway_token: 'Token của Cloudflare AI Gateway (dùng với Gemini qua gateway).',
};

/** Channel config slots that reference a credential (`details.fields` of `missing_credential`). */
export const CREDENTIAL_SLOT_LABELS: Readonly<Record<string, string>> = {
  'telegram.botTokenCredentialId': 'Telegram bot token',
  'telegram.chatIdCredentialId': 'Telegram chat ID',
  'ai.apiKeyCredentialId': 'AI API key',
  'ai.gateway.tokenCredentialId': 'AI Gateway token',
};

export const PRESET_LABELS: Readonly<Record<string, string>> = {
  bigTechBlogs: 'Blog kỹ thuật Big Tech',
  communitySources: 'Cộng đồng (HN, Reddit, Dev.to, GitHub)',
  aiMLBlogs: 'Blog AI/ML',
  aiNewsSources: 'Tin tức AI',
  aiDeepDiveSources: 'AI chuyên sâu',
  devopsSources: 'DevOps',
  mobileSources: 'Mobile',
};

export const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  preset: 'Preset',
  rss: 'RSS / Atom feed',
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  devto: 'Dev.to',
  'github-trending': 'GitHub Trending',
  html: 'Trang HTML',
  json: 'JSON API',
};

export const SOURCE_FIELD_LABELS: Readonly<Record<string, string>> = {
  id: 'ID nguồn',
  name: 'Tên hiển thị',
  feedUrl: 'URL feed',
  icon: 'Icon (emoji)',
  category: 'Chuyên mục',
  baseUrl: 'URL gốc của site',
  query: 'Từ khoá tìm kiếm',
  filter: 'Bộ lọc',
  minPoints: 'Điểm tối thiểu',
  subreddit: 'Subreddit',
  sort: 'Sắp xếp',
  minUpvotes: 'Upvote tối thiểu',
  tag: 'Tag',
  minReactions: 'Reaction tối thiểu',
  language: 'Ngôn ngữ lập trình',
  since: 'Khoảng thời gian',
  minStars: 'Star tối thiểu',
  url: 'URL',
  itemsPath: 'Đường dẫn tới danh sách bài (itemsPath)',
  fields: 'Ánh xạ trường (fields)',
};

export const SOURCE_FIELD_HINTS: Readonly<Record<string, string>> = {
  id: 'Chữ thường, số, "-" hoặc "_"; duy nhất trong kênh.',
  baseUrl: 'Dùng để hoàn chỉnh link tương đối trong feed.',
  subreddit: 'Không gồm "r/".',
  tag: 'Chữ thường và số, ví dụ javascript.',
  language: 'Ví dụ typescript, rust, c++.',
  itemsPath: 'Ví dụ data.items; để trống nếu JSON gốc là một mảng.',
  fields: 'Đường dẫn dạng a.b.c tới từng trường trong mỗi phần tử.',
};

export const JSON_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'Tiêu đề',
  url: 'Link bài',
  id: 'ID bài',
  content: 'Nội dung',
  publishedAt: 'Thời điểm đăng',
  author: 'Tác giả',
};

export const ENUM_OPTION_LABELS: Readonly<Record<string, string>> = {
  front_page: 'Trang nhất (front page)',
  hot: 'Hot',
  new: 'Mới nhất',
  top: 'Top',
  rising: 'Đang lên',
  daily: 'Hằng ngày',
  weekly: 'Hằng tuần',
};

export const AI_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude (Anthropic)',
  openai: 'OpenAI',
  groq: 'Groq',
  gemini: 'Google Gemini',
  qwen: 'Qwen (Alibaba)',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (tự host)',
  openrouter: 'OpenRouter',
  together: 'Together AI',
  custom: 'Tuỳ chỉnh (OpenAI-compatible)',
};

export const PROMPT_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh',
};

export const PROMPT_STYLE_LABELS: Readonly<Record<string, string>> = {
  digest: 'Digest — tổng hợp theo chủ đề',
  bullet: 'Bullet — gạch đầu dòng ngắn gọn',
  thread: 'Thread — chuỗi bài nối tiếp',
  newsletter: 'Newsletter — bản tin chi tiết',
  weekly: 'Weekly — tổng kết tuần',
  mustread: 'Must-read — bài nên đọc',
};

export const LIMIT_LABELS: Readonly<Record<LimitKey, { label: string; hint: string }>> = {
  dailyLimit: { label: 'Giới hạn bài mỗi ngày', hint: 'Số bài tối đa được đăng trong một ngày (drip).' },
  batchSize: { label: 'Số bài mỗi lượt', hint: 'Drip: số bài đăng trong một lượt chạy.' },
  maxArticles: { label: 'Số bài tối đa sau chấm điểm', hint: 'Số bài giữ lại sau khi chấm điểm để tóm tắt hoặc xếp hàng.' },
  maxArticlesPerSource: { label: 'Số bài tối đa mỗi nguồn', hint: 'Số bài lấy từ mỗi nguồn trong một lần quét.' },
  concurrency: { label: 'Số nguồn quét song song', hint: 'Số nguồn được fetch cùng lúc.' },
  delayMs: { label: 'Độ trễ giữa các bài (ms)', hint: 'Khoảng nghỉ giữa hai bài trong cùng một lượt.' },
};
