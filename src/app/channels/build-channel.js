/**
 * Turn a stored channel into the runtime channel object consumed by
 * `buildEngine()` and `runChannels()`: the same shape as `defineChannels()`
 * entries, plus `notBefore`. Credentials are resolved through the injected
 * resolver at build time and only ever handed to plugin constructors.
 */

import { createAI } from '../../ai/create-ai.js';
import { validateChannels } from '../../channels/definitions.js';
import { TelegramOutput } from '../../outputs/telegram.js';
import {
  ChannelValidationError,
  aiCredentialRequirements,
  listCredentialReferences,
  validateChannelConfig,
} from './config-schema.js';
import { createSourcePlugins } from './source-factories.js';

const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Plugin constructors used unless a caller injects replacements (tests, E2E). */
export const DEFAULT_CHANNEL_FACTORIES = Object.freeze({
  /** @param {import('./source-factories.js').SourceEntry[]} entries Enabled entries, in order. */
  createSources: entries => createSourcePlugins(entries),
  /** @param {Parameters<typeof createAI>[0]} config Includes resolved secrets. */
  createAI: config => createAI(config),
  /** @param {{ botToken: string, chatId: string }} config */
  createOutput: config => new TelegramOutput(config),
});

/**
 * A credential slot the channel needs is empty, or its credential could not
 * be loaded. Names config fields only, never values.
 */
export class ChannelCredentialError extends Error {
  /**
   * @param {string} channelId
   * @param {string[]} fields Credential slots, e.g. `telegram.botTokenCredentialId`.
   * @param {{ code?: 'missing_credential'|'credential_unavailable', cause?: unknown }} [options]
   */
  constructor(channelId, fields, { code = 'missing_credential', cause } = {}) {
    const reason = typeof cause?.code === 'string' && MACHINE_CODE.test(cause.code) ? ` (${cause.code})` : '';
    super(
      code === 'missing_credential'
        ? `Channel "${channelId}" is missing required credentials: ${fields.join(', ')}`
        : `Channel "${channelId}" could not load the credential for ${fields.join(', ')}${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ChannelCredentialError';
    this.code = code;
    this.channelId = channelId;
    this.fields = fields;
  }
}

/**
 * @typedef {object} RuntimeChannel
 * @property {string} id
 * @property {import('../../core/contracts.js').SourcePlugin[]} sources
 * @property {import('../../core/contracts.js').AIPlugin} ai
 * @property {import('../../core/contracts.js').OutputPlugin} output
 * @property {{ language: 'vi'|'en', style: string, audience: string, platform: 'telegram', customSystemPrompt?: string }} prompt
 * @property {'digest'|'drip'} mode
 * @property {string} schedule
 * @property {string} timezone
 * @property {number} batchSize
 * @property {number} delayMs
 * @property {number} dailyLimit
 * @property {number} maxArticles
 * @property {number} maxArticlesPerSource
 * @property {number} concurrency
 * @property {string|null} notBefore
 */

/**
 * @param {unknown} channel A channel record or config (re-validated here).
 * @param {{
 *   resolveCredential: (credentialId: string, slot: { field: string, kind: string }) => string|Promise<string>,
 *   factories?: Partial<typeof DEFAULT_CHANNEL_FACTORIES>,
 * }} options
 * @returns {Promise<RuntimeChannel>}
 * @throws {ChannelValidationError|ChannelCredentialError}
 */
export async function buildChannelFromConfig(channel, { resolveCredential, factories = {} } = {}) {
  if (typeof resolveCredential !== 'function') {
    throw new TypeError('buildChannelFromConfig requires a resolveCredential function');
  }
  const { createSources, createAI: makeAI, createOutput } = { ...DEFAULT_CHANNEL_FACTORIES, ...factories };
  const config = validateChannelConfig(channel);
  const sourceEntries = config.sources.filter(entry => entry.enabled);
  if (sourceEntries.length === 0) {
    throw new ChannelValidationError([{
      field: 'sources',
      code: 'no_enabled_sources',
      message: 'Cần ít nhất một nguồn đang bật.',
    }]);
  }

  const secrets = await resolveSecrets(config, resolveCredential);
  const { ai, prompt } = config;
  const runtimeChannel = {
    id: config.id,
    sources: createSources(sourceEntries),
    ai: makeAI({
      provider: ai.provider,
      model: ai.model ?? undefined,
      apiKey: secrets.get('ai.apiKeyCredentialId'),
      baseUrl: ai.baseUrl ?? undefined,
      name: ai.name ?? undefined,
      gateway: ai.gateway ? {
        token: secrets.get('ai.gateway.tokenCredentialId'),
        accountId: ai.gateway.accountId,
        gatewayId: ai.gateway.gatewayId,
        byokAlias: ai.gateway.byokAlias ?? undefined,
      } : undefined,
    }),
    output: createOutput({
      botToken: secrets.get('telegram.botTokenCredentialId'),
      chatId: secrets.get('telegram.chatIdCredentialId'),
    }),
    prompt: {
      language: prompt.language,
      style: prompt.style,
      audience: prompt.audience,
      platform: config.platform,
      ...(prompt.customSystemPrompt && { customSystemPrompt: prompt.customSystemPrompt }),
    },
    mode: config.mode,
    schedule: config.cron,
    timezone: config.timezone,
    batchSize: config.limits.batchSize,
    delayMs: config.limits.delayMs,
    dailyLimit: config.limits.dailyLimit,
    maxArticles: config.limits.maxArticles,
    maxArticlesPerSource: config.limits.maxArticlesPerSource,
    concurrency: config.limits.concurrency,
    notBefore: config.notBefore,
  };
  validateChannels([runtimeChannel]);
  return runtimeChannel;
}

async function resolveSecrets(config, resolveCredential) {
  const requirements = aiCredentialRequirements(config.ai);
  const required = ['telegram.botTokenCredentialId', 'telegram.chatIdCredentialId'];
  if (requirements.apiKey === 'required') required.push('ai.apiKeyCredentialId');
  if (requirements.gatewayToken) required.push('ai.gateway.tokenCredentialId');

  const references = listCredentialReferences(config);
  const missing = required.filter(field => !references.some(reference => reference.field === field));
  if (missing.length > 0) throw new ChannelCredentialError(config.id, missing);

  const secrets = new Map();
  for (const { field, kind, credentialId } of references) {
    let value;
    try {
      value = await resolveCredential(credentialId, { field, kind });
    } catch (error) {
      throw new ChannelCredentialError(config.id, [field], { code: 'credential_unavailable', cause: error });
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ChannelCredentialError(config.id, [field], { code: 'credential_unavailable' });
    }
    secrets.set(field, value);
  }
  return secrets;
}
