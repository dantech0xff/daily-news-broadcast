/**
 * Typed functions for every app API endpoint. Reads take an optional
 * `AbortSignal` (TanStack Query passes one); mutations send JSON bodies with
 * `Content-Type: application/json` (see `client.ts`).
 */

import type { ApiClient } from './client';
import type {
  ChannelInput,
  ChannelRecord,
  ChannelStatus,
  ChannelUpdate,
  ContentItem,
  ContentPage,
  ContentQuery,
  ControlAction,
  ControlParams,
  ControlResult,
  Credential,
  CredentialInput,
  Health,
  Me,
  Meta,
  PageQuery,
  PreviewResult,
  QueueView,
  RunDetail,
  RunPage,
  RunQueued,
  Stats,
  StatsQuery,
  UnresolvedView,
} from './types';

/** Server-sent events stream (opened with `EventSource`, see `use-live-events.ts`). */
export const EVENTS_URL = '/api/events';

/** Day boundary the dashboard uses for statistics: Vietnam time (UTC+7). */
export const VIETNAM_UTC_OFFSET_MINUTES = 420;

const segment = (value: string) => encodeURIComponent(value);

export function createApi(client: ApiClient) {
  return {
    getHealth: (signal?: AbortSignal) => client.request<Health>('/api/health', { signal }),
    getMe: (signal?: AbortSignal) => client.request<Me>('/api/me', { signal }),
    getMeta: (signal?: AbortSignal) => client.request<Meta>('/api/meta', { signal }),

    listChannels: async (signal?: AbortSignal) =>
      (await client.request<{ channels: ChannelRecord[] }>('/api/channels', { signal })).channels,
    getChannel: (channelId: string, signal?: AbortSignal) =>
      client.request<ChannelRecord>(`/api/channels/${segment(channelId)}`, { signal }),
    createChannel: (input: ChannelInput) =>
      client.request<ChannelRecord>('/api/channels', { method: 'POST', body: input }),
    updateChannel: (channelId: string, update: ChannelUpdate) =>
      client.request<ChannelRecord>(`/api/channels/${segment(channelId)}`, { method: 'PUT', body: update }),
    deleteChannel: (channelId: string, expectedVersion: number) =>
      client.request<{ channelId: string; deleted: true }>(`/api/channels/${segment(channelId)}`, {
        method: 'DELETE',
        body: { expectedVersion },
      }),

    listCredentials: async (signal?: AbortSignal) =>
      (await client.request<{ credentials: Credential[] }>('/api/credentials', { signal })).credentials,
    createCredential: (input: CredentialInput) =>
      client.request<Credential>('/api/credentials', { method: 'POST', body: input }),
    replaceCredential: (credentialId: string, value: string) =>
      client.request<Credential>(`/api/credentials/${segment(credentialId)}`, { method: 'PUT', body: { value } }),
    deleteCredential: (credentialId: string) =>
      client.request<{ credentialId: string; deleted: true }>(`/api/credentials/${segment(credentialId)}`, {
        method: 'DELETE',
        body: {},
      }),

    getStatus: (channelId: string, signal?: AbortSignal) =>
      client.request<ChannelStatus>(`/api/channels/${segment(channelId)}/status`, { signal }),
    /** Queue of one publishing day (`YYYY-MM-DD`); today in the channel timezone when omitted. */
    getQueue: (channelId: string, day?: string, signal?: AbortSignal) =>
      client.request<QueueView>(`/api/channels/${segment(channelId)}/queue`, { query: { day }, signal }),
    listUnresolved: (channelId: string, page: PageQuery = {}, signal?: AbortSignal) =>
      client.request<UnresolvedView>(`/api/channels/${segment(channelId)}/unresolved`, {
        query: { limit: page.limit, offset: page.offset },
        signal,
      }),
    listRuns: (channelId: string, page: PageQuery = {}, signal?: AbortSignal) =>
      client.request<RunPage>(`/api/channels/${segment(channelId)}/runs`, {
        query: { limit: page.limit, offset: page.offset },
        signal,
      }),
    getRun: (runId: string, signal?: AbortSignal) => client.request<RunDetail>(`/api/runs/${segment(runId)}`, { signal }),
    /** Queue a manual run (202). Answers 409 `channel_busy`/`channel_disabled` or 503 `runtime_not_leased` otherwise. */
    runNow: (channelId: string) =>
      client.request<RunQueued>(`/api/channels/${segment(channelId)}/run`, { method: 'POST', body: {} }),
    /** Read-only dry run: fetches and calls the AI, never sends or writes state. */
    preview: (channelId: string) =>
      client.request<PreviewResult>(`/api/channels/${segment(channelId)}/preview`, { method: 'POST', body: {} }),
    control: (channelId: string, action: ControlAction, params: ControlParams) =>
      client.request<ControlResult>(`/api/channels/${segment(channelId)}/control/${segment(action)}`, {
        method: 'POST',
        body: params,
      }),

    listContent: (query: ContentQuery = {}, signal?: AbortSignal) =>
      client.request<ContentPage>('/api/content', {
        query: {
          channelId: query.channelId,
          status: query.status,
          source: query.source,
          dateField: query.dateField,
          from: query.from,
          to: query.to,
          keyword: query.keyword,
          limit: query.limit,
          offset: query.offset,
        },
        signal,
      }),
    getContent: (contentId: string, signal?: AbortSignal) =>
      client.request<ContentItem>(`/api/content/${segment(contentId)}`, { signal }),

    getStats: (query: StatsQuery, signal?: AbortSignal) =>
      client.request<Stats>('/api/stats', {
        query: {
          from: query.from,
          to: query.to,
          channelId: query.channelId,
          utcOffsetMinutes: query.utcOffsetMinutes ?? VIETNAM_UTC_OFFSET_MINUTES,
        },
        signal,
      }),
  };
}

export type Api = ReturnType<typeof createApi>;
