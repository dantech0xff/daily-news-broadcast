/**
 * Output Plugin: Threads (Meta)
 * Two-step flow: create container -> publish.
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

const THREADS_API = 'https://graph.threads.net/v1.0';

export class ThreadsOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} [config.accessToken] - Direct access token
   * @param {string} config.userId - Threads user ID
   * @param {Object} [config.kvTokenStore] - KVTokenStore for encrypted token
   * @param {string} [config.channelId] - Channel ID for KV lookup
   */
  constructor(config, dependencies = {}) {
    super();
    this._accessToken = config.accessToken;
    this._userId = config.userId;
    this._kvStore = config.kvTokenStore;
    this._channelId = config.channelId;
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey(
      'threads',
      config.userId,
      config.deliveryKey,
    );
  }

  get id() { return 'threads'; }
  get name() { return 'Threads'; }
  get maxLength() { return 500; }
  get deliveryKey() { return this._deliveryKey; }

  async _getToken() {
    if (this._accessToken) return this._accessToken;
    if (this._kvStore && this._channelId) {
      const token = await this._kvStore.getToken(this._channelId);
      if (!token) throw new Error('Threads token unavailable');
      return token;
    }
    throw new Error('Threads token unavailable');
  }

  async send(content, options = {}) {
    let token;
    try {
      token = await this._getToken();
    } catch {
      return failureResult({
        deliveryState: 'definitive_failure',
        retryDisposition: 'manual',
        error: 'Threads credentials are unavailable',
        providerCode: 'credentials_unavailable',
        now: this._dependencies.now,
      });
    }

    const text = content.length > this.maxLength
      ? `${content.substring(0, this.maxLength - 3)}...`
      : content;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${token}`,
    };
    const createResult = await this._request(`${THREADS_API}/${this._userId}/threads`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ media_type: 'TEXT', text }).toString(),
      signal: options.signal,
    });
    const partResults = [partResult(1, createResult, 'create')];

    if (!createResult.success) {
      return {
        ...createResult,
        meta: {
          ...createResult.meta,
          partsAttempted: 1,
          partsTotal: 2,
          failedAt: 1,
          partResults,
        },
      };
    }

    const publishResult = await this._request(`${THREADS_API}/${this._userId}/threads_publish`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ creation_id: createResult.messageId }).toString(),
      signal: options.signal,
    });
    partResults.push(partResult(2, publishResult, 'publish'));

    if (!publishResult.success) {
      return withPartialMutation(publishResult, {
        successfulMessageIds: [createResult.messageId],
        completedSteps: 1,
        totalSteps: 2,
        failedStep: 2,
        partResults,
      });
    }

    return successResult(publishResult.messageId, {
      successfulMessageIds: [createResult.messageId, publishResult.messageId],
      partsAttempted: 2,
      partsTotal: 2,
      partResults,
    });
  }

  async _request(url, init) {
    try {
      const response = await fetchWithTimeout(
        this._dependencies.fetchImpl,
        url,
        init,
        this._dependencies,
      );
      const parsed = await readResponseBody(response);
      const data = parsed.data;

      if (response.ok) {
        const messageId = normalizeMessageId(data?.id);
        return messageId
          ? successResult(messageId)
          : invalidResponseResult('Threads', { now: this._dependencies.now });
      }

      return httpFailureResult({
        status: response.status,
        headers: response.headers,
        error: data?.error?.message || parsed.readError || parsed.text,
        providerCode: data?.error?.code || data?.error?.error_subcode || response.status,
        now: this._dependencies.now,
      });
    } catch (error) {
      return exceptionFailureResult(error, { now: this._dependencies.now });
    }
  }

  static async refreshToken(kvStore, channelId, dependencies = {}) {
    const currentToken = await kvStore.getToken(channelId);
    if (!currentToken) throw new Error('Threads token unavailable');
    const deps = createOutputDependencies({}, dependencies);
    const response = await fetchWithTimeout(
      deps.fetchImpl,
      `${THREADS_API}/refresh_access_token?${new URLSearchParams({
        grant_type: 'th_refresh_token',
        access_token: currentToken,
      })}`,
      {},
      deps,
    );
    const parsed = await readResponseBody(response);
    const data = parsed.data;

    if (!response.ok || !parsed.validJson || !data?.access_token) {
      throw new Error(`Threads token refresh failed (${response.status || 'invalid response'})`);
    }

    await kvStore.setToken(channelId, data.access_token, data.expires_in * 1000);
    return data;
  }
}
