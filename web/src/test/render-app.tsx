/**
 * Render the real routes against a mocked `fetch`: every request goes through
 * the production API client, so tests see the exact request bodies and the
 * error mapping the dashboard uses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { ApiProvider } from '../api/api-context';
import { createApiClient } from '../api/client';
import type { Role } from '../api/types';
import { APP_ROUTES } from '../app/app';
import { SessionProvider } from '../app/session';
import { ToastProvider } from '../components/toast';
import { HEALTH, META, meResponse } from './fixtures';

export interface RecordedRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  init: RequestInit;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

export type MockHandler = MockReply | ((request: RecordedRequest) => MockReply | Response | Promise<MockReply | Response>);

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** `routes` are keyed `METHOD /path` (no query string); unknown routes answer 404. */
export function createMockFetch(routes: Record<string, MockHandler>) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      search: url.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      init,
    };
    calls.push(request);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse(404, { error: 'not_found', message: 'Không tìm thấy.' });
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    return reply instanceof Response ? reply : jsonResponse(reply.status ?? 200, reply.body);
  };
  return {
    fetch,
    calls,
    callsTo: (method: string, path: string) => calls.filter(call => call.method === method && call.path === path),
  };
}

export function renderApp({ route = '/', role = 'operator', routes = {} }: { route?: string; role?: Role; routes?: Record<string, MockHandler> } = {}) {
  const mock = createMockFetch({
    'GET /api/me': { body: meResponse(role) },
    'GET /api/meta': { body: META },
    'GET /api/health': { body: HEALTH },
    'GET /api/channels': { body: { channels: [] } },
    'GET /api/credentials': { body: { credentials: [] } },
    'GET /api/content': { body: { items: [], page: { limit: 8, offset: 0, total: 0 } } },
    ...routes,
  });
  const client = createApiClient({ fetch: mock.fetch });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const user = userEvent.setup();
  const router = createMemoryRouter(APP_ROUTES, { initialEntries: [route] });
  const view = render(
    <ApiProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...view, mock, client, queryClient, user, router };
}
