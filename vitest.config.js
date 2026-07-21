import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const OUTBOUND_DENIAL = 'Unexpected outbound request blocked by Workers test harness';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/fixtures/cloudflare-worker.js',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2024-09-23',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          NEWS_RUNTIME_MODE: 'active',
          NEWS_DEFAULT_PAUSED: 'false',
          DELIVERY_ATTEMPT_TIMEOUT_MS: '1000',
        },
        kvNamespaces: ['NEWS_CACHE'],
        durableObjects: {
          NEWS_COORDINATOR: {
            className: 'ChannelDeliveryCoordinator',
            useSQLite: true,
          },
        },
        outboundService(request) {
          return new Response(`${OUTBOUND_DENIAL}: ${new URL(request.url).origin}`, {
            status: 598,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-NewsEngine-Network': 'blocked',
            },
          });
        },
      },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.js'],
    setupFiles: ['./tests/workers/setup.js'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
