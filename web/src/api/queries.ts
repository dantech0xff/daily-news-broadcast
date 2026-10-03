/**
 * Shared read hooks: one place for each query's key, fetcher, and refresh
 * policy. Live events (`use-live-events.ts`) invalidate these keys; the
 * intervals below are only a safety net when the event stream is down.
 */

import { keepPreviousData, skipToken, useQueries, useQuery } from '@tanstack/react-query';

import { useApi } from './api-context';
import { queryKeys } from './query-keys';
import type { ContentQuery, PageQuery, StatsQuery } from './types';

const STATUS_REFRESH_MS = 60_000;
const HEALTH_REFRESH_MS = 30_000;

export function useMeta() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.meta, queryFn: ({ signal }) => api.getMeta(signal), staleTime: Infinity });
}

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.health, queryFn: ({ signal }) => api.getHealth(signal), refetchInterval: HEALTH_REFRESH_MS });
}

export function useChannels() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.channels, queryFn: ({ signal }) => api.listChannels(signal) });
}

export function useChannel(channelId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.channel(channelId ?? ''),
    queryFn: ({ signal }) => api.getChannel(channelId ?? '', signal),
    enabled: Boolean(channelId),
  });
}

export function useChannelStatus(channelId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.status(channelId ?? ''),
    queryFn: ({ signal }) => api.getStatus(channelId ?? '', signal),
    enabled: Boolean(channelId),
    refetchInterval: STATUS_REFRESH_MS,
  });
}

/** Status of several channels, in the order of `channelIds`. */
export function useChannelStatuses(channelIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: channelIds.map(channelId => ({
      queryKey: queryKeys.status(channelId),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getStatus(channelId, signal),
      refetchInterval: STATUS_REFRESH_MS,
    })),
  });
}

/** First page of recovery targets of several channels, in the order of `channelIds`. */
export function useUnresolvedLists(channelIds: readonly string[], page: PageQuery = { limit: 100, offset: 0 }) {
  const api = useApi();
  return useQueries({
    queries: channelIds.map(channelId => ({
      queryKey: queryKeys.unresolved(channelId, page),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.listUnresolved(channelId, page, signal),
      refetchInterval: STATUS_REFRESH_MS,
    })),
  });
}

/** One page of a channel's recovery targets; the previous page stays visible while the next loads. */
export function useUnresolved(channelId: string, page: PageQuery) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.unresolved(channelId, page),
    queryFn: ({ signal }) => api.listUnresolved(channelId, page, signal),
    refetchInterval: STATUS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/** Queue of one publishing day; `null` = today in the channel timezone. */
export function useQueue(channelId: string, day: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.queue(channelId, day),
    queryFn: ({ signal }) => api.getQueue(channelId, day ?? undefined, signal),
    refetchInterval: STATUS_REFRESH_MS,
  });
}

/** One page of a channel's run history, newest first. */
export function useRuns(channelId: string, page: PageQuery) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.runs(channelId, page),
    queryFn: ({ signal }) => api.listRuns(channelId, page, signal),
    refetchInterval: STATUS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/** One run with its per-source health. */
export function useRun(runId: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.run(runId), queryFn: ({ signal }) => api.getRun(runId, signal) });
}

export function useCredentials() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.credentials, queryFn: ({ signal }) => api.listCredentials(signal) });
}

/** Library page; the previous result stays visible while new filters load. */
export function useContentList(query: ContentQuery) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.contentList(query),
    queryFn: ({ signal }) => api.listContent(query, signal),
    placeholderData: keepPreviousData,
  });
}

/** One library item with its full AI summary. */
export function useContentItem(contentId: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.contentItem(contentId), queryFn: ({ signal }) => api.getContent(contentId, signal) });
}

/** Statistics of one range; `null` while the range is invalid (nothing is requested). */
export function useStats(query: StatsQuery | null) {
  const api = useApi();
  return useQuery({
    queryKey: query ? queryKeys.statsRange(query) : queryKeys.stats,
    queryFn: query ? ({ signal }) => api.getStats(query, signal) : skipToken,
  });
}
