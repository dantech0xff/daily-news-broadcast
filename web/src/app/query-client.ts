import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';

const MAX_RETRIES = 2;

/**
 * Reads retry only transient failures (network, 5xx); client errors, a
 * forbidden role, and an expired session are final. Mutations never retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || !(error instanceof ApiError) || error.isSessionExpired) return false;
  return error.code === 'network_error' || error.status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: shouldRetryQuery,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
