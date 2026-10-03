/**
 * Playwright `test` of the dashboard specs.
 *
 * - `role` ('operator' | 'viewer' | 'unmapped' | null): every request of the
 *   test's browser context and of the `request` fixture carries that
 *   identity's Access token in `Cf-Access-Jwt-Assertion`, as Cloudflare
 *   Access adds it in production; `null` sends none.
 * - Every page fails its test on a browser console error, an uncaught page
 *   error, or a Content Security Policy violation, unless the message matches
 *   `allowedConsoleErrors` (for pages that are expected to answer 401/403).
 * - `harness` describes the running E2E server (`start-test-server.js`).
 */

import { existsSync, readFileSync } from 'node:fs';

import { test as base, expect } from '@playwright/test';

import { ACCESS_HEADER, BROWSER_UTC_OFFSET_MINUTES, E2E_ORIGIN, HARNESS_INFO_ENV } from './constants.js';

export { expect };

const BROWSER_OFFSET_MS = BROWSER_UTC_OFFSET_MINUTES * 60_000;

/** `<input type="datetime-local">` value (browser time zone, minute precision) of an ISO instant. */
export function browserInputValue(instant) {
  return new Date(Date.parse(instant) + BROWSER_OFFSET_MS).toISOString().slice(0, 16);
}

/** Calendar day (`YYYY-MM-DD`) of an ISO instant in the browser time zone (Vietnam time). */
export function browserDay(instant) {
  return new Date(Date.parse(instant) + BROWSER_OFFSET_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` moved by `delta` days. */
export function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`, as the dashboard prints days. */
export function formatDay(day) {
  return day.split('-').reverse().join('/');
}

/** The dashboard card (`<section>`) whose heading is `title`. */
export function card(page, title) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

let harness = null;

/** The description the harness wrote at startup (tokens, file paths, fixture instants). */
function harnessInfo() {
  if (harness) return harness;
  const file = process.env[HARNESS_INFO_ENV];
  if (!file) {
    throw new Error(`${HARNESS_INFO_ENV} is not set: run the E2E specs with \`npm run test:e2e\` (global setup starts the server)`);
  }
  harness = JSON.parse(readFileSync(file, 'utf8'));
  return harness;
}

/** @param {'operator'|'viewer'|'unmapped'|null} role */
function accessHeaders(role) {
  if (role === null) return {};
  const token = harnessInfo().tokens[role];
  if (!token) throw new Error(`No E2E token for role ${role}`);
  return { [ACCESS_HEADER]: token };
}

/** Every message the fake Telegram output has sent, oldest first. */
export function readSentMessages() {
  return readJsonLines(harnessInfo().sentFile);
}

/** Outbound connections the server's network guard refused. */
export function readBlockedNetworkAttempts() {
  return readJsonLines(harnessInfo().blockedFile);
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * Collect console errors, uncaught page errors, and CSP violations of `page`.
 * @param {import('@playwright/test').Page} page
 * @param {{ allowed?: RegExp[] }} [options]
 * @returns {Promise<string[]>} Live list of problems.
 */
async function watchBrowserErrors(page, { allowed = [] } = {}) {
  const problems = [];
  const report = text => {
    if (!allowed.some(pattern => pattern.test(text))) problems.push(text);
  };
  page.on('console', message => {
    if (message.type() === 'error') report(`console error: ${message.text()}`);
  });
  page.on('pageerror', error => report(`uncaught page error: ${error.message}`));
  // Init scripts run outside the page CSP, so the listener sees every violation.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline content'}`);
    });
  });
  return problems;
}

/** Mutation headers the dashboard itself sends (same origin, JSON). */
export const MUTATION_HEADERS = Object.freeze({ Origin: E2E_ORIGIN, 'Content-Type': 'application/json' });

export const test = base.extend({
  role: ['operator', { option: true }],
  allowedConsoleErrors: [[], { option: true }],

  harness: async ({}, use) => {
    await use(harnessInfo());
  },

  extraHTTPHeaders: async ({ role }, use) => {
    await use(accessHeaders(role));
  },

  page: async ({ page, allowedConsoleErrors }, use) => {
    const problems = await watchBrowserErrors(page, { allowed: allowedConsoleErrors });
    await use(page);
    expect(problems, 'browser console errors, uncaught page errors, or CSP violations').toEqual([]);
  },

  /** API client of another identity than the test's `role`. */
  apiAs: async ({ playwright }, use) => {
    const contexts = [];
    await use(async role => {
      const context = await playwright.request.newContext({ baseURL: E2E_ORIGIN, extraHTTPHeaders: accessHeaders(role) });
      contexts.push(context);
      return context;
    });
    await Promise.all(contexts.map(context => context.dispose()));
  },
});
