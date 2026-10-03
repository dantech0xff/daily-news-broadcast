/**
 * Channel configuration schema. `validateChannelConfig()` is the single
 * validation and normalization step for channel input from the API, records
 * read back from the database, and the seed, so every stored channel has one
 * fully populated shape.
 */

import { PROMPT_LANGUAGES, PROMPT_STYLES } from '../../ai/_prompts.js';
import { validateCronExpression } from '../../channels/runner.js';
import { normalizeSourceEntries } from './source-factories.js';
import {
  IssueCollector,
  ValidationError,
  readBoolean,
  readEnum,
  readHttpUrl,
  readInteger,
  readIsoInstant,
  readObject,
  readString,
} from './validation.js';

/** Kebab-case channel ids; they also namespace cache keys and delivery state. */
export const CHANNEL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CHANNEL_ID_MAX_LENGTH = 64;
/** The dashboard manages Telegram channels only. */
export const CHANNEL_PLATFORMS = Object.freeze(['telegram']);
export const CHANNEL_MODES = Object.freeze(['digest', 'drip']);
/** Canonical provider names accepted by `createAI()`. */
export const AI_PROVIDERS = Object.freeze([
  'claude', 'openai', 'groq', 'gemini', 'qwen', 'deepseek', 'ollama', 'openrouter', 'together', 'custom',
]);
/** Kinds of secrets the vault stores; each credential slot accepts exactly one kind. */
export const CREDENTIAL_KINDS = Object.freeze([
  'telegram_bot_token', 'telegram_chat_id', 'ai_api_key', 'ai_gateway_token',
]);
export const MAX_AUDIENCE_LENGTH = 300;
export const MAX_CUSTOM_SYSTEM_PROMPT_LENGTH = 8_000;

/** Inclusive `[min, max]` bounds of each channel limit. */
export const LIMIT_RANGES = Object.freeze({
  batchSize: Object.freeze([1, 100]),
  delayMs: Object.freeze([0, 3_600_000]),
  dailyLimit: Object.freeze([1, 500]),
  maxArticles: Object.freeze([1, 500]),
  maxArticlesPerSource: Object.freeze([1, 100]),
  concurrency: Object.freeze([1, 50]),
});

/**
 * Upper bound of `limits.batchSize × limits.delayMs` (10 minutes): roughly the
 * time one run may spend pausing between posts. Runs of every channel share
 * one queue, so a longer run would delay other channels' runs and keep a
 * shutdown waiting.
 */
export const MAX_BATCH_DELAY_MS = 600_000;

/** Limits applied when omitted; they mirror the env defaults of `defineChannels()`. */
export const DEFAULT_LIMITS = Object.freeze({
  batchSize: 5,
  delayMs: 0,
  dailyLimit: 18,
  maxArticles: 12,
  maxArticlesPerSource: 3,
  concurrency: 5,
});

const CREDENTIAL_SLOT_READERS = Object.freeze({
  'telegram.botTokenCredentialId': config => config?.telegram?.botTokenCredentialId,
  'telegram.chatIdCredentialId': config => config?.telegram?.chatIdCredentialId,
  'ai.apiKeyCredentialId': config => config?.ai?.apiKeyCredentialId,
  'ai.gateway.tokenCredentialId': config => config?.ai?.gateway?.tokenCredentialId,
});

/** Config fields that reference a stored credential, with the credential kind each needs. */
export const CREDENTIAL_SLOTS = Object.freeze([
  Object.freeze({ field: 'telegram.botTokenCredentialId', kind: 'telegram_bot_token' }),
  Object.freeze({ field: 'telegram.chatIdCredentialId', kind: 'telegram_chat_id' }),
  Object.freeze({ field: 'ai.apiKeyCredentialId', kind: 'ai_api_key' }),
  Object.freeze({ field: 'ai.gateway.tokenCredentialId', kind: 'ai_gateway_token' }),
]);

const CHANNEL_KEYS = Object.freeze([
  'id', 'name', 'enabled', 'platform', 'mode', 'cron', 'timezone', 'notBefore',
  'sources', 'prompt', 'ai', 'telegram', 'limits',
]);
// Record metadata and system state that clients may echo back; never taken
// from input (`cutoverRequired` can be neither set nor cleared through the API).
const READ_ONLY_KEYS = Object.freeze(['version', 'createdAt', 'updatedAt', 'updatedBy', 'cutoverRequired']);
const PROMPT_KEYS = Object.freeze(['language', 'style', 'audience', 'customSystemPrompt']);
const AI_KEYS = Object.freeze(['provider', 'model', 'name', 'baseUrl', 'apiKeyCredentialId', 'gateway']);
const GATEWAY_KEYS = Object.freeze(['accountId', 'gatewayId', 'byokAlias', 'tokenCredentialId']);
const TELEGRAM_KEYS = Object.freeze(['botTokenCredentialId', 'chatIdCredentialId']);
const BASE_URL_POLICY = Object.freeze({ ollama: 'optional', custom: 'required' });
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BYOK_ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MODEL_PATTERN = /^[\x21-\x7e]+$/;

/** Channel input or stored config that failed validation. */
export class ChannelValidationError extends ValidationError {
  /** @param {import('./validation.js').ValidationIssue[]} issues */
  constructor(issues) {
    super('Channel configuration is invalid', issues);
    this.name = 'ChannelValidationError';
  }
}

/**
 * @typedef {object} ChannelPrompt
 * @property {'vi'|'en'} language
 * @property {string} style Key of the built-in prompt styles.
 * @property {string} audience
 * @property {string|null} customSystemPrompt Replaces only the style section of the prompt.
 */

/**
 * @typedef {object} ChannelGateway Cloudflare AI Gateway settings (Gemini only).
 * @property {string} accountId
 * @property {string} gatewayId
 * @property {string|null} byokAlias
 * @property {string|null} tokenCredentialId `ai_gateway_token` credential.
 */

/**
 * @typedef {object} ChannelAI
 * @property {string} provider One of `AI_PROVIDERS`.
 * @property {string|null} model `null` uses the provider default.
 * @property {string|null} name Display name (custom provider only).
 * @property {string|null} baseUrl Endpoint (ollama and custom only).
 * @property {string|null} apiKeyCredentialId `ai_api_key` credential.
 * @property {ChannelGateway|null} gateway
 */

/**
 * @typedef {object} ChannelConfig
 * @property {string} id Kebab-case, immutable after creation.
 * @property {string} name
 * @property {boolean} enabled
 * @property {'telegram'} platform
 * @property {'digest'|'drip'} mode
 * @property {string} cron Five-field cron expression.
 * @property {string} timezone IANA time zone.
 * @property {string|null} notBefore ISO instant; older articles are not published.
 * @property {import('./source-factories.js').SourceEntry[]} sources
 * @property {ChannelPrompt} prompt
 * @property {ChannelAI} ai
 * @property {{ botTokenCredentialId: string|null, chatIdCredentialId: string|null }} telegram
 * @property {{ batchSize: number, delayMs: number, dailyLimit: number, maxArticles: number, maxArticlesPerSource: number, concurrency: number }} limits
 */

/**
 * Validate channel input and return its normalized form with every default
 * filled in. Read-only record metadata (`version`, timestamps) is ignored.
 *
 * @param {unknown} input
 * @param {{ existingId?: string }} [options] Set for updates: `id` may be omitted but never changed.
 * @returns {ChannelConfig}
 * @throws {ChannelValidationError}
 */
export function validateChannelConfig(input, { existingId } = {}) {
  const issues = new IssueCollector();
  const value = readObject(issues, input, '', { allowed: CHANNEL_KEYS, ignored: READ_ONLY_KEYS });
  if (!value) throw new ChannelValidationError(issues.issues);

  const config = {
    id: readChannelId(issues, value.id, existingId),
    name: readString(issues, value.name, 'name', { required: true, max: 100 }),
    enabled: readBoolean(issues, value.enabled, 'enabled', { defaultValue: true }),
    platform: readEnum(issues, value.platform, 'platform', CHANNEL_PLATFORMS, { defaultValue: 'telegram' }),
    mode: readEnum(issues, value.mode, 'mode', CHANNEL_MODES, { required: true }),
    cron: readCron(issues, value.cron),
    timezone: readTimezone(issues, value.timezone),
    notBefore: readIsoInstant(issues, value.notBefore, 'notBefore'),
    sources: normalizeSourceEntries(issues, value.sources, 'sources'),
    prompt: readPrompt(issues, value.prompt),
    ai: readAI(issues, value.ai),
    telegram: readTelegram(issues, value.telegram),
    limits: readLimits(issues, value.limits),
  };
  if (config.enabled && config.sources.length > 0 && config.sources.every(entry => entry && !entry.enabled)) {
    issues.add('sources', 'no_enabled_sources', 'Kênh đang bật cần ít nhất một nguồn đang bật.');
  }
  if (issues.hasIssues) throw new ChannelValidationError(issues.issues);
  return config;
}

/**
 * Credential references set in a channel config, in slot order.
 * @param {Pick<ChannelConfig, 'ai'|'telegram'>} config
 * @returns {{ field: string, kind: string, credentialId: string }[]}
 */
export function listCredentialReferences(config) {
  const references = [];
  for (const slot of CREDENTIAL_SLOTS) {
    const credentialId = CREDENTIAL_SLOT_READERS[slot.field](config);
    if (typeof credentialId === 'string' && credentialId !== '') references.push({ ...slot, credentialId });
  }
  return references;
}

/**
 * Which AI credentials a provider needs at run time. Gemini through the AI
 * Gateway authenticates with the gateway token and a provider key stored in
 * the gateway (BYOK), so it takes no API key of its own.
 * @param {Pick<ChannelAI, 'provider'|'gateway'>} ai
 * @returns {{ apiKey: 'required'|'optional'|'none', gatewayToken: boolean }}
 */
export function aiCredentialRequirements(ai) {
  if (ai.provider === 'gemini' && ai.gateway) return { apiKey: 'none', gatewayToken: true };
  if (ai.provider === 'ollama') return { apiKey: 'none', gatewayToken: false };
  if (ai.provider === 'custom') return { apiKey: 'optional', gatewayToken: false };
  return { apiKey: 'required', gatewayToken: false };
}

function readChannelId(issues, value, existingId) {
  if (existingId !== undefined) {
    if (value !== undefined && value !== existingId) issues.add('id', 'immutable', 'Không thể đổi ID kênh sau khi tạo.');
    return existingId;
  }
  return readString(issues, value, 'id', {
    required: true,
    max: CHANNEL_ID_MAX_LENGTH,
    pattern: CHANNEL_ID_PATTERN,
    patternMessage: 'ID kênh dạng kebab-case: chữ thường, số và "-", ví dụ telegram-main.',
  });
}

function readCron(issues, value) {
  const text = readString(issues, value, 'cron', { required: true, max: 120 });
  if (typeof text !== 'string') return text;
  if (!validateCronExpression(text)) {
    return issues.add('cron', 'invalid_cron', 'Cron cần đúng 5 trường "phút giờ ngày tháng thứ", ví dụ 0 0-17 * * *.');
  }
  return text.split(/\s+/).join(' ');
}

function readTimezone(issues, value) {
  const text = readString(issues, value, 'timezone', { max: 64, defaultValue: 'UTC' });
  if (typeof text !== 'string') return text;
  if (!TIMEZONE_PATTERN.test(text) || !isSupportedTimeZone(text)) {
    return issues.add('timezone', 'invalid_timezone', 'Timezone phải là tên IANA, ví dụ UTC hoặc Asia/Ho_Chi_Minh.');
  }
  return text;
}

function isSupportedTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function readPrompt(issues, value) {
  const prompt = readObject(issues, value, 'prompt', { allowed: PROMPT_KEYS });
  if (!prompt) return undefined;
  return {
    language: readEnum(issues, prompt.language, 'prompt.language', PROMPT_LANGUAGES, { defaultValue: 'vi' }),
    style: readEnum(issues, prompt.style, 'prompt.style', PROMPT_STYLES, { defaultValue: 'digest' }),
    audience: readString(issues, prompt.audience, 'prompt.audience', { required: true, max: MAX_AUDIENCE_LENGTH }),
    customSystemPrompt: readString(issues, prompt.customSystemPrompt, 'prompt.customSystemPrompt', {
      max: MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
      multiline: true,
    }),
  };
}

function readAI(issues, value) {
  const ai = readObject(issues, value, 'ai', { allowed: AI_KEYS });
  if (!ai) return undefined;
  const provider = readEnum(issues, ai.provider, 'ai.provider', AI_PROVIDERS, { required: true });
  if (!provider) return undefined;

  const gateway = provider === 'gemini'
    ? readGateway(issues, ai.gateway)
    : rejectInapplicable(issues, ai.gateway, 'ai.gateway');
  const baseUrlPolicy = BASE_URL_POLICY[provider];
  const apiKeyApplies = aiCredentialRequirements({ provider, gateway }).apiKey !== 'none';
  return {
    provider,
    model: readString(issues, ai.model, 'ai.model', {
      max: 200,
      pattern: MODEL_PATTERN,
      patternMessage: 'Tên model không được chứa khoảng trắng hoặc ký tự ngoài ASCII.',
    }),
    name: provider === 'custom'
      ? readString(issues, ai.name, 'ai.name', { max: 100 })
      : rejectInapplicable(issues, ai.name, 'ai.name'),
    baseUrl: baseUrlPolicy
      ? readBaseUrl(issues, ai.baseUrl, baseUrlPolicy === 'required')
      : rejectInapplicable(issues, ai.baseUrl, 'ai.baseUrl'),
    apiKeyCredentialId: apiKeyApplies
      ? readCredentialId(issues, ai.apiKeyCredentialId, 'ai.apiKeyCredentialId')
      : rejectInapplicable(issues, ai.apiKeyCredentialId, 'ai.apiKeyCredentialId'),
    gateway,
  };
}

function readGateway(issues, value) {
  const gateway = readObject(issues, value, 'ai.gateway', { allowed: GATEWAY_KEYS, required: false });
  if (!gateway) return null;
  return {
    accountId: readString(issues, gateway.accountId, 'ai.gateway.accountId', {
      required: true,
      max: 64,
      pattern: GATEWAY_ID_PATTERN,
      patternMessage: 'Account ID chỉ gồm chữ, số, "-" hoặc "_".',
    }),
    gatewayId: readString(issues, gateway.gatewayId, 'ai.gateway.gatewayId', {
      required: true,
      max: 64,
      pattern: GATEWAY_ID_PATTERN,
      patternMessage: 'Gateway ID chỉ gồm chữ, số, "-" hoặc "_".',
    }),
    byokAlias: readString(issues, gateway.byokAlias, 'ai.gateway.byokAlias', {
      max: 64,
      pattern: BYOK_ALIAS_PATTERN,
      patternMessage: 'BYOK alias chỉ gồm chữ, số, ".", "-" hoặc "_".',
    }),
    tokenCredentialId: readCredentialId(issues, gateway.tokenCredentialId, 'ai.gateway.tokenCredentialId'),
  };
}

function readBaseUrl(issues, value, required) {
  const url = readHttpUrl(issues, value, 'ai.baseUrl', { required });
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

function readTelegram(issues, value) {
  const telegram = readObject(issues, value, 'telegram', { allowed: TELEGRAM_KEYS, required: false }) ?? {};
  return {
    botTokenCredentialId: readCredentialId(issues, telegram.botTokenCredentialId, 'telegram.botTokenCredentialId'),
    chatIdCredentialId: readCredentialId(issues, telegram.chatIdCredentialId, 'telegram.chatIdCredentialId'),
  };
}

function readLimits(issues, value) {
  const limits = readObject(issues, value, 'limits', { allowed: Object.keys(LIMIT_RANGES), required: false }) ?? {};
  const result = Object.fromEntries(Object.entries(LIMIT_RANGES).map(([key, [min, max]]) => [
    key,
    readInteger(issues, limits[key], `limits.${key}`, { min, max, defaultValue: DEFAULT_LIMITS[key] }),
  ]));
  // Checked only when both values are valid on their own, so one mistake is reported once.
  if (Number.isSafeInteger(result.batchSize) && Number.isSafeInteger(result.delayMs)
    && result.batchSize * result.delayMs > MAX_BATCH_DELAY_MS) {
    issues.add('limits.delayMs', 'batch_delay_too_long',
      `Tích batchSize × delayMs tối đa ${MAX_BATCH_DELAY_MS} ms (10 phút) để một lượt chạy không giữ hàng đợi chung quá lâu.`);
  }
  return result;
}

function readCredentialId(issues, value, field) {
  return readString(issues, value, field, {
    max: 64,
    pattern: CREDENTIAL_ID_PATTERN,
    patternMessage: 'ID credential không hợp lệ.',
  });
}

function rejectInapplicable(issues, value, field) {
  if (value === undefined || value === null || value === '') return null;
  return issues.add(field, 'not_applicable', 'Không áp dụng cho AI provider đã chọn.');
}
