/**
 * Source Plugin: GitHub Trending Repos
 * Uses GitHub Search API (no auth required for public repos)
 * Finds recently active popular repos sorted by stars
 */

import { SourcePlugin } from '../core/contracts.js';
import { enrichMissingImages } from './og-image.js';
import {
  SOURCE_FETCH_DIAGNOSTIC_CAPABILITY,
  discardSourceResponse,
  fetchSourceWithDiagnostics,
  httpSourceFailure,
  invalidSourceShape,
  readLastFetchDiagnostic,
  readSourceJson,
  runDiagnosedFetch,
} from './source-result.js';

export class GitHubTrendingSource extends SourcePlugin {
  /**
   * @param {Object} [config]
   * @param {string} [config.language]       - Filter by programming language (e.g., 'javascript', 'rust')
   * @param {string} [config.since='daily']  - 'daily' | 'weekly'
   * @param {number} [config.minStars=50]    - Minimum star count
   * @param {string} [config.token]          - Optional GitHub token for higher rate limits
   */
  constructor(config = {}) {
    super();
    this._config = { since: 'daily', minStars: 50, ...config };
  }

  get id() { return `github-trending${this._config.language ? `:${this._config.language}` : ''}`; }
  get name() { return 'GitHub Trending'; }
  get sourceKey() {
    return JSON.stringify([
      'github-trending', this._config.language ?? '', this._config.since, this._config.minStars,
    ]);
  }
  get icon() { return '⭐'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 10 } = options;
      const { language, since, minStars, token } = this._config;

      // Use pushed:> to find recently active repos (closer to real "trending")
      const daysBack = since === 'weekly' ? 7 : 1;
      const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];

      let query = `pushed:>${dateFrom} stars:>=${minStars}`;
      if (language) query += ` language:${language}`;

      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`;

      const headers = {
        'User-Agent': 'NewsEngine/2.0',
        'Accept': 'application/vnd.github.v3+json',
      };
      if (token) headers['Authorization'] = `token ${token}`;

      const response = await fetch(url, { headers, signal: options.signal });
      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const data = await readSourceJson(response);
      validateGitHubPayload(data);
      const articles = data.items.slice(0, limit).map(repo => ({
        id: `github:${repo.full_name}`,
        title: `${repo.full_name} — ${repo.description || 'No description'}`,
        url: repo.html_url,
        content: [
          repo.description,
          `⭐ ${repo.stargazers_count} stars`,
          `Language: ${repo.language || 'N/A'}`,
          repo.topics?.length ? `Topics: ${repo.topics.slice(0, 5).join(', ')}` : '',
        ].filter(Boolean).join(' | '),
        source: this.name,
        category: 'Open Source',
        author: repo.owner?.login,
        publishedAt: new Date(repo.pushed_at),
        meta: {
          icon: this.icon,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language,
          topics: repo.topics,
        },
      }));

      await enrichMissingImages(articles, { signal: options.signal });
      return articles;
    });
  }
}

function validateGitHubPayload(data) {
  if (!isRecord(data) || !Array.isArray(data.items)) throw invalidSourceShape();

  for (const repo of data.items) {
    if (!isRecord(repo)) throw invalidSourceShape();
    if (typeof repo.full_name !== 'string' || !repo.full_name.trim()) throw invalidSourceShape();
    if (typeof repo.html_url !== 'string' || !repo.html_url.trim()) throw invalidSourceShape();
    if (!Number.isFinite(repo.stargazers_count)) throw invalidSourceShape();
    if (!Number.isFinite(repo.forks_count)) throw invalidSourceShape();
    if (typeof repo.pushed_at !== 'string' || !repo.pushed_at.trim()) throw invalidSourceShape();
    if (Number.isNaN(new Date(repo.pushed_at).getTime())) throw invalidSourceShape();
    if (repo.description !== undefined && repo.description !== null && typeof repo.description !== 'string') {
      throw invalidSourceShape();
    }
    if (repo.language !== undefined && repo.language !== null && typeof repo.language !== 'string') {
      throw invalidSourceShape();
    }
    if (repo.topics !== undefined && (!Array.isArray(repo.topics) || repo.topics.some(topic => typeof topic !== 'string'))) {
      throw invalidSourceShape();
    }
    if (repo.owner !== undefined && repo.owner !== null && !isRecord(repo.owner)) {
      throw invalidSourceShape();
    }
    if (repo.owner?.login !== undefined && typeof repo.owner.login !== 'string') {
      throw invalidSourceShape();
    }
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
