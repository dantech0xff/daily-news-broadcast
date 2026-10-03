/**
 * Plugin factories the E2E harness injects through `startServer({ channelFactories })`.
 * The app builds every channel with them, so nothing reaches a real source,
 * AI provider, or Telegram:
 * - every channel fetches the fixture articles from one fixture source;
 * - the AI answers with deterministic Vietnamese text (`fakeSummaryText`) that
 *   names the configured provider/model and whether a custom system prompt
 *   reached it;
 * - the Telegram output returns incrementing message ids and appends every
 *   send to a JSONL file, the specs' proof of what was (not) sent.
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { AIPlugin, OutputPlugin, SourcePlugin } from '../../../src/core/contracts.js';
import { destinationDeliveryKey, successResult } from '../../../src/outputs/telegram-client.js';
import { FAKE_AI_USAGE, FIRST_MESSAGE_ID, FIXTURE_SOURCE, fakeSummaryText } from './constants.js';

export class FixtureSource extends SourcePlugin {
  /** @param {object[]} articles Fixture articles (`buildFixture().articles`). */
  constructor(articles) {
    super();
    this._articles = articles.map(({ key: _key, ...article }) => article);
  }

  get id() { return FIXTURE_SOURCE.id; }
  get name() { return FIXTURE_SOURCE.name; }

  async fetch({ limit } = {}) {
    const articles = structuredClone(this._articles);
    return Number.isSafeInteger(limit) && limit > 0 ? articles.slice(0, limit) : articles;
  }

  async fetchWithDiagnostics(options = {}) {
    const articles = await this.fetch(options);
    return { articles, diagnostic: { status: articles.length > 0 ? 'success' : 'empty', articleCount: articles.length } };
  }
}

export class FakeAI extends AIPlugin {
  /** @param {{ provider: string, model?: string }} config What `createAI()` would receive. */
  constructor({ provider, model }) {
    super();
    this._provider = provider;
    this._model = model ?? null;
  }

  get id() { return `e2e-${this._provider}`; }
  get name() { return `E2E fake AI (${this._provider})`; }

  async summarize(articles, options = {}) {
    const customSystemPrompt = typeof options.customSystemPrompt === 'string' && options.customSystemPrompt.trim() !== '';
    return {
      text: fakeSummaryText({
        provider: this._provider,
        model: this._model,
        titles: articles.map(article => article.title),
        customSystemPrompt,
      }),
      usage: { ...FAKE_AI_USAGE },
      model: this._model ?? 'e2e-default-model',
    };
  }
}

export class FakeTelegramOutput extends OutputPlugin {
  /**
   * @param {{ botToken: string, chatId: string }} config Resolved credential values.
   * @param {{ sentFile: string, nextMessageId: () => number }} recorder
   */
  constructor({ botToken, chatId }, { sentFile, nextMessageId }) {
    super();
    this._chatId = chatId;
    // A fingerprint is enough to prove which bot token was resolved; the value is not written anywhere.
    this._botTokenFingerprint = createHash('sha256').update(String(botToken)).digest('hex').slice(0, 16);
    this._deliveryKey = destinationDeliveryKey('telegram', chatId);
    this._sentFile = sentFile;
    this._nextMessageId = nextMessageId;
  }

  get id() { return 'telegram'; }
  get name() { return 'Telegram (E2E fake)'; }
  get maxLength() { return 4096; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    const messageId = String(this._nextMessageId());
    appendFileSync(this._sentFile, `${JSON.stringify({
      messageId,
      chatId: this._chatId,
      botTokenSha256: this._botTokenFingerprint,
      articleTitle: options.article?.title ?? null,
      deliveryId: options.deliveryId ?? null,
      content,
      sentAt: new Date().toISOString(),
    })}\n`);
    return successResult(messageId, { successfulMessageIds: [messageId] });
  }
}

/**
 * @param {{ articles: object[], sentFile: string }} options
 * @returns {{ createSources: Function, createAI: Function, createOutput: Function }}
 */
export function createE2eChannelFactories({ articles, sentFile }) {
  let lastMessageId = FIRST_MESSAGE_ID - 1;
  const nextMessageId = () => {
    lastMessageId += 1;
    return lastMessageId;
  };
  return Object.freeze({
    createSources: () => [new FixtureSource(articles)],
    createAI: config => new FakeAI(config),
    createOutput: config => new FakeTelegramOutput(config, { sentFile, nextMessageId }),
  });
}

/**
 * node-cron stand-in that registers schedules but never fires them: E2E runs
 * start only from "Chạy ngay", so a wall-clock tick can never add a run or a
 * send in the middle of a spec.
 */
export const INERT_CRON = Object.freeze({
  schedule: () => ({ stop() {}, destroy() {} }),
});
