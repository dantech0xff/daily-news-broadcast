import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter, type RouteObject } from 'react-router';

import { ApiProvider } from '../api/api-context';
import type { ApiClient } from '../api/client';
import { ToastProvider } from '../components/toast';
import { ChannelCreatePage, ChannelEditPage } from '../pages/channels/channel-edit-page';
import { ChannelsPage } from '../pages/channels/channels-page';
import { NotFoundPage } from '../pages/not-found-page';
import { LibraryPage } from '../pages/library/library-page';
import { OperationsPage } from '../pages/operations/operations-page';
import { OverviewPage } from '../pages/overview/overview-page';
import { SecretsPage } from '../pages/secrets/secrets-page';
import { StatsPage } from '../pages/stats/stats-page';
import { AppShell } from './app-shell';
import { SessionProvider } from './session';

/**
 * Every route renders inside the shell; the server answers unknown paths with
 * index.html. A data router is used so forms can block in-app navigation
 * while they hold unsaved changes (`useBlocker`).
 */
export const APP_ROUTES: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'channels', element: <ChannelsPage /> },
      { path: 'channels/new', element: <ChannelCreatePage /> },
      { path: 'channels/:channelId/edit', element: <ChannelEditPage /> },
      { path: 'operations', element: <OperationsPage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'secrets', element: <SecretsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** The router is created once, outside React (`main.tsx`), so StrictMode never builds a second one. */
export function App({ client, queryClient, router }: {
  client: ApiClient;
  queryClient: QueryClient;
  router: ReturnType<typeof createBrowserRouter>;
}) {
  return (
    <ApiProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}
