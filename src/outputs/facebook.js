/**
 * Output Plugin: Facebook Page
 * Uses Graph API to post to a Facebook Page.
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
  readResponseBody,
  successResult,
} from './telegram-client.js';

const GRAPH_API = 'https://graph.facebook.com/v22.0';

export class FacebookOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.pageToken - Page Access Token
   * @param {string} config.pageId - Facebook Page ID
   */
  constructor(config, dependencies = {}) {
    super();
    this._pageToken = config.pageToken;
    this._pageId = config.pageId;
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey('facebook', config.pageId, config.deliveryKey);
  }

  get id() { return 'facebook'; }
  get name() { return 'Facebook'; }
  get maxLength() { return 63206; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    if (!this._pageToken || !this._pageId) {
      return failureResult({
        deliveryState: 'definitive_failure',
        retryDisposition: 'manual',
        error: 'Facebook destination credentials are unavailable',
        providerCode: 'credentials_unavailable',
        now: this._dependencies.now,
      });
    }

    const url = extractUrl(content);
    const message = url ? stripUrl(content, url) : content;
    const params = new URLSearchParams({ message });
    if (url) params.set('link', url);

    try {
      const response = await fetchWithTimeout(
        this._dependencies.fetchImpl,
        `${GRAPH_API}/${this._pageId}/feed`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${this._pageToken}`,
          },
          body: params.toString(),
          signal: options.signal,
        },
        this._dependencies,
      );
      const parsed = await readResponseBody(response);
      const data = parsed.data;

      if (response.ok) {
        const messageId = normalizeMessageId(data?.id);
        return messageId
          ? successResult(messageId, { hasLink: Boolean(url) })
          : invalidResponseResult('Facebook', {
            now: this._dependencies.now,
            meta: { hasLink: Boolean(url) },
          });
      }

      return httpFailureResult({
        status: response.status,
        headers: response.headers,
        error: data?.error?.message || parsed.readError || parsed.text,
        providerCode: data?.error?.code || data?.error?.error_subcode || response.status,
        now: this._dependencies.now,
        meta: { hasLink: Boolean(url) },
      });
    } catch (error) {
      return exceptionFailureResult(error, {
        now: this._dependencies.now,
        meta: { hasLink: Boolean(url) },
      });
    }
  }
}

function extractUrl(content) {
  const match = content.match(/https?:\/\/[^\s)>\]]+/);
  return match ? match[0].replace(/[.,;:!?'\"]+$/, '') : null;
}

function stripUrl(content, url) {
  return content.replace(url, '').replace(/\n{3,}/g, '\n\n').trim();
}
