import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ApiClient } from './client';
import { createApi, type Api } from './endpoints';

interface ApiContextValue {
  client: ApiClient;
  api: Api;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const value = useMemo(() => ({ client, api: createApi(client) }), [client]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi() must be used inside <ApiProvider>');
  return value;
}

/** Typed endpoint functions. */
export function useApi(): Api {
  return useApiContext().api;
}

/** The underlying client (session-expiry state). */
export function useApiClient(): ApiClient {
  return useApiContext().client;
}
