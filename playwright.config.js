/**
 * Browser E2E tests of the dashboard (`npm run test:e2e`): Chromium against
 * the real app and the real `web/dist` build, started offline by
 * `tests/e2e/global-setup.js` on 127.0.0.1:4310. Specs are `tests/e2e/*.e2e.js`
 * (never `*.test.js`, which the Node test runner collects). They share one
 * server and run in order in a single worker; artifacts (traces of failed
 * tests) go to `.cache/e2e/`, which git ignores.
 */

import { defineConfig, devices } from '@playwright/test';

import { BROWSER_TIME_ZONE, E2E_ORIGIN } from './tests/e2e/fixtures/constants.js';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.js',
  globalSetup: './tests/e2e/global-setup.js',
  outputDir: './.cache/e2e/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: E2E_ORIGIN,
    locale: 'vi-VN',
    // Fixed so date-time inputs and formatted dates do not depend on the machine.
    timezoneId: BROWSER_TIME_ZONE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
