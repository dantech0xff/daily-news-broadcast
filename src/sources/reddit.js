/**
 * Source Plugin: Reddit
 * Uses public JSON API (no auth needed for read-only)
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
} from './source-result.js';

export class RedditSource extends SourcePlugin {
  /**
   * @param {Object} config
   * @param {string}   config.subreddit    - e.g. 'programming', 'devops'
   * @param {string}   [config.sort='hot'] - 'hot' | 'new' | 'top' | 'rising'
   * @param {number}   [config.minUpvotes=100]
   */
  constructor(config) {
    super();
    this._config = { sort: 'hot', minUpvotes: 100, ...config };
  }

  get id() { return `reddit:${this._config.subreddit}`; }
  get name() { return `r/${this._config.subreddit}`; }
  get sourceKey() {
    return JSON.stringify([
      'reddit', this._config.subreddit, this._config.sort, this._config.minUpvotes,
    ]);
  }
  get icon() { return '🔴'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 10, since } = options;
      const { subreddit, sort, minUpvotes } = this._config;
      const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit * 3}&raw_json=1`;
      const headers = { 'User-Agent': 'ContentRadar/2.0 (tech content radar)' };

      let response = await fetch(url, { headers, signal: options.signal });

      // Handle rate limiting — wait and retry once
      if (response.status === 429) {
        const retryAfter = Math.min(parseInt(response.headers.get('retry-after') || '5', 10), 30);
        await discardSourceResponse(response);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        response = await fetch(url, { headers, signal: options.signal });
      }

      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const data = await readSourceJson(response);
      validateRedditPayload(data);
      return data.data.children
        .map(child => child.data)
        .filter(post => !post.stickied && post.ups >= minUpvotes)
        .filter(post => {
          if (!since) return true;
          return new Date(post.created_utc * 1000) > since;
        })
        .slice(0, limit)
        .map(post => ({
          id: `reddit:${post.id}`,
          title: post.title,
          url: post.url.startsWith('https://www.reddit.com')
            ? `https://www.reddit.com${post.permalink}`
            : post.url,
          content: (post.selftext || '').substring(0, 500) || `${post.ups} upvotes, ${post.num_comments} comments`,
          source: this.name,
          category: 'Community',
          imageUrl: extractRedditImage(post),
          publishedAt: new Date(post.created_utc * 1000),
          meta: {
            icon: this.icon,
            upvotes: post.ups,
            comments: post.num_comments,
            redditUrl: `https://www.reddit.com${post.permalink}`,
          },
        }));
    });
  }
}

function validateRedditPayload(data) {
  if (!isRecord(data) || !isRecord(data.data) || !Array.isArray(data.data.children)) {
    throw invalidSourceShape();
  }

  for (const child of data.data.children) {
    const post = child?.data;
    if (!isRecord(child) || !isRecord(post)) throw invalidSourceShape();
    if (typeof post.id !== 'string' || !post.id.trim()) throw invalidSourceShape();
    if (typeof post.title !== 'string' || !post.title.trim()) throw invalidSourceShape();
    if (typeof post.url !== 'string' || !post.url.trim()) throw invalidSourceShape();
    if (typeof post.permalink !== 'string' || !post.permalink.trim()) throw invalidSourceShape();
    if (!Number.isFinite(post.ups)) throw invalidSourceShape();
    if (!Number.isFinite(post.num_comments)) throw invalidSourceShape();
    if (!Number.isFinite(post.created_utc)) throw invalidSourceShape();
    if (Number.isNaN(new Date(post.created_utc * 1000).getTime())) throw invalidSourceShape();
    if (post.stickied !== undefined && typeof post.stickied !== 'boolean') throw invalidSourceShape();
    if (post.selftext !== undefined && post.selftext !== null && typeof post.selftext !== 'string') {
      throw invalidSourceShape();
    }
    if (post.thumbnail !== undefined && post.thumbnail !== null && typeof post.thumbnail !== 'string') {
      throw invalidSourceShape();
    }
    validateRedditPreview(post.preview);
  }
}

function validateRedditPreview(preview) {
  if (preview === undefined || preview === null) return;
  if (!isRecord(preview) || !Array.isArray(preview.images)) throw invalidSourceShape();

  for (const image of preview.images) {
    if (!isRecord(image)) throw invalidSourceShape();
    if (image.source === undefined || image.source === null) continue;
    if (!isRecord(image.source)) throw invalidSourceShape();
    if (image.source.url !== undefined && typeof image.source.url !== 'string') {
      throw invalidSourceShape();
    }
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractRedditImage(post) {
  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview) return preview.replace(/&amp;/g, '&');

  if (post.thumbnail && post.thumbnail.startsWith('http')) return post.thumbnail;

  return undefined;
}
