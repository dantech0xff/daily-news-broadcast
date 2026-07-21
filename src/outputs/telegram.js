/**
 * Output Plugin: Telegram
 */

import { OutputPlugin } from '../core/contracts.js';
import {
  createOutputDependencies,
  destinationDeliveryKey,
  exceptionFailureResult,
  fetchWithTimeout,
  httpFailureResult,
  invalidResponseResult,
  normalizeMessageId,
  partResult,
  readResponseBody,
  successResult,
  withPartialMutation,
} from './telegram-client.js';

const CAPTION_MAX = 1024;
const RICH_MEDIA_ID = 'article_image';

export class TelegramOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.botToken
   * @param {string} config.chatId
   * @param {boolean} [config.disablePreview=true]
   * @param {boolean} [config.silent=false]
   * @param {Function} [config.fetch] - Injectable fetch transport
   * @param {number} [config.timeoutMs=15000]
   * @param {Object} [dependencies] - Optional injected fetch/clock/timers
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = { disablePreview: true, silent: false, ...config };
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey('telegram', config.chatId, config.deliveryKey);
  }

  get id() { return 'telegram'; }
  get name() { return 'Telegram'; }
  get supportsSingleMutation() { return true; }
  get maxLength() { return 4096; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    if (options.singleMutation === true) {
      if (content.length > this.maxLength) {
        return {
          success: false,
          error: 'Single-mutation content exceeds Telegram message limit',
          meta: {
            deliveryState: 'definitive_failure',
            retryDisposition: 'never',
            providerCode: 'content_too_long',
            sanitizedError: 'Single-mutation content exceeds Telegram message limit',
          },
        };
      }
      return this._request('sendMessage', {
        chat_id: this._config.chatId,
        text: stripMarkdown(content),
        disable_web_page_preview: this._config.disablePreview,
        disable_notification: this._config.silent,
      }, options.signal);
    }
    const imageUrl = options.article?.imageUrl
      || options.articles?.[0]?.imageUrl
      || null;

    if (imageUrl) {
      return this._sendWithPhoto(content, imageUrl, options.signal);
    }

    return this._sendTextOnly(content, options.signal);
  }

  async _sendTextOnly(content, signal) {
    const messages = splitSmart(content, this.maxLength);
    const successfulMessageIds = [];
    const partResults = [];
    let fallbackAttempted = false;

    for (let i = 0; i < messages.length; i++) {
      const result = await this._sendOne(
        i > 0 ? `(${i + 1}/${messages.length})\n\n${messages[i]}` : messages[i],
        i > 0,
        signal,
      );
      fallbackAttempted ||= result.meta?.fallbackAttempted === true;
      partResults.push(partResult(i + 1, result));

      if (!result.success) {
        const metadata = {
          ...result.meta,
          parts: messages.length,
          partsAttempted: partResults.length,
          partsTotal: messages.length,
          failedAt: i + 1,
          partResults,
          ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
        };

        if (successfulMessageIds.length > 0) {
          return withPartialMutation({ ...result, meta: metadata }, {
            successfulMessageIds,
            completedSteps: successfulMessageIds.length,
            totalSteps: messages.length,
            failedStep: i + 1,
            partResults,
            parts: messages.length,
          });
        }

        return { ...result, meta: metadata };
      }

      if (result.messageId) successfulMessageIds.push(result.messageId);
      if (i < messages.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      parts: messages.length,
      partsAttempted: messages.length,
      partsTotal: messages.length,
      successfulMessageIds,
      partResults,
      ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
    });
  }

  async _sendWithPhoto(content, imageUrl, signal) {
    if (content.length <= CAPTION_MAX) {
      const result = await this._sendPhoto(imageUrl, content, signal);
      if (result.success) {
        return successResult(result.messageId, {
          ...result.meta,
          hasPhoto: true,
          successfulMessageIds: result.messageId ? [result.messageId] : [],
        });
      }

      if (!isDefinitiveContentRejection(result)) {
        return {
          ...result,
          meta: { ...result.meta, photoAttempted: true },
        };
      }

      const fallback = await this._sendTextOnly(content, signal);
      return {
        ...fallback,
        meta: {
          ...fallback.meta,
          fallbackAttempted: true,
          photoAttempted: true,
          hasPhoto: false,
        },
      };
    }

    const richResult = await this._sendRichPhoto(imageUrl, content, signal);
    if (richResult.success) {
      return successResult(richResult.messageId, {
        ...richResult.meta,
        parts: 1,
        partsAttempted: 1,
        partsTotal: 1,
        hasPhoto: true,
        richMessageAttempted: true,
        successfulMessageIds: richResult.messageId ? [richResult.messageId] : [],
        partResults: [partResult(1, richResult, 'rich_message')],
      });
    }

    if (!isDefinitiveContentRejection(richResult)) {
      return {
        ...richResult,
        meta: {
          ...richResult.meta,
          photoAttempted: true,
          richMessageAttempted: true,
        },
      };
    }

    const messages = splitSmart(content, this.maxLength);
    const totalSteps = messages.length + 1;
    const photoResult = await this._sendPhoto(imageUrl, null, signal);

    if (!photoResult.success) {
      if (isDefinitiveContentRejection(photoResult)) {
        const fallback = await this._sendTextOnly(content, signal);
        return {
          ...fallback,
          meta: {
            ...fallback.meta,
            fallbackAttempted: true,
            photoAttempted: true,
            richMessageAttempted: true,
            hasPhoto: false,
          },
        };
      }

      return {
        ...photoResult,
        meta: {
          ...photoResult.meta,
          parts: totalSteps,
          partsAttempted: 1,
          partsTotal: totalSteps,
          failedAt: 1,
          photoAttempted: true,
          richMessageAttempted: true,
          partResults: [partResult(1, photoResult, 'photo')],
        },
      };
    }

    const successfulMessageIds = photoResult.messageId ? [photoResult.messageId] : [];
    const partResults = [partResult(1, photoResult, 'photo')];
    let fallbackAttempted = true;
    await this._dependencies.sleep(300);

    for (let i = 0; i < messages.length; i++) {
      const result = await this._sendOne(
        i > 0 ? `(${i + 1}/${messages.length})\n\n${messages[i]}` : messages[i],
        i > 0,
        signal,
      );
      const step = i + 2;
      fallbackAttempted ||= result.meta?.fallbackAttempted === true;
      partResults.push(partResult(step, result));

      if (!result.success) {
        const partial = withPartialMutation(result, {
          successfulMessageIds,
          completedSteps: successfulMessageIds.length,
          totalSteps,
          failedStep: step,
          partResults,
          parts: totalSteps,
        });
        return {
          ...partial,
          meta: {
            ...partial.meta,
            hasPhoto: true,
            richMessageAttempted: true,
            ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
          },
        };
      }

      if (result.messageId) successfulMessageIds.push(result.messageId);
      if (i < messages.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      parts: totalSteps,
      partsAttempted: totalSteps,
      partsTotal: totalSteps,
      hasPhoto: true,
      richMessageAttempted: true,
      successfulMessageIds,
      partResults,
      ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
    });
  }

  async _sendRichPhoto(photoUrl, content, signal) {
    const body = {
      chat_id: this._config.chatId,
      rich_message: {
        markdown: `![](tg://photo?id=${RICH_MEDIA_ID})\n\n${toRichMarkdown(content)}`,
        media: [{
          id: RICH_MEDIA_ID,
          media: { type: 'photo', media: photoUrl },
        }],
      },
      disable_notification: this._config.silent,
    };

    const result = await this._request('sendRichMessage', body, signal);
    if (result.success || !isDefinitiveFormatRejection(result)) return result;

    body.rich_message = {
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: photoUrl } },
        { type: 'paragraph', text: stripMarkdown(content) },
      ],
    };
    const fallback = await this._request('sendRichMessage', body, signal);
    return {
      ...fallback,
      meta: { ...fallback.meta, fallbackAttempted: true },
    };
  }

  async _sendPhoto(photoUrl, caption, signal) {
    const body = {
      chat_id: this._config.chatId,
      photo: photoUrl,
      disable_notification: this._config.silent,
    };
    if (caption) {
      body.caption = caption;
      body.parse_mode = 'Markdown';
    }

    const result = await this._request('sendPhoto', body, signal);
    if (!caption || result.success || !isDefinitiveFormatRejection(result)) return result;

    body.caption = stripMarkdown(caption);
    delete body.parse_mode;
    const fallback = await this._request('sendPhoto', body, signal);
    return {
      ...fallback,
      meta: { ...fallback.meta, fallbackAttempted: true },
    };
  }

  async _sendOne(text, forceQuiet = false, signal) {
    const body = {
      chat_id: this._config.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: this._config.disablePreview,
      disable_notification: forceQuiet || this._config.silent,
    };
    const result = await this._request('sendMessage', body, signal);
    if (result.success || !isDefinitiveFormatRejection(result)) return result;
    return this._sendPlain(text, forceQuiet, signal);
  }

  async _sendPlain(text, forceQuiet, signal) {
    const result = await this._request('sendMessage', {
      chat_id: this._config.chatId,
      text: stripMarkdown(text),
      disable_web_page_preview: this._config.disablePreview,
      disable_notification: forceQuiet || this._config.silent,
    }, signal);
    return {
      ...result,
      meta: { ...result.meta, fallbackAttempted: true },
    };
  }

  async _request(method, body, signal) {
    const url = `https://api.telegram.org/bot${this._config.botToken}/${method}`;

    try {
      const response = await fetchWithTimeout(this._dependencies.fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }, this._dependencies);
      const parsed = await readResponseBody(response);
      const data = parsed.data;

      if (response?.ok && parsed.validJson && data?.ok === true) {
        const messageId = normalizeMessageId(data.result?.message_id);
        return messageId
          ? successResult(messageId)
          : invalidResponseResult('Telegram', { now: this._dependencies.now });
      }

      if (parsed.validJson && data?.ok === false) {
        const responseStatus = Number(response?.status);
        const providerStatus = Number(data.error_code);
        const status = responseStatus >= 400 ? responseStatus : providerStatus || responseStatus;
        const description = data.description || `Telegram rejected ${method}`;
        return httpFailureResult({
          status,
          headers: response?.headers,
          error: description,
          providerCode: data.error_code || status,
          retryAfterMs: Number.isFinite(Number(data.parameters?.retry_after))
            ? Number(data.parameters.retry_after) * 1000
            : undefined,
          now: this._dependencies.now,
          meta: isFormatRejection(description) ? { reasonCode: 'format_rejected' } : undefined,
        });
      }

      if (!response?.ok) {
        return httpFailureResult({
          status: response?.status,
          headers: response?.headers,
          error: parsed.readError || parsed.text || `Telegram HTTP ${response?.status}`,
          providerCode: response?.status,
          now: this._dependencies.now,
        });
      }

      return invalidResponseResult('Telegram', { now: this._dependencies.now });
    } catch (error) {
      return exceptionFailureResult(error, { now: this._dependencies.now });
    }
  }
}

function splitSmart(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      parts.push(remaining);
      break;
    }
    let cut = max;
    const separator = remaining.lastIndexOf('━━━', max);
    if (separator > max * 0.5) cut = separator;
    else {
      const newline = remaining.lastIndexOf('\n\n', max);
      if (newline > max * 0.5) cut = newline;
    }
    parts.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return parts;
}

function isDefinitiveFormatRejection(result) {
  return result.meta?.deliveryState === 'definitive_failure'
    && result.meta?.retryDisposition === 'never'
    && result.meta?.reasonCode === 'format_rejected';
}

function isDefinitiveContentRejection(result) {
  return result.meta?.deliveryState === 'definitive_failure'
    && result.meta?.retryDisposition === 'never';
}

function isFormatRejection(description) {
  return /parse|entit(?:y|ies)/i.test(String(description || ''));
}

function stripMarkdown(text) {
  return text
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function toRichMarkdown(text) {
  return text.replace(/(?<![\\*])\*([^*\n]+)\*(?!\*)/g, '**$1**');
}
