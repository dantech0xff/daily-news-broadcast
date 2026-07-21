import { afterEach, beforeEach, vi } from 'vitest';

export const NETWORK_DENIAL = 'Unexpected outbound request blocked by Workers test setup';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`${NETWORK_DENIAL}: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});
