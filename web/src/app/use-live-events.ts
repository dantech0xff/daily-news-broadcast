/**
 * Live updates over server-sent events (`GET /api/events`). Each runtime
 * event invalidates the queries it can change; nothing is patched by hand.
 *
 * Reconnection is managed here rather than by `EventSource`: an Access
 * session that expired turns the stream into a cross-origin redirect, which
 * `EventSource` reports only as a generic error. On every error the stream
 * is closed and `/api/me` is probed through the API client; an expired
 * session or a lost role stops reconnecting for good (the client then shows
 * the session dialog), anything else reconnects with capped exponential
 * backoff. The stream also closes while the tab is hidden and reopens when it
 * is visible again; every reconnect refreshes all queries to catch up.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApi, useApiClient } from '../api/api-context';
import { ApiError } from '../api/client';
import { EVENTS_URL } from '../api/endpoints';
import { queryKeys } from '../api/query-keys';
import type { LiveEvent } from '../api/types';

/** `stopped` is terminal: the session expired or the role was lost; only a page reload reconnects. */
export type LiveState = 'connecting' | 'open' | 'closed' | 'stopped' | 'unsupported';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export function useLiveEvents(enabled = true): LiveState {
  const queryClient = useQueryClient();
  const client = useApiClient();
  const api = useApi();
  const [state, setState] = useState<LiveState>(typeof EventSource === 'undefined' ? 'unsupported' : 'connecting');

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let connectedBefore = false;

    const closeSource = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      if (stopped || source || document.visibilityState === 'hidden') return;
      if (client.sessionExpired) {
        setState('stopped');
        return;
      }
      setState('connecting');
      const stream = new EventSource(EVENTS_URL);
      source = stream;
      stream.onmessage = message => {
        const event = parseLiveEvent(message.data);
        if (!event) return;
        if (event.type === 'connected') {
          attempt = 0;
          setState('open');
          // Events may have been missed while disconnected.
          if (connectedBefore) void queryClient.invalidateQueries();
          connectedBefore = true;
          return;
        }
        applyLiveEvent(queryClient, event);
      };
      stream.onerror = () => {
        if (source !== stream) return;
        closeSource();
        setState('closed');
        void recover();
      };
    };

    const recover = async () => {
      try {
        await api.getMe();
      } catch (error) {
        if (error instanceof ApiError && (error.isSessionExpired || error.isForbidden)) {
          if (!stopped) setState('stopped');
          return;
        }
      }
      if (stopped) return;
      if (client.sessionExpired) {
        setState('stopped');
        return;
      }
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
      attempt += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(retryTimer);
        closeSource();
        setState('closed');
      } else {
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      closeSource();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, api, client, queryClient]);

  return state;
}

export function parseLiveEvent(data: unknown): LiveEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { type, at, data: payload } = parsed as Record<string, unknown>;
    if (typeof type !== 'string') return null;
    return {
      type,
      at: typeof at === 'string' ? at : new Date().toISOString(),
      data: typeof payload === 'object' && payload !== null ? (payload as LiveEvent['data']) : {},
    };
  } catch {
    return null;
  }
}

/** Invalidate what a runtime event can change. */
export function applyLiveEvent(queryClient: QueryClient, event: LiveEvent): void {
  const channelId = typeof event.data.channelId === 'string' ? event.data.channelId : null;
  const invalidate = (queryKey: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey });
  switch (event.type) {
    case 'run.started':
    case 'run.finished':
    case 'control.applied':
      if (channelId) invalidate(queryKeys.ops(channelId));
      invalidate(queryKeys.health);
      if (event.type === 'run.finished') {
        if (typeof event.data.runId === 'string') invalidate(queryKeys.run(event.data.runId));
        invalidate(queryKeys.content);
        invalidate(queryKeys.stats);
      }
      if (event.type === 'control.applied') invalidate(queryKeys.content);
      break;
    case 'channel.changed':
      invalidate(queryKeys.channels);
      invalidate(queryKeys.credentials);
      invalidate(queryKeys.health);
      if (channelId) {
        invalidate(queryKeys.channel(channelId));
        invalidate(queryKeys.ops(channelId));
      }
      break;
    case 'credential.changed':
      invalidate(queryKeys.credentials);
      break;
    default:
      break;
  }
}
