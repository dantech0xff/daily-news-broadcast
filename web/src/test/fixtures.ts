/** Test data shaped exactly like the app API responses. */

import type {
  ChannelRecord,
  ChannelStatus,
  ContentItem,
  Credential,
  Health,
  Meta,
  QueueView,
  RecoveryTarget,
  Role,
  RunDetail,
  RunRecord,
  Stats,
  UnresolvedView,
} from '../api/types';
import metaFixture from './meta-fixture.json';

/** Generated from `buildDashboardMeta()`; `tests/app/api-meta.test.js` fails when it goes stale. */
export const META = metaFixture as Meta;

export const NOW = '2026-10-03T08:00:00.000Z';

export function meResponse(role: Role) {
  return { identity: { type: 'user' as const, email: `${role}@example.test` }, role };
}

export const HEALTH: Health = {
  status: 'ok',
  version: '2.0.0',
  time: NOW,
  runtime: {
    active: true,
    leased: true,
    leaseHolder: { id: 'abcd1234', self: true, expiresAt: '2026-10-03T08:01:00.000Z' },
    running: false,
    queued: 0,
    scheduledChannels: 1,
  },
  channelCount: 1,
};

export function channelRecord(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    platform: 'telegram',
    mode: 'drip',
    cron: '0 0-17 * * *',
    timezone: 'UTC',
    notBefore: null,
    sources: [
      { type: 'preset', preset: 'bigTechBlogs', enabled: true },
      {
        type: 'rss',
        enabled: true,
        config: { id: 'example-feed', name: 'Example Feed', feedUrl: 'https://example.test/feed.xml', category: 'AI/ML' },
      },
    ],
    prompt: { language: 'vi', style: 'digest', audience: 'Kỹ sư phần mềm', customSystemPrompt: null },
    ai: {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      name: null,
      baseUrl: null,
      apiKeyCredentialId: null,
      gateway: { accountId: 'account_1', gatewayId: 'news-engine', byokAlias: null, tokenCredentialId: 'cred-gateway' },
    },
    telegram: { botTokenCredentialId: 'cred-bot', chatIdCredentialId: 'cred-chat' },
    limits: { batchSize: 1, delayMs: 0, dailyLimit: 18, maxArticles: 18, maxArticlesPerSource: 3, concurrency: 5 },
    version: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    updatedBy: 'ops@example.test',
    cutoverRequired: false,
    ...overrides,
  };
}

export function channelStatus(overrides: Partial<ChannelStatus> = {}): ChannelStatus {
  return {
    channelId: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    mode: 'drip',
    cron: '0 0-17 * * *',
    timezone: 'UTC',
    notBefore: null,
    cutoverRequired: false,
    dailyLimit: 18,
    configVersion: 3,
    paused: false,
    version: 7,
    mutationState: 'free',
    allowedActions: ['pause'],
    scheduled: true,
    running: false,
    queued: false,
    queue: { date: '2026-10-03', total: 5, remaining: 2, blocked: 1, delivered: 3 },
    lastRun: {
      id: 'run-1',
      triggerType: 'scheduled',
      status: 'success',
      reason: null,
      startedAt: '2026-10-03T07:00:00.000Z',
      finishedAt: '2026-10-03T07:00:05.000Z',
      durationMs: 5000,
      error: null,
      aiInputTokens: 1200,
      aiOutputTokens: 300,
      outputsTotal: 1,
      outputsSucceeded: 1,
      outputsFailed: 0,
      selection: { fetched: 40, fresh: 10, relevant: 6, ranked: 3, enqueued: 1 },
      sourceHealth: { total: 16, healthy: 14, failed: 2, unknown: 0, degraded: false },
    },
    unresolvedCount: 0,
    ...overrides,
  };
}

export function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-bot',
    label: 'Bot chính',
    kind: 'telegram_bot_token',
    isSet: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    updatedBy: 'ops@example.test',
    usedBy: [],
    ...overrides,
  };
}

export function unresolvedView(targets: RecoveryTarget[], overrides: Partial<UnresolvedView> = {}): UnresolvedView {
  return {
    channel: { channelId: 'telegram-ops', state: 'active', expectedVersion: 7, allowedActions: ['pause'] },
    targets,
    page: { limit: 20, offset: 0, total: targets.length },
    ...overrides,
  };
}

export function queueView(date: string, overrides: Partial<QueueView> = {}): QueueView {
  return {
    date,
    mode: 'drip',
    total: 2,
    remaining: 1,
    blocked: 0,
    delivered: 1,
    items: [
      {
        position: 0,
        deliveryId: `d-${date}-0`,
        status: 'delivered',
        deliveryState: 'succeeded',
        title: `Bài đã đăng ${date}`,
        url: 'https://example.test/posted',
        source: 'Rust Blog',
        articleCount: 1,
        forced: false,
        createdAt: `${date}T01:00:00.000Z`,
        updatedAt: `${date}T01:05:00.000Z`,
      },
      {
        position: 1,
        deliveryId: `d-${date}-1`,
        status: 'queued',
        deliveryState: 'pending_generation',
        title: `Bài đang chờ ${date}`,
        url: 'javascript:alert(1)',
        source: 'Hacker News',
        articleCount: 1,
        forced: false,
        createdAt: `${date}T02:00:00.000Z`,
        updatedAt: `${date}T02:00:00.000Z`,
      },
    ],
    ...overrides,
  };
}

export function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    channelId: 'telegram-ops',
    triggerType: 'scheduled',
    status: 'success',
    startedAt: '2026-10-03T07:00:00.000Z',
    finishedAt: '2026-10-03T07:00:05.000Z',
    durationMs: 5000,
    stats: {
      mode: 'drip',
      reason: null,
      publishingDay: '2026-10-03',
      selection: { fetched: 40, fresh: 10, relevant: 6, ranked: 3, enqueued: 1 },
      sourceHealth: { total: 3, healthy: 1, failed: 1, unknown: 0, degraded: false },
      generation: { attempted: 1, succeeded: 1, failed: 0 },
      outputs: { total: 1, succeeded: 1, failed: 0 },
      outputResults: [{ deliveryId: 'd-1', outputId: 'telegram', success: true, deliveryState: 'success', messageIds: ['42'], error: null }],
      items: [],
      triggeredBy: null,
    },
    aiInputTokens: 1200,
    aiOutputTokens: 300,
    outputsTotal: 1,
    outputsSucceeded: 1,
    outputsFailed: 0,
    error: null,
    ...overrides,
  };
}

export function runDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    ...runRecord(),
    sourceHealth: [
      { sourceId: 'rust-blog', sourceName: 'Rust Blog', status: 'healthy', articleCount: 5, errorClass: null, observedAt: '2026-10-03T07:00:05.000Z' },
      { sourceId: 'hn', sourceName: 'Hacker News', status: 'failed', articleCount: 0, errorClass: 'http', observedAt: '2026-10-03T07:00:05.000Z' },
      { sourceId: 'devto', sourceName: null, status: 'empty', articleCount: 0, errorClass: null, observedAt: '2026-10-03T07:00:05.000Z' },
    ],
    ...overrides,
  };
}

export function contentItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-1',
    channelId: 'telegram-ops',
    articleKey: 'a'.repeat(64),
    title: 'Rust 2.0 ra mắt',
    url: 'https://example.test/rust',
    sourceId: 'rust-blog',
    sourceName: 'Rust Blog',
    category: 'Lập trình',
    publishedAt: '2026-10-02T05:00:00.000Z',
    firstSeenAt: '2026-10-03T06:00:00.000Z',
    lastSeenAt: '2026-10-03T06:00:00.000Z',
    status: 'delivered',
    rejectReason: null,
    deliveryId: 'd-0',
    messageId: '42',
    deliveredAt: '2026-10-03T07:00:00.000Z',
    runId: 'run-1',
    updatedAt: '2026-10-03T07:00:00.000Z',
    summaryPreview: 'Tóm tắt ngắn',
    ...overrides,
  };
}

export function emptyStats(overrides: Partial<Stats> = {}): Stats {
  return {
    range: { from: '2026-09-03T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z', channelId: null, utcOffsetMinutes: 420 },
    postsPerDay: [],
    sourceHealthPerDay: [],
    failureRatesPerDay: [],
    tokenUsagePerDay: [],
    ...overrides,
  };
}
