/**
 * Vite + Vitest config of the Content Radar dashboard.
 *
 * Production: `npm run build` writes static files to `web/dist`, which the
 * app server (`src/app/server.js`) serves behind Cloudflare Access. The
 * server's CSP allows same-origin scripts and styles only (no inline
 * `<script>`/`<style>`), so the build must keep emitting external assets and
 * the UI must not use libraries that inject `<style>` tags at run time.
 *
 * Local development (two terminals, repository root):
 *   1. Sign a dev Access token (prints the backend env to stderr):
 *        export DEV_ACCESS_TOKEN="$(npm run -s dev:token -- --email you@example.com)"
 *   2. Start the backend with the dev JWKS:
 *        NODE_ENV=development ACCESS_JWKS_FILE=.cache/dev-access/jwks.json ACCESS_AUD=content-radar-dev \
 *        APP_OPERATOR_EMAILS=you@example.com PUBLIC_ORIGIN=http://localhost:5173 \
 *        DATA_DIR=.cache/app-data CACHE_PATH=.cache/app-data/news.json \
 *        APP_MASTER_KEY="<base64 of 32 random bytes, e.g. from openssl rand -base64 32>" npm run app:dev
 *      - NODE_ENV must be `development` (or `test`): the app refuses
 *        ACCESS_JWKS_FILE otherwise, including when NODE_ENV is unset.
 *      - PUBLIC_ORIGIN must be the Vite origin: mutations must carry that
 *        exact Origin, which the proxy forwards unchanged.
 *      - Give the app its own DATA_DIR and CACHE_PATH. Never share the CLI's
 *        cache file (CACHE_PATH in `.env`, which the app also loads; values
 *        set on the command line win) with the app.
 *      - APP_MASTER_KEY is required; keep the same value across restarts, or
 *        stored credentials cannot be decrypted.
 *   3. Start Vite with the same token: `npm run web:dev`, open http://localhost:5173.
 * The dev server proxies `/api` (including the SSE stream) to
 * `API_PROXY_TARGET` (default http://127.0.0.1:3000) and adds the
 * `Cf-Access-Jwt-Assertion` header from `DEV_ACCESS_TOKEN`, standing in for
 * Cloudflare Access. The token is read from the environment only; never
 * commit it or put it in a `.env` file.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const DEV_PORT = 5173;
const DEFAULT_API_TARGET = 'http://127.0.0.1:3000';

export default defineConfig(({ command }) => {
  const token = process.env.DEV_ACCESS_TOKEN?.trim() ?? '';
  const apiTarget = process.env.API_PROXY_TARGET?.trim() || DEFAULT_API_TARGET;
  if (command === 'serve' && !process.env.VITEST && token === '') {
    console.warn('[web] DEV_ACCESS_TOKEN is not set: the backend will answer 401 to every /api request (see vite.config.ts).');
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: 'localhost',
      port: DEV_PORT,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          // Keep the browser's Host/Origin: the backend compares Origin with PUBLIC_ORIGIN.
          changeOrigin: false,
          headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      // Inlined assets become data: URIs, which the CSP allows for images and fonts only.
      assetsInlineLimit: 0,
      // One bundle on purpose: a redeploy replaces web/dist, so a lazily loaded
      // route chunk requested by a tab opened before the deploy would 404. The
      // whole dashboard is about 165 kB gzipped; the limit (kB, minified) still
      // flags unexpected growth.
      chunkSizeWarningLimit: 650,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
