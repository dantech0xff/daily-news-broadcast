/**
 * Output Plugin: X (Twitter)
 * Uses OAuth 2.0 Bearer token (stored in KVTokenStore or direct)
 * Supports single tweet and threaded tweets (1/n, 2/n pattern)
 */

import { OutputPlugin } from '../core/contracts.js';
import {
  createOutputDependencies,
  destinationDeliveryKey,
  exceptionFailureResult,
  failureResult,
  fetchWithTimeout,
  httpFailureResult,
  invalidResponseResult,
  normalizeMessageId,
  partResult,
  readResponseBody,
  successResult,
  withPartialMutation,
} from './telegram-client.js';

const X_API = 'https://api.x.com/2/tweets';
const MAX_TWEET = 280;
const MAX_TWEETS_PER_THREAD = 10;

export class XOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} [config.accessToken] - OAuth 2.0 Bearer token (direct)
   * @param {Object} [config.kvTokenStore] - KVTokenStore instance for encrypted token
   * @param {string} [config.channelId] - Stable channel/account identifier
   * @param {string} config.destinationId - Stable non-secret authenticated account identifier
   */
  constructor(config, dependencies = {}) {
    super();
    const destinationId = String(config.destinationId ?? '').trim();
    if (!destinationId) {
      throw new Error('X destinationId is required to bind delivery state to an authenticated account');
    }
    this._accessToken = config.accessToken;
    this._kvStore = config.kvTokenStore;
    this._channelId = config.channelId;
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey(
      'x',
      destinationId,
      config.deliveryKey,
    );
  }

  get id() { return 'x'; }
  get name() { return 'X (Twitter)'; }
  get maxLength() { return MAX_TWEET * MAX_TWEETS_PER_THREAD; }
  get deliveryKey() { return this._deliveryKey; }

  async _getToken() {
    if (this._accessToken) return this._accessToken;
    if (this._kvStore && this._channelId) {
      const token = await this._kvStore.getToken(this._channelId);
      if (!token) throw new Error('X token unavailable');
      return token;
    }
    throw new Error('X token unavailable');
  }

  static async refreshToken(kvStore, channelId, refreshToken, clientId, dependencies = {}) {
    const deps = createOutputDependencies({}, dependencies);
    const response = await fetchWithTimeout(deps.fetchImpl, 'https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    }, deps);
    const parsed = await readResponseBody(response);
    const data = parsed.data;
    if (!response.ok || !parsed.validJson || !data?.access_token) {
      throw new Error(`X token refresh failed (${response.status || 'invalid response'})`);
    }

    await kvStore.setToken(channelId, data.access_token, data.expires_in * 1000);
    if (data.refresh_token) {
      await kvStore.setToken(`${channelId}:refresh`, data.refresh_token, 180 * 24 * 3600 * 1000);
    }
    return data;
  }

  async send(content, options = {}) {
    let token;
    try {
      token = await this._getToken();
    } catch {
      return failureResult({
        deliveryState: 'definitive_failure',
        retryDisposition: 'manual',
        error: 'X credentials are unavailable',
        providerCode: 'credentials_unavailable',
        now: this._dependencies.now,
      });
    }

    const tweets = splitIntoTweets(content);
    if (tweets.length === 0) {
      return failureResult({
        deliveryState: 'definitive_failure',
        retryDisposition: 'never',
        error: 'X content is empty',
        providerCode: 'invalid_content',
        now: this._dependencies.now,
      });
    }

    const successfulMessageIds = [];
    const partResults = [];
    let replyToId;

    for (let i = 0; i < tweets.length; i++) {
      const body = { text: tweets[i] };
      if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
      const result = await this._sendTweet(body, token, options.signal);
      partResults.push(partResult(i + 1, result, 'tweet'));

      if (!result.success) {
        const metadata = {
          ...result.meta,
          tweetCount: tweets.length,
          partsAttempted: partResults.length,
          partsTotal: tweets.length,
          failedAt: i + 1,
          partResults,
        };
        if (successfulMessageIds.length > 0) {
          return withPartialMutation({ ...result, meta: metadata }, {
            successfulMessageIds,
            completedSteps: successfulMessageIds.length,
            totalSteps: tweets.length,
            failedStep: i + 1,
            partResults,
          });
        }
        return { ...result, meta: metadata };
      }

      if (result.messageId) {
        successfulMessageIds.push(result.messageId);
        replyToId = result.messageId;
      }
      if (i < tweets.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      tweetCount: tweets.length,
      partsAttempted: tweets.length,
      partsTotal: tweets.length,
      successfulMessageIds,
      partResults,
    });
  }

  async _sendTweet(body, token, signal) {
    try {
      const response = await fetchWithTimeout(this._dependencies.fetchImpl, X_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal,
      }, this._dependencies);
      const parsed = await readResponseBody(response);
      const data = parsed.data;

      if (response.ok) {
        const messageId = normalizeMessageId(data?.data?.id);
        return messageId
          ? successResult(messageId)
          : invalidResponseResult('X', { now: this._dependencies.now });
      }

      const duplicate = response.status === 403 && /duplicate/i.test(String(data?.detail || ''));
      if (duplicate) {
        return failureResult({
          deliveryState: 'definitive_failure',
          retryDisposition: 'never',
          error: 'X rejected a duplicate post',
          providerCode: 'duplicate',
          now: this._dependencies.now,
          meta: { duplicate: true },
        });
      }

      return httpFailureResult({
        status: response.status,
        headers: response.headers,
        error: data?.detail || data?.title || parsed.readError || parsed.text,
        providerCode: data?.errors?.[0]?.code || response.status,
        now: this._dependencies.now,
      });
    } catch (error) {
      return exceptionFailureResult(error, { now: this._dependencies.now });
    }
  }
}

function splitIntoTweets(content) {
  const segments = content.split(/\n\n+/).filter(segment => segment.trim());
  const hasThreadFormat = segments.length > 1
    && segments.some(segment => /^\d+\/\d+/.test(segment.trim()));

  if (hasThreadFormat) {
    return segments
      .filter(segment => /^\d+\/\d+/.test(segment.trim()))
      .slice(0, MAX_TWEETS_PER_THREAD)
      .map(tweet => tweet.trim())
      .map(tweet => tweet.length > MAX_TWEET ? `${tweet.substring(0, MAX_TWEET - 1)}…` : tweet);
  }

  const truncated = content.length > MAX_TWEET
    ? `${content.substring(0, MAX_TWEET - 1)}…`
    : content;
  return [truncated.trim()].filter(tweet => tweet.length > 0);
}
