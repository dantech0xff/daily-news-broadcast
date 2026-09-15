/**
 * Shared utility: fetch og:image from article pages
 * Used by source plugins to enrich articles missing imageUrl
 */

import { discardSourceResponse, readSourceText } from './source-result.js';

const MAX_OG_IMAGE_RESPONSE_BODY_BYTES = 50 * 1024;

/**
 * Fetch og:image from article pages for articles missing imageUrl.
 * Runs concurrent requests with short timeout — failures silently ignored.
 * @param {Array<{imageUrl?: string, url?: string}>} articles
 * @param {{signal?: AbortSignal}} options
 */
export async function enrichMissingImages(articles, options = {}) {
  const missing = articles.filter(a => !a.imageUrl && a.url);
  if (missing.length === 0) return;

  const results = await Promise.allSettled(
    missing.map(a => fetchOgImage(a.url, options.signal))
  );

  for (let i = 0; i < missing.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value) {
      missing[i].imageUrl = results[i].value;
    }
  }
}

/**
 * Fetch a page and extract og:image meta tag.
 * Reads only first 50KB to find the tag quickly.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchOgImage(url, externalSignal) {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ContentRadar/2.0' },
    });

    if (!res.ok) {
      await discardSourceResponse(res);
      return null;
    }

    const html = await readSourceText(res, MAX_OG_IMAGE_RESPONSE_BODY_BYTES);

    const match = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:image["']/i);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}
