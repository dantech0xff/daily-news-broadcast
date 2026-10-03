/**
 * `GET /api/meta` (`viewer`): the enumerations and bounds the dashboard
 * builds its forms and filters from, so the UI never keeps its own copy of
 * the values the API validates.
 *
 * Most values are read straight from the modules that enforce them (channel
 * schema, source factories, prompts, credential store, controls, run and
 * content repositories). The typed-source field specs and the AI endpoint,
 * display-name, and gateway rules restate checks that `config-schema.js` and
 * `source-factories.js` keep private; `tests/app/api-meta.test.js` runs every
 * spec through `validateChannelConfig()` so the two cannot drift silently.
 *
 * The body is static for a given build: it is computed once and frozen.
 */

import { Router } from 'express';

import { PROMPT_LANGUAGES, PROMPT_STYLES } from '../../ai/_prompts.js';
import {
  AI_PROVIDERS,
  CHANNEL_ID_MAX_LENGTH,
  CHANNEL_ID_PATTERN,
  CHANNEL_MODES,
  CHANNEL_PLATFORMS,
  CREDENTIAL_KINDS,
  CREDENTIAL_SLOTS,
  DEFAULT_LIMITS,
  LIMIT_RANGES,
  MAX_AUDIENCE_LENGTH,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
  aiCredentialRequirements,
} from '../channels/config-schema.js';
import { MAX_SOURCE_ENTRIES, PRESET_FACTORIES, PRESET_NAMES, SOURCE_TYPES } from '../channels/source-factories.js';
import { CONTENT_DATE_FIELDS, CONTENT_STATUSES, MAX_CONTENT_PAGE_SIZE, REJECT_REASONS } from '../db/content-repository.js';
import { MAX_RUN_PAGE_SIZE, RUN_STATUSES, RUN_TRIGGER_TYPES } from '../db/run-repository.js';
import { MAX_STATS_RANGE_DAYS } from '../db/stats-repository.js';
import { CONTROL_ACTIONS, MAX_CONTROL_REASON_LENGTH } from '../runtime/controls.js';
import { MAX_CREDENTIAL_LABEL_LENGTH, MAX_CREDENTIAL_VALUE_LENGTH } from '../secrets/credential-repository.js';

/**
 * @typedef {object} FieldSpec One config field of a typed source (or nested JSON mapping).
 * @property {string} key
 * @property {'text'|'url'|'integer'|'enum'|'jsonPath'|'jsonFields'} kind
 * @property {boolean} required
 * @property {number} [maxLength] Characters, after trimming.
 * @property {string} [pattern] `RegExp` source the trimmed text must match.
 * @property {number} [min] Inclusive (integers).
 * @property {number} [max] Inclusive (integers).
 * @property {string[]} [options] Allowed values (enums).
 * @property {FieldSpec[]} [fields] Paths of a `jsonFields` mapping.
 */

const MAX_URL_LENGTH = 2_048;
const CHANNEL_NAME_MAX_LENGTH = 100;
const CRON_MAX_LENGTH = 120;
const MODEL_MAX_LENGTH = 200;
const MODEL_PATTERN = '^[\\x21-\\x7e]+$';
const AI_NAME_MAX_LENGTH = 100;
const DEFAULT_PROMPT_LANGUAGE = 'vi';
const DEFAULT_PROMPT_STYLE = 'digest';
const GATEWAY_PROVIDER = 'gemini';
const CUSTOM_NAME_PROVIDER = 'custom';
/** Providers that take an endpoint (`ai.baseUrl`); every other provider rejects one. */
const AI_BASE_URL_RULES = Object.freeze({ ollama: 'optional', custom: 'required' });

const SOURCE_ID_FIELD = field('id', 'text', { required: true, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' });
const SOURCE_NAME_FIELD = field('name', 'text', { required: true, maxLength: 100 });
const SOURCE_ICON_FIELD = field('icon', 'text', { maxLength: 16 });
const SOURCE_CATEGORY_FIELD = field('category', 'text', { maxLength: 64 });
const JSON_PATH = Object.freeze({ maxLength: 200, pattern: '^[A-Za-z0-9_$-]+(?:\\.[A-Za-z0-9_$-]+){0,9}$' });

/** Config fields of every typed source, in form order. */
const SOURCE_FIELD_SPECS = Object.freeze({
  rss: [
    SOURCE_ID_FIELD,
    SOURCE_NAME_FIELD,
    field('feedUrl', 'url', { required: true, maxLength: MAX_URL_LENGTH }),
    SOURCE_ICON_FIELD,
    SOURCE_CATEGORY_FIELD,
    field('baseUrl', 'url', { maxLength: MAX_URL_LENGTH }),
  ],
  hackernews: [
    field('query', 'text', { maxLength: 200 }),
    field('filter', 'enum', { options: ['front_page'] }),
    field('minPoints', 'integer', { min: 0, max: 100_000 }),
  ],
  reddit: [
    field('subreddit', 'text', { required: true, maxLength: 21, pattern: '^[A-Za-z0-9][A-Za-z0-9_]{1,20}$' }),
    field('sort', 'enum', { options: ['hot', 'new', 'top', 'rising'] }),
    field('minUpvotes', 'integer', { min: 0, max: 1_000_000 }),
  ],
  devto: [
    field('tag', 'text', { maxLength: 30, pattern: '^[a-z0-9]{1,30}$' }),
    field('minReactions', 'integer', { min: 0, max: 1_000_000 }),
  ],
  'github-trending': [
    field('language', 'text', { maxLength: 50, pattern: '^[A-Za-z0-9+#._-]{1,50}$' }),
    field('since', 'enum', { options: ['daily', 'weekly'] }),
    field('minStars', 'integer', { min: 0, max: 10_000_000 }),
  ],
  html: [
    SOURCE_ID_FIELD,
    SOURCE_NAME_FIELD,
    field('url', 'url', { required: true, maxLength: MAX_URL_LENGTH }),
    SOURCE_ICON_FIELD,
    SOURCE_CATEGORY_FIELD,
  ],
  json: [
    SOURCE_ID_FIELD,
    SOURCE_NAME_FIELD,
    field('url', 'url', { required: true, maxLength: MAX_URL_LENGTH }),
    SOURCE_ICON_FIELD,
    SOURCE_CATEGORY_FIELD,
    field('itemsPath', 'jsonPath', JSON_PATH),
    field('fields', 'jsonFields', {
      required: true,
      fields: [
        field('title', 'jsonPath', { required: true, ...JSON_PATH }),
        field('url', 'jsonPath', { required: true, ...JSON_PATH }),
        field('id', 'jsonPath', JSON_PATH),
        field('content', 'jsonPath', JSON_PATH),
        field('publishedAt', 'jsonPath', JSON_PATH),
        field('author', 'jsonPath', JSON_PATH),
      ],
    }),
  ],
});

const GATEWAY_FIELD_SPECS = Object.freeze([
  field('accountId', 'text', { required: true, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' }),
  field('gatewayId', 'text', { required: true, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' }),
  field('byokAlias', 'text', { maxLength: 64, pattern: '^[A-Za-z0-9_.-]{1,64}$' }),
]);

/**
 * The `/api/meta` body.
 * @returns {Readonly<Record<string, unknown>>} Deeply frozen.
 */
export function buildDashboardMeta() {
  const typedSourceTypes = SOURCE_TYPES.filter(type => type !== 'preset');
  const missingSpecs = typedSourceTypes.filter(type => !Object.hasOwn(SOURCE_FIELD_SPECS, type));
  if (missingSpecs.length > 0) throw new Error(`Dashboard meta has no field spec for source type(s): ${missingSpecs.join(', ')}`);

  return deepFreeze({
    channel: {
      platforms: [...CHANNEL_PLATFORMS],
      modes: [...CHANNEL_MODES],
      idPattern: CHANNEL_ID_PATTERN.source,
      idMaxLength: CHANNEL_ID_MAX_LENGTH,
      nameMaxLength: CHANNEL_NAME_MAX_LENGTH,
      cronMaxLength: CRON_MAX_LENGTH,
    },
    sources: {
      maxEntries: MAX_SOURCE_ENTRIES,
      presets: PRESET_NAMES.map(name => ({
        id: name,
        sources: PRESET_FACTORIES[name]().map(plugin => ({ id: String(plugin.id), name: String(plugin.name) })),
      })),
      types: typedSourceTypes.map(type => ({ type, fields: SOURCE_FIELD_SPECS[type] })),
    },
    ai: {
      providers: AI_PROVIDERS.map(describeProvider),
      modelMaxLength: MODEL_MAX_LENGTH,
      modelPattern: MODEL_PATTERN,
      nameMaxLength: AI_NAME_MAX_LENGTH,
      baseUrlMaxLength: MAX_URL_LENGTH,
    },
    prompt: {
      languages: [...PROMPT_LANGUAGES],
      styles: [...PROMPT_STYLES],
      defaultLanguage: DEFAULT_PROMPT_LANGUAGE,
      defaultStyle: DEFAULT_PROMPT_STYLE,
      audienceMaxLength: MAX_AUDIENCE_LENGTH,
      customSystemPromptMaxLength: MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
    },
    limits: {
      ranges: Object.fromEntries(Object.entries(LIMIT_RANGES).map(([key, [min, max]]) => [key, { min, max }])),
      defaults: { ...DEFAULT_LIMITS },
    },
    credentials: {
      kinds: [...CREDENTIAL_KINDS],
      slots: CREDENTIAL_SLOTS.map(slot => ({ field: slot.field, kind: slot.kind })),
      labelMaxLength: MAX_CREDENTIAL_LABEL_LENGTH,
      valueMaxLength: MAX_CREDENTIAL_VALUE_LENGTH,
    },
    controls: {
      actions: [...CONTROL_ACTIONS],
      reasonMaxLength: MAX_CONTROL_REASON_LENGTH,
    },
    runs: {
      statuses: [...RUN_STATUSES],
      triggerTypes: [...RUN_TRIGGER_TYPES],
      maxPageSize: MAX_RUN_PAGE_SIZE,
    },
    content: {
      statuses: [...CONTENT_STATUSES],
      rejectReasons: [...REJECT_REASONS],
      dateFields: Object.keys(CONTENT_DATE_FIELDS),
      maxPageSize: MAX_CONTENT_PAGE_SIZE,
    },
    stats: {
      maxRangeDays: MAX_STATS_RANGE_DAYS,
    },
  });
}

/**
 * @param {{ guards: { viewer: import('express').RequestHandler } }} options
 * @returns {import('express').Router}
 */
export function createMetaRoutes({ guards }) {
  const body = buildDashboardMeta();
  const router = Router();
  router.get('/meta', guards.viewer, (_req, res) => {
    res.json(body);
  });
  return router;
}

/**
 * Credentials, endpoint, and gateway rules of one AI provider.
 * - `apiKey`: whether `ai.apiKeyCredentialId` is required at run time, optional, or rejected;
 * - `baseUrl`: whether `ai.baseUrl` is required, optional, or rejected;
 * - `customName`: whether `ai.name` (display name) is accepted;
 * - `gateway`: Cloudflare AI Gateway settings when the provider supports them (`null`
 *   otherwise); with a gateway the API key rule becomes `gateway.apiKey` and the
 *   gateway token credential is needed at run time when `tokenRequired`.
 * @param {string} provider
 */
function describeProvider(provider) {
  const direct = aiCredentialRequirements({ provider, gateway: null });
  const viaGateway = provider === GATEWAY_PROVIDER ? aiCredentialRequirements({ provider, gateway: {} }) : null;
  return {
    id: provider,
    apiKey: direct.apiKey,
    baseUrl: AI_BASE_URL_RULES[provider] ?? 'none',
    customName: provider === CUSTOM_NAME_PROVIDER,
    gateway: viaGateway
      ? { apiKey: viaGateway.apiKey, tokenRequired: viaGateway.gatewayToken, fields: GATEWAY_FIELD_SPECS }
      : null,
  };
}

/**
 * @param {string} key
 * @param {FieldSpec['kind']} kind
 * @param {Partial<Omit<FieldSpec, 'key'|'kind'>>} [options]
 * @returns {FieldSpec}
 */
function field(key, kind, { required = false, ...rest } = {}) {
  return Object.freeze({ key, kind, required, ...rest });
}

// Shared field specs are frozen shallowly at declaration; this walks every level.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
