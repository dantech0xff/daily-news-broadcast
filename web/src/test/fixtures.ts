/** Test data shaped exactly like the app API responses. */

import type { ChannelRecord, ChannelStatus, Credential, Health, Meta, Role } from '../api/types';
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
