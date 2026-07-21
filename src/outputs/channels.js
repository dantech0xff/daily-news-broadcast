/**
 * Output plugins for webhook, email, and local-file channels.
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

export class SlackOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.webhookUrl - Slack Incoming Webhook URL
   * @param {string} [config.channel] - Override channel
   * @param {string} [config.username='Tech News Bot']
   * @param {string} [config.iconEmoji=':newspaper:']
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = {
      username: 'Tech News Bot',
      iconEmoji: ':newspaper:',
      ...config,
    };
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey(
      'slack',
      [config.webhookUrl, config.channel],
      config.deliveryKey,
    );
  }

  get id() { return 'slack'; }
  get name() { return 'Slack'; }
  get maxLength() { return 40000; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    const body = {
      text: content,
      username: this._config.username,
      icon_emoji: this._config.iconEmoji,
    };
    if (this._config.channel) body.channel = this._config.channel;

    return sendHttpMutation(this._dependencies, this._config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    }, { provider: 'Slack' });
  }
}

export class DiscordOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.webhookUrl - Discord Webhook URL
   * @param {string} [config.username='Tech News Bot']
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = { username: 'Tech News Bot', ...config };
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey('discord', config.webhookUrl, config.deliveryKey);
  }

  get id() { return 'discord'; }
  get name() { return 'Discord'; }
  get maxLength() { return 2000; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    const parts = splitByLength(content, this.maxLength);
    const successfulMessageIds = [];
    const partResults = [];
    let successfulSteps = 0;

    for (let i = 0; i < parts.length; i++) {
      const result = await sendHttpMutation(this._dependencies, this._config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: parts[i],
          username: this._config.username,
        }),
        signal: options.signal,
      }, {
        provider: 'Discord',
        messageId: data => data?.id,
      });
      partResults.push(partResult(i + 1, result));

      if (!result.success) {
        const metadata = {
          ...result.meta,
          parts: parts.length,
          partsAttempted: partResults.length,
          partsTotal: parts.length,
          failedAt: i + 1,
          partResults,
        };
        if (successfulSteps > 0) {
          return withPartialMutation({ ...result, meta: metadata }, {
            successfulMessageIds,
            completedSteps: successfulSteps,
            totalSteps: parts.length,
            failedStep: i + 1,
            partResults,
            parts: parts.length,
          });
        }
        return { ...result, meta: metadata };
      }

      successfulSteps += 1;
      if (result.messageId) successfulMessageIds.push(result.messageId);
      if (i < parts.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      parts: parts.length,
      partsAttempted: parts.length,
      partsTotal: parts.length,
      successfulMessageIds,
      partResults,
    });
  }
}

export class WebhookOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.id - Unique ID
   * @param {string} config.name - Display name
   * @param {string} config.url - Webhook URL
   * @param {Object} [config.headers]
   * @param {Function} [config.formatBody] - (content, articles) => body object
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = config;
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey(
      config.id,
      [config.id, config.url],
      config.deliveryKey,
    );
  }

  get id() { return this._config.id; }
  get name() { return this._config.name; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    let body;
    try {
      body = this._config.formatBody
        ? this._config.formatBody(content, options.articles)
        : { text: content, timestamp: new Date(Number(this._dependencies.now())).toISOString() };
      body = JSON.stringify(body);
    } catch (error) {
      return failureResult({
        deliveryState: 'definitive_failure',
        retryDisposition: 'never',
        error,
        providerCode: 'invalid_payload',
        now: this._dependencies.now,
      });
    }

    return sendHttpMutation(this._dependencies, this._config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._config.headers,
      },
      body,
      signal: options.signal,
    }, { provider: this.name || 'Webhook' });
  }
}

export class EmailOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.provider - 'resend' | 'sendgrid'
   * @param {string} config.apiKey
   * @param {string} config.from - Sender email
   * @param {string|string[]} config.to - Recipient(s)
   * @param {string} [config.subject='🔥 Daily Tech Digest']
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = { subject: '🔥 Daily Tech Digest', ...config };
    this._dependencies = createOutputDependencies(config, dependencies);
    const recipients = [...new Set((Array.isArray(config.to) ? config.to : [config.to])
      .filter(Boolean)
      .map(value => String(value).trim().toLowerCase()))]
      .sort();
    this._deliveryKey = destinationDeliveryKey(
      'email',
      [config.provider, config.from, ...recipients],
      config.deliveryKey,
    );
  }

  get id() { return 'email'; }
  get name() { return `Email (${this._config.provider})`; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    const to = Array.isArray(this._config.to) ? this._config.to : [this._config.to];
    const htmlContent = markdownToBasicHTML(content);

    if (this._config.provider === 'resend') {
      return this._sendResend(to, htmlContent, options.signal);
    }
    if (this._config.provider === 'sendgrid') {
      return this._sendSendGrid(to, htmlContent, options.signal);
    }
    return failureResult({
      deliveryState: 'definitive_failure',
      retryDisposition: 'never',
      error: 'Unknown email provider',
      providerCode: 'unsupported_provider',
      now: this._dependencies.now,
    });
  }

  async _sendResend(to, html, signal) {
    return sendHttpMutation(this._dependencies, 'https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._config.apiKey}`,
      },
      body: JSON.stringify({
        from: this._config.from,
        to,
        subject: this._config.subject,
        html,
      }),
      signal,
    }, {
      provider: 'Resend',
      messageId: data => data?.id,
      requireMessageId: true,
    });
  }

  async _sendSendGrid(to, html, signal) {
    return sendHttpMutation(this._dependencies, 'https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._config.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: to.map(email => ({ email })) }],
        from: { email: this._config.from },
        subject: this._config.subject,
        content: [{ type: 'text/html', value: html }],
      }),
      signal,
    }, { provider: 'SendGrid' });
  }
}

export class MarkdownFileOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} [config.outputDir='./output']
   * @param {string} [config.filenamePattern='digest-{date}.md']
   */
  constructor(config = {}, dependencies = {}) {
    super();
    this._config = {
      outputDir: './output',
      filenamePattern: 'digest-{date}.md',
      ...config,
    };
    this._dependencies = createOutputDependencies(config, dependencies);
    this._deliveryKey = destinationDeliveryKey(
      'markdown-file',
      [this._config.outputDir, this._config.filenamePattern],
      config.deliveryKey,
    );
  }

  get id() { return 'markdown-file'; }
  get name() { return 'Markdown File'; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');

      await fs.mkdir(this._config.outputDir, { recursive: true });
      const date = new Date(Number(this._dependencies.now())).toISOString().split('T')[0];
      const filename = this._config.filenamePattern.replace('{date}', date);
      await fs.writeFile(path.join(this._config.outputDir, filename), content, 'utf-8');

      return successResult(undefined, { written: true });
    } catch (error) {
      return failureResult({
        deliveryState: 'ambiguous',
        retryDisposition: 'manual',
        error,
        providerCode: 'file_write_error',
        now: this._dependencies.now,
      });
    }
  }
}

async function sendHttpMutation(dependencies, url, init, {
  provider,
  messageId,
  requireMessageId = false,
} = {}) {
  try {
    const response = await fetchWithTimeout(dependencies.fetchImpl, url, init, dependencies);
    const parsed = await readResponseBody(response);

    if (response?.ok) {
      const resolvedMessageId = normalizeMessageId(messageId?.(parsed.data));
      if (requireMessageId && !resolvedMessageId) {
        return invalidResponseResult(provider, { now: dependencies.now });
      }
      return successResult(resolvedMessageId);
    }

    const data = parsed.data;
    return httpFailureResult({
      status: response?.status,
      headers: response?.headers,
      error: parsed.readError
        || data?.error?.message
        || data?.message
        || parsed.text
        || `${provider} HTTP ${response?.status}`,
      providerCode: data?.error?.code
        || data?.code
        || data?.statusCode
        || response?.status,
      now: dependencies.now,
    });
  } catch (error) {
    return exceptionFailureResult(error, { now: dependencies.now });
  }
}

function splitByLength(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      parts.push(remaining);
      break;
    }
    const newline = remaining.lastIndexOf('\n', max);
    const cut = newline > 0 ? newline : max;
    parts.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return parts;
}

function markdownToBasicHTML(markdown) {
  const normalized = String(markdown ?? '').replace(/\r\n?/g, '\n');
  return normalized
    .split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.split('\n').map(renderInlineMarkdown).join('<br>')}</p>`)
    .join('');
}

function renderInlineMarkdown(text) {
  let html = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        html += `<code>${escapeHTML(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (text[index] === '[') {
      const link = parseMarkdownLink(text, index);
      if (link) {
        html += link.html;
        index = link.end;
        continue;
      }
    }

    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) {
        html += `<strong>${escapeHTML(text.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    if (text[index] === '*') {
      const end = text.indexOf('*', index + 1);
      if (end > index + 1) {
        html += `<strong>${escapeHTML(text.slice(index + 1, end))}</strong>`;
        index = end + 1;
        continue;
      }
    }

    if (text[index] === '_') {
      const end = text.indexOf('_', index + 1);
      if (end > index + 1) {
        html += `<em>${escapeHTML(text.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
    }

    html += escapeHTML(text[index]);
    index += 1;
  }

  return html;
}

function parseMarkdownLink(text, start) {
  const labelEnd = text.indexOf('](', start + 1);
  if (labelEnd <= start + 1) return null;

  const hrefStart = labelEnd + 2;
  const hrefEnd = findLinkDestinationEnd(text, hrefStart);
  if (hrefEnd === -1) return null;

  const label = escapeHTML(text.slice(start + 1, labelEnd));
  const href = normalizeHttpUrl(text.slice(hrefStart, hrefEnd));
  return {
    html: href ? `<a href="${escapeHTML(href)}">${label}</a>` : label,
    end: hrefEnd + 1,
  };
}

function findLinkDestinationEnd(text, start) {
  let nestedParentheses = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\n') return -1;
    if (text[index] === '(') nestedParentheses += 1;
    if (text[index] !== ')') continue;
    if (nestedParentheses === 0) return index;
    nestedParentheses -= 1;
  }
  return -1;
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
