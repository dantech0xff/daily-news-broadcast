import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiProvider } from '../api/api-context';
import { createApiClient } from '../api/client';
import { queryKeys } from '../api/query-keys';
import { meResponse } from '../test/fixtures';
import { createMockFetch, type MockHandler } from '../test/render-app';
import { applyLiveEvent, parseLiveEvent, useLiveEvents } from './use-live-events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(payload) }));
  }

  fail() {
    act(() => this.onerror?.());
  }
}

function LiveProbe() {
  return <p>state:{useLiveEvents()}</p>;
}

function renderLive(meHandler: MockHandler) {
  const mock = createMockFetch({ 'GET /api/me': meHandler });
  const client = createApiClient({ fetch: mock.fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <ApiProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <LiveProbe />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { mock, client, queryClient };
}

function seed(queryClient: QueryClient, keys: readonly (readonly unknown[])[]) {
  for (const key of keys) queryClient.setQueryData(key, { seeded: true });
}

const invalidated = (queryClient: QueryClient, key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated === true;

describe('parseLiveEvent', () => {
  it('accepts the server event shape and rejects anything else', () => {
    expect(parseLiveEvent('{"type":"run.finished","at":"2026-10-03T08:00:00.000Z","data":{"channelId":"a"}}'))
      .toEqual({ type: 'run.finished', at: '2026-10-03T08:00:00.000Z', data: { channelId: 'a' } });
    expect(parseLiveEvent('not json')).toBeNull();
    expect(parseLiveEvent('{"data":{}}')).toBeNull();
    expect(parseLiveEvent(42)).toBeNull();
  });
});

describe('applyLiveEvent', () => {
  it('invalidates what a finished run can change and nothing else', () => {
    const queryClient = new QueryClient();
    const keys = {
      status: queryKeys.status('a'),
      otherStatus: queryKeys.status('b'),
      run: queryKeys.run('r1'),
      content: queryKeys.contentList({ status: ['delivered'] }),
      stats: queryKeys.statsRange({ from: 'x', to: 'y' }),
      credentials: queryKeys.credentials,
      channel: queryKeys.channel('a'),
    };
    seed(queryClient, Object.values(keys));
    applyLiveEvent(queryClient, { type: 'run.finished', at: '', data: { channelId: 'a', runId: 'r1', status: 'success' } });

    expect(invalidated(queryClient, keys.status)).toBe(true);
    expect(invalidated(queryClient, keys.run)).toBe(true);
    expect(invalidated(queryClient, keys.content)).toBe(true);
    expect(invalidated(queryClient, keys.stats)).toBe(true);
    expect(invalidated(queryClient, keys.otherStatus)).toBe(false);
    expect(invalidated(queryClient, keys.credentials)).toBe(false);
    expect(invalidated(queryClient, keys.channel)).toBe(false);
  });

  it('refreshes channel config and credential usage on channel changes', () => {
    const queryClient = new QueryClient();
    seed(queryClient, [queryKeys.channels, queryKeys.channel('a'), queryKeys.credentials, queryKeys.status('a'), queryKeys.channel('b')]);
    applyLiveEvent(queryClient, { type: 'channel.changed', at: '', data: { channelId: 'a', action: 'updated', version: 4 } });

    expect(invalidated(queryClient, queryKeys.channels)).toBe(true);
    expect(invalidated(queryClient, queryKeys.channel('a'))).toBe(true);
    expect(invalidated(queryClient, queryKeys.credentials)).toBe(true);
    expect(invalidated(queryClient, queryKeys.status('a'))).toBe(true);
    expect(invalidated(queryClient, queryKeys.channel('b'))).toBe(false);
  });
});

describe('useLiveEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies events and reconnects with backoff, refreshing everything once reconnected', async () => {
    const { mock, queryClient } = renderLive({ body: meResponse('viewer') });
    const first = FakeEventSource.instances[0];
    expect(first?.url).toBe('/api/events');
    first?.emit({ type: 'connected', at: '', data: {} });
    expect(await screen.findByText('state:open')).toBeInTheDocument();

    seed(queryClient, [queryKeys.status('a')]);
    first?.emit({ type: 'control.applied', at: '', data: { channelId: 'a', action: 'pause', status: 'paused' } });
    expect(invalidated(queryClient, queryKeys.status('a'))).toBe(true);

    first?.fail();
    expect(first?.closed).toBe(true);
    await waitFor(() => expect(mock.callsTo('GET', '/api/me')).toHaveLength(1));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3_000 });

    seed(queryClient, [queryKeys.credentials]);
    FakeEventSource.instances[1]?.emit({ type: 'connected', at: '', data: {} });
    expect(invalidated(queryClient, queryKeys.credentials)).toBe(true);
  });

  it('stops for good when the probe finds the Access session expired', async () => {
    const { client } = renderLive({ status: 401, body: { error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' } });
    FakeEventSource.instances[0]?.fail();

    await waitFor(() => expect(client.sessionExpired).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 1_700));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByText('state:stopped')).toBeInTheDocument();
  });
});
