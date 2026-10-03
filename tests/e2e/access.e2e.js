/**
 * Access at the edge of the app: without a valid Cloudflare Access token no
 * part of the dashboard is served (UI, assets, or API), and an Access
 * identity without a dashboard role gets 403. `/healthz` is the only open
 * route and reveals nothing.
 */

import { readFileSync } from 'node:fs';

import { ACCESS_HEADER } from './fixtures/constants.js';
import { expect, test } from './fixtures/dashboard-test.js';

const WEB_BUILD_INDEX = new URL('../../web/dist/index.html', import.meta.url);

/** Script and stylesheet paths of the built dashboard. */
function builtAssetPaths() {
  const html = readFileSync(WEB_BUILD_INDEX, 'utf8');
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
}

/** What Chromium logs for a page that is itself the error response; nothing else is tolerated. */
const documentStatusLogged = status => new RegExp(`^console error: Failed to load resource: the server responded with a status of ${status} \\(\\w+\\)$`);

test.describe('without an Access token', () => {
  test.use({ role: null, allowedConsoleErrors: [documentStatusLogged(401)] });

  test('every dashboard route answers 401 and no UI is served', async ({ page, request, apiAs }) => {
    for (const path of ['/', '/channels/telegram-main/edit', '/secrets']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(401);
      await expect(page.getByRole('heading', { level: 1, name: 'Chưa xác thực' })).toBeVisible();
      await expect(page.getByText('Cần đăng nhập qua Cloudflare Access.')).toBeVisible();
      await expect(page.locator('#root')).toHaveCount(0);
      await expect(page.locator('script')).toHaveCount(0);
    }

    const assets = builtAssetPaths();
    expect(assets.length).toBeGreaterThan(0);
    const operator = await apiAs('operator');
    for (const asset of assets) {
      expect((await request.get(asset)).status(), asset).toBe(401);
      // The same file is there for a signed-in user: only the token makes the difference.
      expect((await operator.get(asset)).status(), asset).toBe(200);
    }

    const api = await request.get('/api/health');
    expect(api.status()).toBe(401);
    expect(await api.json()).toMatchObject({ error: 'unauthenticated' });
    const forged = await request.get('/api/me', { headers: { [ACCESS_HEADER]: 'not-a-signed-access-token' } });
    expect(forged.status()).toBe(401);

    const liveness = await request.get('/healthz');
    expect(liveness.status()).toBe(200);
    expect(await liveness.text()).toBe('ok');
  });
});

test.describe('with an Access identity that has no dashboard role', () => {
  test.use({ role: 'unmapped', allowedConsoleErrors: [documentStatusLogged(403)] });

  test('the dashboard answers 403 and serves no UI or data', async ({ page, request }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('heading', { level: 1, name: 'Không có quyền truy cập' })).toBeVisible();
    await expect(page.locator('#root')).toHaveCount(0);
    await expect(page.locator('script')).toHaveCount(0);

    const me = await request.get('/api/me');
    expect(me.status()).toBe(403);
    expect(await me.json()).toMatchObject({ error: 'forbidden' });
    expect((await request.get('/api/channels')).status()).toBe(403);
    // A valid Access identity may read liveness details, nothing else.
    expect((await request.get('/api/health')).status()).toBe(200);
  });
});
