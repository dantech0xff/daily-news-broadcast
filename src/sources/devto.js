/**
 * Source Plugin: Dev.to
 * Uses public API (no auth needed)
 */

import { SourcePlugin } from '../core/contracts.js';
import {
  SOURCE_FETCH_DIAGNOSTIC_CAPABILITY,
  discardSourceResponse,
  fetchSourceWithDiagnostics,
  httpSourceFailure,
  invalidSourceShape,
  readLastFetchDiagnostic,
  readSourceJson,
  runDiagnosedFetch,
  validateArticleArray,
} from './source-result.js';

export class DevToSource extends SourcePlugin {
  /**
   * @param {Object} [config]
   * @param {string} [config.tag]          - Filter by tag (e.g. 'javascript', 'devops')
   * @param {number} [config.minReactions=20]
   */
  constructor(config = {}) {
    super();
    this._config = { minReactions: 20, ...config };
  }

  get id() { return `devto${this._config.tag ? `:${this._config.tag}` : ''}`; }
  get name() { return 'Dev.to'; }
  get sourceKey() {
    return JSON.stringify(['devto', this._config.tag ?? '', this._config.minReactions]);
  }
  get icon() { return '🖤'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 10 } = options;
      const { tag, minReactions } = this._config;

      let url = `https://dev.to/api/articles?per_page=${limit * 2}`;
      if (tag) url += `&tag=${encodeURIComponent(tag)}`;

      const response = await fetch(url, { signal: options.signal });
      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const posts = await readSourceJson(response);
      validateDevToPayload(posts);
      return posts
        .filter(p => p.public_reactions_count >= minReactions)
        .slice(0, limit)
        .map(p => ({
          id: `devto:${p.id}`,
          title: p.title,
          url: p.url,
          content: p.description || '',
          source: this.name,
          category: extractDevToTags(p) || 'Dev Community',
          author: p.user?.name,
          imageUrl: p.cover_image || undefined,
          publishedAt: p.published_at ? new Date(p.published_at) : null,
          meta: {
            icon: this.icon,
            reactions: p.public_reactions_count,
            comments: p.comments_count,
            readingTime: p.reading_time_minutes,
          },
        }));
    });
  }
}

/**
 * Source Plugin: Generic JSON API
 * Cho bất kỳ API nào trả về JSON list
 */

export class JSONAPISource extends SourcePlugin {
  /**
   * @param {Object} config
   * @param {string} config.id
   * @param {string} config.name
   * @param {string} config.url             - API endpoint
   * @param {Object} [config.headers]       - Extra headers (auth, etc.)
   * @param {string} [config.icon]
   * @param {string} [config.category]
   * @param {Function} config.transform     - (apiResponse) => Article[]
   */
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return this._config.id; }
  get name() { return this._config.name; }
  get sourceKey() {
    return JSON.stringify([
      'json-api', this.id, this.name, this._config.url,
      this._config.category ?? '',
      Object.keys(this._config.headers ?? {}).map(key => key.toLowerCase()).sort(),
      String(this._config.transform ?? ''),
    ]);
  }
  get icon() { return this._config.icon || '🔌'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 10 } = options;

      const response = await fetch(this._config.url, {
        signal: options.signal,
        headers: { 'User-Agent': 'NewsEngine/2.0', ...this._config.headers },
      });
      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const data = await readSourceJson(response);
      if (typeof this._config.transform !== 'function') throw invalidSourceShape();

      let articles;
      try {
        articles = this._config.transform(data);
      } catch {
        throw invalidSourceShape();
      }
      if (!Array.isArray(articles)) throw invalidSourceShape();
      validateArticleArray(articles);
      return articles.slice(0, limit);
    });
  }
}

function validateDevToPayload(posts) {
  if (!Array.isArray(posts)) throw invalidSourceShape();

  for (const post of posts) {
    if (!isRecord(post)) throw invalidSourceShape();
    if (!isValidSourceId(post.id)) throw invalidSourceShape();
    if (typeof post.title !== 'string' || !post.title.trim()) throw invalidSourceShape();
    if (typeof post.url !== 'string' || !post.url.trim()) throw invalidSourceShape();
    if (!Number.isFinite(post.public_reactions_count)) throw invalidSourceShape();
    if (post.description !== undefined && post.description !== null && typeof post.description !== 'string') {
      throw invalidSourceShape();
    }
    if (post.user !== undefined && post.user !== null && !isRecord(post.user)) {
      throw invalidSourceShape();
    }
    if (post.user?.name !== undefined && typeof post.user.name !== 'string') {
      throw invalidSourceShape();
    }
    if (post.cover_image !== undefined && post.cover_image !== null && typeof post.cover_image !== 'string') {
      throw invalidSourceShape();
    }
    if (post.published_at !== undefined && post.published_at !== null && typeof post.published_at !== 'string') {
      throw invalidSourceShape();
    }
    if (typeof post.published_at === 'string' && Number.isNaN(new Date(post.published_at).getTime())) {
      throw invalidSourceShape();
    }
  }
}

function isValidSourceId(value) {
  return (typeof value === 'string' && Boolean(value.trim()))
    || (typeof value === 'number' && Number.isFinite(value));
}

function extractDevToTags(post) {
  if (Array.isArray(post.tag_list)) return post.tag_list.join(', ');
  if (Array.isArray(post.tags)) return post.tags.join(', ');
  return typeof post.tags === 'string' ? post.tags : '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
