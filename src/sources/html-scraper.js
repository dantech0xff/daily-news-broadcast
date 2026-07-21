/**
 * Source Plugin: HTML Scraper
 * Cho các blog không có RSS feed (Discord, Figma, Stripe...)
 */

import { SourcePlugin } from '../core/contracts.js';
import { cleanHTML } from './rss.js';
import {
  SOURCE_FETCH_DIAGNOSTIC_CAPABILITY,
  discardSourceResponse,
  fetchSourceWithDiagnostics,
  httpSourceFailure,
  invalidSourceShape,
  readLastFetchDiagnostic,
  readSourceText,
  runDiagnosedFetch,
  unknownSourceResult,
  validateArticleArray,
} from './source-result.js';

export class HTMLScraperSource extends SourcePlugin {
  /**
   * @param {Object} config
   * @param {string} config.id
   * @param {string} config.name
   * @param {string} config.url         - Page URL to scrape
   * @param {string} [config.icon]
   * @param {string} [config.category]
   * @param {Object} [config.selectors] - Custom CSS-like regex patterns
   */
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return this._config.id; }
  get name() { return this._config.name; }
  get sourceKey() {
    return JSON.stringify([
      'html-scraper', this.id, this.name, this._config.url,
      this._config.category ?? '',
      Object.entries(this._config.selectors ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]);
  }
  get icon() { return this._config.icon || '🌐'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 5 } = options;

      const response = await fetch(this._config.url, {
        signal: options.signal,
        headers: { 'User-Agent': 'NewsEngine/2.0', 'Accept': 'text/html' },
      });
      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const html = await readSourceText(response);
      validateHTMLDocument(html);
      const articles = this._extractArticles(html);
      validateArticleArray(articles);
      if (articles.length > 0) return articles.slice(0, limit);

      // A syntactically valid page with no recognizable article structure may
      // have changed layout. It is not sufficient evidence of source exhaustion.
      if (hasRecognizableArticleMarkup(html)) throw invalidSourceShape();
      return unknownSourceResult();
    });
  }

  _extractArticles(html) {
    const articles = [];
    const seen = new Set();

    // Extract og:image as fallback for articles without their own image
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/i);
    const ogImage = ogImageMatch ? ogImageMatch[1] : null;

    // Strategy 1: <article> blocks
    const articleBlocks = html.match(/<article[^>]*>[\s\S]*?<\/article>/gi) || [];
    for (const block of articleBlocks) {
      const article = this._parseBlock(block, ogImage);
      if (article && !seen.has(article.url)) {
        seen.add(article.url);
        articles.push(article);
      }
    }
    if (articles.length > 0) return articles;

    // Strategy 2: Link patterns for blog posts
    const linkRe = /<a[^>]*href="([^"]*(?:blog|post|article|engineering)[^"]*)"[^>]*>([^<]{10,})<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html))) {
      const url = this._resolveUrl(m[1]);
      const title = cleanHTML(m[2]);
      if (!seen.has(url) && title.length > 10) {
        seen.add(url);
        articles.push({
          id: url,
          title,
          url,
          content: '',
          source: this.name,
          category: this._config.category,
          imageUrl: ogImage ? this._resolveUrl(ogImage) : undefined,
          publishedAt: null,
          meta: { icon: this.icon },
        });
      }
    }

    return articles;
  }

  _parseBlock(block, ogImage = null) {
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>/);
    const titleMatch = block.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)
      || block.match(/<a[^>]*>([^<]{10,})<\/a>/);
    const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const dateMatch = block.match(/<time[^>]*datetime="([^"]*)"/);
    const imgMatch = block.match(/<img[^>]*src="([^"]*)"/i);

    if (!linkMatch || !titleMatch) return null;

    const url = this._resolveUrl(linkMatch[1]);
    const imageUrl = imgMatch ? this._resolveUrl(imgMatch[1]) : ogImage ? this._resolveUrl(ogImage) : undefined;
    return {
      id: url,
      title: cleanHTML(titleMatch[1]),
      url,
      content: descMatch ? cleanHTML(descMatch[1]).substring(0, 500) : '',
      source: this.name,
      category: this._config.category,
      imageUrl,
      publishedAt: dateMatch ? new Date(dateMatch[1]) : null,
      meta: { icon: this.icon },
    };
  }

  _resolveUrl(url) {
    if (url.startsWith('http')) return url;
    try { return new URL(url, this._config.url).href; } catch { return url; }
  }
}

function validateHTMLDocument(html) {
  if (typeof html !== 'string' || !html.trim()) throw invalidSourceShape();

  const hasDocument = /<html(?:\s|>)/i.test(html) && /<\/html\s*>/i.test(html);
  const hasArticleFragment = /<article(?:\s|>)[\s\S]*<\/article\s*>/i.test(html);
  if (!hasDocument && !hasArticleFragment) throw invalidSourceShape();
}

function hasRecognizableArticleMarkup(html) {
  return /<article(?:\s|>)/i.test(html)
    || /<a[^>]*href="[^"]*(?:blog|post|article|engineering)[^"]*"/i.test(html);
}
