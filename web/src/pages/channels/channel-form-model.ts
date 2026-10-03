/**
 * Channel form model: conversion between stored channel records and editable
 * form values, client-side validation, and the request payloads.
 *
 * Errors are keyed by the API's dotted field paths (`name`,
 * `sources.0.config.feedUrl`, `limits.dailyLimit`, …) so client checks and
 * server `issues` land on the same inputs. The server stays authoritative:
 * these checks only catch mistakes before a round trip.
 */

import type {
  AiProviderMeta,
  ChannelConfig,
  ChannelInput,
  ChannelMode,
  ChannelRecord,
  ChannelUpdate,
  FieldSpec,
  LimitKey,
  Meta,
  SourceConfigValue,
  SourceEntry,
} from '../../api/types';
import { LIMIT_KEYS, isPresetEntry } from '../../api/types';
import { isValidCron } from '../../lib/cron';
import { isValidTimeZone } from '../../lib/timezones';

export type FieldErrors = Record<string, string>;

export interface SourceDraft {
  /** Client-only key for React lists. */
  key: string;
  /** `preset` or a typed source type. */
  type: string;
  enabled: boolean;
  preset: string;
  /** Text of every non-mapping field of a typed source ('' = unset). */
  values: Record<string, string>;
  /** Paths of the JSON source's `fields` mapping ('' = unset). */
  mapping: Record<string, string>;
  /** Stored config keys the meta does not describe; sent back unchanged. */
  extra: Record<string, SourceConfigValue>;
}

export interface ChannelFormValues {
  id: string;
  name: string;
  enabled: boolean;
  mode: ChannelMode;
  cron: string;
  timezone: string;
  /** ISO instant or null. */
  notBefore: string | null;
  sources: SourceDraft[];
  prompt: { language: string; style: string; audience: string; customSystemPrompt: string };
  ai: {
    provider: string;
    model: string;
    name: string;
    baseUrl: string;
    apiKeyCredentialId: string;
    useGateway: boolean;
    gateway: { accountId: string; gatewayId: string; byokAlias: string; tokenCredentialId: string };
  };
  telegram: { botTokenCredentialId: string; chatIdCredentialId: string };
  limits: Record<LimitKey, string>;
}

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const DEFAULT_CRON = '0 * * * *';
const DEFAULT_PROVIDER = 'claude';
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

let sourceKeyCounter = 0;
function newSourceKey(): string {
  sourceKeyCounter += 1;
  return `source-${sourceKeyCounter}`;
}

// ---------------------------------------------------------------------------
// Meta lookups

export function providerMeta(meta: Meta, provider: string): AiProviderMeta | undefined {
  return meta.ai.providers.find(entry => entry.id === provider);
}

export function sourceFieldSpecs(meta: Meta, type: string): FieldSpec[] | undefined {
  return meta.sources.types.find(entry => entry.type === type)?.fields;
}

/** Effective API-key rule of the AI section (Gemini through the gateway needs none). */
export function apiKeyRequirement(meta: Meta, ai: ChannelFormValues['ai']): AiProviderMeta['apiKey'] {
  const rules = providerMeta(meta, ai.provider);
  if (!rules) return 'optional';
  return rules.gateway && ai.useGateway ? rules.gateway.apiKey : rules.apiKey;
}

// ---------------------------------------------------------------------------
// Construction

export function emptySourceDraft(type: string, preset = ''): SourceDraft {
  return { key: newSourceKey(), type, enabled: true, preset, values: {}, mapping: {}, extra: {} };
}

export function createEmptyForm(meta: Meta): ChannelFormValues {
  const provider = providerMeta(meta, DEFAULT_PROVIDER) ? DEFAULT_PROVIDER : meta.ai.providers[0]?.id ?? DEFAULT_PROVIDER;
  return {
    id: '',
    name: '',
    enabled: true,
    mode: meta.channel.modes.includes('drip') ? 'drip' : meta.channel.modes[0] ?? 'drip',
    cron: DEFAULT_CRON,
    timezone: DEFAULT_TIMEZONE,
    notBefore: null,
    sources: [],
    prompt: { language: meta.prompt.defaultLanguage, style: meta.prompt.defaultStyle, audience: '', customSystemPrompt: '' },
    ai: {
      provider,
      model: '',
      name: '',
      baseUrl: '',
      apiKeyCredentialId: '',
      useGateway: false,
      gateway: { accountId: '', gatewayId: '', byokAlias: '', tokenCredentialId: '' },
    },
    telegram: { botTokenCredentialId: '', chatIdCredentialId: '' },
    limits: limitStrings(meta.limits.defaults),
  };
}

export function recordToForm(record: ChannelRecord, meta: Meta): ChannelFormValues {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    mode: record.mode,
    cron: record.cron,
    timezone: record.timezone,
    notBefore: record.notBefore,
    sources: record.sources.map(entry => sourceToDraft(entry, meta)),
    prompt: {
      language: record.prompt.language,
      style: record.prompt.style,
      audience: record.prompt.audience,
      customSystemPrompt: record.prompt.customSystemPrompt ?? '',
    },
    ai: {
      provider: record.ai.provider,
      model: record.ai.model ?? '',
      name: record.ai.name ?? '',
      baseUrl: record.ai.baseUrl ?? '',
      apiKeyCredentialId: record.ai.apiKeyCredentialId ?? '',
      useGateway: record.ai.gateway !== null,
      gateway: {
        accountId: record.ai.gateway?.accountId ?? '',
        gatewayId: record.ai.gateway?.gatewayId ?? '',
        byokAlias: record.ai.gateway?.byokAlias ?? '',
        tokenCredentialId: record.ai.gateway?.tokenCredentialId ?? '',
      },
    },
    telegram: {
      botTokenCredentialId: record.telegram.botTokenCredentialId ?? '',
      chatIdCredentialId: record.telegram.chatIdCredentialId ?? '',
    },
    limits: limitStrings(record.limits),
  };
}

function limitStrings(limits: Partial<Record<LimitKey, number>>): Record<LimitKey, string> {
  return Object.fromEntries(LIMIT_KEYS.map(key => [key, limits[key] === undefined ? '' : String(limits[key])])) as Record<LimitKey, string>;
}

function sourceToDraft(entry: SourceEntry, meta: Meta): SourceDraft {
  if (isPresetEntry(entry)) return { ...emptySourceDraft('preset', entry.preset), enabled: entry.enabled };
  const specs = sourceFieldSpecs(meta, entry.type) ?? [];
  const draft: SourceDraft = { ...emptySourceDraft(entry.type), enabled: entry.enabled };
  for (const [key, value] of Object.entries(entry.config ?? {})) {
    const spec = specs.find(candidate => candidate.key === key);
    if (!spec) {
      draft.extra[key] = value;
    } else if (spec.kind === 'jsonFields') {
      if (typeof value === 'object' && value !== null) {
        for (const [path, text] of Object.entries(value)) draft.mapping[path] = String(text);
      }
    } else {
      draft.values[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Payloads

/** Normalized channel config the form describes (`platform` is left to the server default). */
export function formToConfig(values: ChannelFormValues, meta: Meta): Omit<ChannelConfig, 'platform'> {
  const rules = providerMeta(meta, values.ai.provider);
  const gatewayOn = Boolean(rules?.gateway) && values.ai.useGateway;
  const apiKeyRule = apiKeyRequirement(meta, values.ai);
  return {
    id: values.id.trim(),
    name: values.name.trim(),
    enabled: values.enabled,
    mode: values.mode,
    cron: values.cron.trim().split(/\s+/).join(' '),
    timezone: values.timezone.trim(),
    notBefore: values.notBefore,
    sources: values.sources.map(draft => draftToEntry(draft, meta)),
    prompt: {
      language: values.prompt.language,
      style: values.prompt.style,
      audience: values.prompt.audience.trim(),
      customSystemPrompt: emptyToNull(values.prompt.customSystemPrompt),
    },
    ai: {
      provider: values.ai.provider,
      model: emptyToNull(values.ai.model),
      name: rules?.customName ? emptyToNull(values.ai.name) : null,
      baseUrl: rules && rules.baseUrl !== 'none' ? emptyToNull(values.ai.baseUrl) : null,
      apiKeyCredentialId: apiKeyRule !== 'none' ? emptyToNull(values.ai.apiKeyCredentialId) : null,
      gateway: gatewayOn
        ? {
          accountId: values.ai.gateway.accountId.trim(),
          gatewayId: values.ai.gateway.gatewayId.trim(),
          byokAlias: emptyToNull(values.ai.gateway.byokAlias),
          tokenCredentialId: emptyToNull(values.ai.gateway.tokenCredentialId),
        }
        : null,
    },
    telegram: {
      botTokenCredentialId: emptyToNull(values.telegram.botTokenCredentialId),
      chatIdCredentialId: emptyToNull(values.telegram.chatIdCredentialId),
    },
    limits: Object.fromEntries(LIMIT_KEYS.map(key => [key, Number(values.limits[key].trim())])) as Record<LimitKey, number>,
  };
}

/** `POST /api/channels` body. */
export function toCreateInput(values: ChannelFormValues, meta: Meta): ChannelInput {
  return formToConfig(values, meta);
}

/** `PUT /api/channels/:id` body: every editable field plus the version the edit started from. */
export function toUpdateInput(values: ChannelFormValues, meta: Meta, version: number): ChannelUpdate {
  const { id: _id, ...config } = formToConfig(values, meta);
  return { version, ...config };
}

function draftToEntry(draft: SourceDraft, meta: Meta): SourceEntry {
  if (draft.type === 'preset') return { type: 'preset', preset: draft.preset, enabled: draft.enabled };
  const specs = sourceFieldSpecs(meta, draft.type) ?? [];
  const config: Record<string, SourceConfigValue> = { ...draft.extra };
  for (const spec of specs) {
    if (spec.kind === 'jsonFields') {
      const mapping = Object.fromEntries(
        Object.entries(draft.mapping).map(([key, path]) => [key, path.trim()]).filter(([, path]) => path !== ''),
      );
      if (Object.keys(mapping).length > 0) config[spec.key] = mapping;
      continue;
    }
    const text = (draft.values[spec.key] ?? '').trim();
    if (text === '') continue;
    config[spec.key] = spec.kind === 'integer' && /^-?\d+$/.test(text) ? Number(text) : text;
  }
  return { type: draft.type, enabled: draft.enabled, config };
}

function emptyToNull(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Validation

const REQUIRED = 'Bắt buộc.';

/** Problem with one typed-source (or gateway) field value, or null. */
export function validateFieldValue(spec: FieldSpec, raw: string): string | null {
  const text = raw.trim();
  if (text === '') return spec.required ? REQUIRED : null;
  if (spec.maxLength !== undefined && text.length > spec.maxLength) return `Tối đa ${spec.maxLength} ký tự.`;
  switch (spec.kind) {
    case 'integer': {
      if (!/^-?\d+$/.test(text)) return 'Phải là số nguyên.';
      const value = Number(text);
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        return `Phải từ ${spec.min ?? '−∞'} đến ${spec.max ?? '∞'}.`;
      }
      return null;
    }
    case 'url':
      return isHttpUrl(text) ? null : 'Phải là URL http:// hoặc https:// hợp lệ, không chứa thông tin đăng nhập.';
    case 'enum':
      return spec.options?.includes(text) ? null : 'Giá trị không hợp lệ.';
    case 'jsonPath':
      if (spec.pattern && !new RegExp(spec.pattern).test(text)) return 'Đường dẫn dạng a.b.c (chữ, số, "_", "-", "$"; tối đa 10 cấp).';
      return text.split('.').some(segment => UNSAFE_PATH_SEGMENTS.has(segment)) ? 'Đường dẫn chứa đoạn không được phép.' : null;
    default:
      return spec.pattern && !new RegExp(spec.pattern).test(text) ? 'Sai định dạng.' : null;
  }
}

export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateChannelForm(values: ChannelFormValues, meta: Meta, { isNew }: { isNew: boolean }): FieldErrors {
  const errors: FieldErrors = {};
  const add = (field: string, message: string | null) => {
    if (message && !(field in errors)) errors[field] = message;
  };
  const text = (value: string, { required = false, max }: { required?: boolean; max?: number }) => {
    const trimmed = value.trim();
    if (trimmed === '') return required ? REQUIRED : null;
    return max !== undefined && trimmed.length > max ? `Tối đa ${max} ký tự.` : null;
  };

  if (isNew) {
    const id = values.id.trim();
    add('id', text(values.id, { required: true, max: meta.channel.idMaxLength })
      ?? (new RegExp(meta.channel.idPattern).test(id) ? null : 'ID kênh dạng kebab-case: chữ thường, số và "-", ví dụ telegram-main.'));
  }
  add('name', text(values.name, { required: true, max: meta.channel.nameMaxLength }));
  add('cron', text(values.cron, { required: true, max: meta.channel.cronMaxLength })
    ?? (isValidCron(values.cron) ? null : 'Cron cần đúng 5 trường "phút giờ ngày tháng thứ", ví dụ 0 0-17 * * *.'));
  add('timezone', text(values.timezone, { required: true, max: 64 })
    ?? (isValidTimeZone(values.timezone.trim()) ? null : 'Timezone phải là tên IANA, ví dụ UTC hoặc Asia/Ho_Chi_Minh.'));

  validateSources(values, meta, add);

  add('prompt.audience', text(values.prompt.audience, { required: true, max: meta.prompt.audienceMaxLength }));
  add('prompt.customSystemPrompt', text(values.prompt.customSystemPrompt, { max: meta.prompt.customSystemPromptMaxLength }));
  if (!meta.prompt.languages.includes(values.prompt.language)) add('prompt.language', 'Ngôn ngữ không hợp lệ.');
  if (!meta.prompt.styles.includes(values.prompt.style)) add('prompt.style', 'Style không hợp lệ.');

  validateAi(values, meta, add);

  for (const key of LIMIT_KEYS) {
    const range = meta.limits.ranges[key];
    const raw = values.limits[key].trim();
    if (raw === '') add(`limits.${key}`, REQUIRED);
    else if (!/^\d+$/.test(raw)) add(`limits.${key}`, 'Phải là số nguyên.');
    else if (Number(raw) < range.min || Number(raw) > range.max) add(`limits.${key}`, `Phải từ ${range.min} đến ${range.max}.`);
  }
  return errors;
}

function validateSources(values: ChannelFormValues, meta: Meta, add: (field: string, message: string | null) => void) {
  if (values.sources.length === 0) {
    add('sources', 'Cần ít nhất một nguồn.');
    return;
  }
  if (values.sources.length > meta.sources.maxEntries) add('sources', `Tối đa ${meta.sources.maxEntries} nguồn.`);
  if (values.enabled && values.sources.every(source => !source.enabled)) {
    add('sources', 'Kênh đang bật cần ít nhất một nguồn đang bật.');
  }
  const seenPresets = new Set<string>();
  values.sources.forEach((draft, index) => {
    const base = `sources.${index}`;
    if (draft.type === 'preset') {
      if (!meta.sources.presets.some(preset => preset.id === draft.preset)) add(`${base}.preset`, 'Preset không hợp lệ.');
      if (seenPresets.has(draft.preset)) add(base, 'Nguồn này đã có trong danh sách.');
      seenPresets.add(draft.preset);
      return;
    }
    const specs = sourceFieldSpecs(meta, draft.type);
    if (!specs) {
      add(`${base}.type`, 'Loại nguồn không được hỗ trợ.');
      return;
    }
    for (const spec of specs) {
      const path = `${base}.config.${spec.key}`;
      if (spec.kind === 'jsonFields') {
        const filled = Object.values(draft.mapping).some(value => value.trim() !== '');
        if (!filled && spec.required) {
          add(path, REQUIRED);
          for (const nested of spec.fields ?? []) if (nested.required) add(`${path}.${nested.key}`, REQUIRED);
          continue;
        }
        for (const nested of spec.fields ?? []) add(`${path}.${nested.key}`, validateFieldValue(nested, draft.mapping[nested.key] ?? ''));
        continue;
      }
      add(path, validateFieldValue(spec, draft.values[spec.key] ?? ''));
    }
  });
}

function validateAi(values: ChannelFormValues, meta: Meta, add: (field: string, message: string | null) => void) {
  const rules = providerMeta(meta, values.ai.provider);
  if (!rules) {
    add('ai.provider', 'AI provider không hợp lệ.');
    return;
  }
  const model = values.ai.model.trim();
  if (model.length > meta.ai.modelMaxLength) add('ai.model', `Tối đa ${meta.ai.modelMaxLength} ký tự.`);
  else if (model !== '' && !new RegExp(meta.ai.modelPattern).test(model)) add('ai.model', 'Tên model không được chứa khoảng trắng hoặc ký tự ngoài ASCII.');
  if (rules.customName && values.ai.name.trim().length > meta.ai.nameMaxLength) add('ai.name', `Tối đa ${meta.ai.nameMaxLength} ký tự.`);
  if (rules.baseUrl !== 'none') {
    const baseUrl = values.ai.baseUrl.trim();
    if (baseUrl === '') {
      if (rules.baseUrl === 'required') add('ai.baseUrl', REQUIRED);
    } else if (baseUrl.length > meta.ai.baseUrlMaxLength) {
      add('ai.baseUrl', `Tối đa ${meta.ai.baseUrlMaxLength} ký tự.`);
    } else if (!isHttpUrl(baseUrl)) {
      add('ai.baseUrl', 'Phải là URL http:// hoặc https:// hợp lệ, không chứa thông tin đăng nhập.');
    }
  }
  if (rules.gateway && values.ai.useGateway) {
    for (const spec of rules.gateway.fields) {
      const key = spec.key as keyof ChannelFormValues['ai']['gateway'];
      add(`ai.gateway.${spec.key}`, validateFieldValue(spec, values.ai.gateway[key] ?? ''));
    }
  }
}

// ---------------------------------------------------------------------------
// Error paths

/** Whether a field error belongs to the sources section (indexes shift when sources move). */
export function isSourcePath(path: string): boolean {
  return path === 'sources' || path.startsWith('sources.');
}
