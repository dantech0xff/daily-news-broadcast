/**
 * Shared read hooks: one place for each query's key, fetcher, and refresh
 * policy. Live events (`use-live-events.ts`) invalidate these keys; the
 * intervals below are only a safety net when the event stream is down.
 */

import { useQueries, useQuery } from '@tanstack/react-query';

import { useApi } from './api-context';
import { queryKeys } from './query-keys';
import type { ContentQuery, PageQuery } from './types';

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

export function useCredentials() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.credentials, queryFn: ({ signal }) => api.listCredentials(signal) });
}

export function useContentList(query: ContentQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.contentList(query), queryFn: ({ signal }) => api.listContent(query, signal) });
}
