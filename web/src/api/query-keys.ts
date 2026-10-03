/**
 * TanStack Query keys. Prefixes are chosen so one invalidation covers a
 * family: `['ops', channelId]` covers every operational read of a channel
 * (status, queue, unresolved, runs); `['content']` every library read.
 */

import type { ContentQuery, PageQuery, StatsQuery } from './types';

export const queryKeys = {
  health: ['health'] as const,
  me: ['me'] as const,
  meta: ['meta'] as const,
  channels: ['channels'] as const,
  channel: (channelId: string) => ['channel', channelId] as const,
  ops: (channelId: string) => ['ops', channelId] as const,
  status: (channelId: string) => ['ops', channelId, 'status'] as const,
  queue: (channelId: string, day: string | null) => ['ops', channelId, 'queue', day ?? 'today'] as const,
  unresolved: (channelId: string, page: PageQuery = {}) => ['ops', channelId, 'unresolved', page] as const,
  runs: (channelId: string, page: PageQuery = {}) => ['ops', channelId, 'runs', page] as const,
  run: (runId: string) => ['run', runId] as const,
  credentials: ['credentials'] as const,
  content: ['content'] as const,
  contentList: (query: ContentQuery) => ['content', 'list', query] as const,
  contentItem: (contentId: string) => ['content', 'item', contentId] as const,
  stats: ['stats'] as const,
  statsRange: (query: StatsQuery) => ['stats', query] as const,
};
