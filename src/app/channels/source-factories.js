/**
 * Source entries stored in channel config and the plugins built from them.
 * An entry is either a preset bundle (`{ type: 'preset', preset, enabled }`)
 * or one typed source (`{ type, enabled, config }`). Plugin constructors only
 * store their config, so entries can be expanded during validation to check
 * source identity without any network access.
 */

import {
  aiDeepDiveSources,
  aiMLBlogs,
  aiNewsSources,
  bigTechBlogs,
  communitySources,
  devopsSources,
  mobileSources,
} from '../../presets/index.js';
import {
  DevToSource,
  GitHubTrendingSource,
  HackerNewsSource,
  HTMLScraperSource,
  JSONAPISource,
  RedditSource,
  RSSSource,
  cleanHTML,
} from '../../sources/index.js';
import {
  fieldPath,
  readBoolean,
  readEnum,
  readHttpUrl,
  readInteger,
  readObject,
  readString,
} from './validation.js';

/** Every preset bundle exported by `src/presets/index.js`, by factory name. */
export const PRESET_FACTORIES = Object.freeze({
  bigTechBlogs,
  communitySources,
  aiMLBlogs,
  aiNewsSources,
  aiDeepDiveSources,
  devopsSources,
  mobileSources,
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESET_FACTORIES));
export const MAX_SOURCE_ENTRIES = 50;

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE_ID_MESSAGE = 'Chỉ dùng chữ thường, số, "-" hoặc "_", tối đa 64 ký tự.';
const JSON_PATH_PATTERN = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){0,9}$/;
const JSON_PATH_MESSAGE = 'Đường dẫn dạng a.b.c (chữ, số, "_", "-", "$"; tối đa 10 cấp).';
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const JSON_FIELD_KEYS = Object.freeze(['title', 'url', 'id', 'content', 'publishedAt', 'author']);
const MAX_NAME_LENGTH = 100;
const MAX_ICON_LENGTH = 16;
const MAX_CATEGORY_LENGTH = 64;

const TYPED_SOURCES = Object.freeze({
  rss: {
    keys: ['id', 'name', 'feedUrl', 'icon', 'category', 'baseUrl'],
    normalize: (issues, config, field) => compact({
      ...readIdentity(issues, config, field),
      feedUrl: readHttpUrl(issues, config.feedUrl, fieldPath(field, 'feedUrl'), { required: true }),
      ...readPresentation(issues, config, field),
      baseUrl: readHttpUrl(issues, config.baseUrl, fieldPath(field, 'baseUrl')),
    }),
    create: config => new RSSSource({ ...config }),
  },
  hackernews: {
    keys: ['query', 'filter', 'minPoints'],
    normalize: (issues, config, field) => compact({
      query: readString(issues, config.query, fieldPath(field, 'query'), { max: 200 }),
      filter: readEnum(issues, config.filter, fieldPath(field, 'filter'), ['front_page']),
      minPoints: readInteger(issues, config.minPoints, fieldPath(field, 'minPoints'), { min: 0, max: 100_000 }),
    }),
    create: config => new HackerNewsSource({ ...config }),
  },
  reddit: {
    keys: ['subreddit', 'sort', 'minUpvotes'],
    normalize: (issues, config, field) => compact({
      subreddit: readString(issues, config.subreddit, fieldPath(field, 'subreddit'), {
        required: true,
        max: 21,
        pattern: /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/,
        patternMessage: 'Tên subreddit chỉ gồm chữ, số và "_" (2-21 ký tự), không có "r/".',
      }),
      sort: readEnum(issues, config.sort, fieldPath(field, 'sort'), ['hot', 'new', 'top', 'rising']),
      minUpvotes: readInteger(issues, config.minUpvotes, fieldPath(field, 'minUpvotes'), { min: 0, max: 1_000_000 }),
    }),
    create: config => new RedditSource({ ...config }),
  },
  devto: {
    keys: ['tag', 'minReactions'],
    normalize: (issues, config, field) => compact({
      tag: readString(issues, config.tag, fieldPath(field, 'tag'), {
        max: 30,
        pattern: /^[a-z0-9]{1,30}$/,
        patternMessage: 'Tag Dev.to chỉ gồm chữ thường và số.',
      }),
      minReactions: readInteger(issues, config.minReactions, fieldPath(field, 'minReactions'), { min: 0, max: 1_000_000 }),
    }),
    create: config => new DevToSource({ ...config }),
  },
  'github-trending': {
    keys: ['language', 'since', 'minStars'],
    normalize: (issues, config, field) => compact({
      language: readString(issues, config.language, fieldPath(field, 'language'), {
        max: 50,
        pattern: /^[A-Za-z0-9+#._-]{1,50}$/,
        patternMessage: 'Tên ngôn ngữ chỉ gồm chữ, số và + # . _ -, không có khoảng trắng.',
      }),
      since: readEnum(issues, config.since, fieldPath(field, 'since'), ['daily', 'weekly']),
      minStars: readInteger(issues, config.minStars, fieldPath(field, 'minStars'), { min: 0, max: 10_000_000 }),
    }),
    create: config => new GitHubTrendingSource({ ...config }),
  },
  html: {
    keys: ['id', 'name', 'url', 'icon', 'category'],
    normalize: (issues, config, field) => compact({
      ...readIdentity(issues, config, field),
      url: readHttpUrl(issues, config.url, fieldPath(field, 'url'), { required: true }),
      ...readPresentation(issues, config, field),
    }),
    create: config => new HTMLScraperSource({ ...config }),
  },
  json: {
    keys: ['id', 'name', 'url', 'icon', 'category', 'itemsPath', 'fields'],
    normalize: (issues, config, field) => compact({
      ...readIdentity(issues, config, field),
      url: readHttpUrl(issues, config.url, fieldPath(field, 'url'), { required: true }),
      ...readPresentation(issues, config, field),
      itemsPath: readJsonPath(issues, config.itemsPath, fieldPath(field, 'itemsPath')),
      fields: readJsonFields(issues, config.fields, fieldPath(field, 'fields')),
    }),
    create: config => new JSONAPISource({
      id: config.id,
      name: config.name,
      url: config.url,
      ...(config.icon && { icon: config.icon }),
      ...(config.category && { category: config.category }),
      transform: createJsonTransform(config),
    }),
  },
});

/** Source entry types accepted in channel config. */
export const SOURCE_TYPES = Object.freeze(['preset', ...Object.keys(TYPED_SOURCES)]);

/**
 * @typedef {{ type: 'preset', preset: string, enabled: boolean }
 *   | { type: string, enabled: boolean, config: Record<string, unknown> }} SourceEntry
 */

/**
 * Validate and normalize the ordered source list of a channel. Exact duplicate
 * entries and different sources sharing one source id are reported; identical
 * sources contributed by overlapping presets are allowed and built once.
 *
 * @param {import('./validation.js').IssueCollector} issues
 * @param {unknown} value
 * @param {string} [field='sources']
 * @returns {SourceEntry[]}
 */
export function normalizeSourceEntries(issues, value, field = 'sources') {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    issues.add(field, 'required', 'Cần ít nhất một nguồn.');
    return [];
  }
  if (!Array.isArray(value)) {
    issues.add(field, 'invalid_type', 'Phải là danh sách.');
    return [];
  }
  if (value.length > MAX_SOURCE_ENTRIES) {
    issues.add(field, 'too_many', `Tối đa ${MAX_SOURCE_ENTRIES} nguồn.`);
    return [];
  }
  const issueCount = issues.issues.length;
  const entries = value.map((entry, index) => normalizeSourceEntry(issues, entry, fieldPath(field, index)));
  if (issues.issues.length === issueCount) flagDuplicateSources(issues, entries, field);
  return entries;
}

/**
 * Build source plugins for normalized entries in order. Identical sources that
 * several presets contribute are kept once.
 * @param {SourceEntry[]} entries
 * @returns {import('../../core/contracts.js').SourcePlugin[]}
 */
export function createSourcePlugins(entries) {
  const { plugins, collisions } = collectSourcePlugins(entries);
  if (collisions.length > 0) {
    throw new Error(`Different sources share the same source id: ${[...new Set(collisions.map(item => item.sourceId))].join(', ')}`);
  }
  return plugins;
}

function normalizeSourceEntry(issues, entry, field) {
  const allowed = entry?.type === 'preset' ? ['type', 'preset', 'enabled'] : ['type', 'enabled', 'config'];
  const value = readObject(issues, entry, field, { allowed });
  if (!value) return undefined;
  const type = readEnum(issues, value.type, fieldPath(field, 'type'), SOURCE_TYPES, { required: true });
  const enabled = readBoolean(issues, value.enabled, fieldPath(field, 'enabled'), { defaultValue: true });
  if (type === 'preset') {
    const preset = readEnum(issues, value.preset, fieldPath(field, 'preset'), PRESET_NAMES, { required: true });
    return { type, preset, enabled };
  }
  if (!type) return undefined;
  const spec = TYPED_SOURCES[type];
  const configField = fieldPath(field, 'config');
  const config = readObject(issues, value.config ?? {}, configField, { allowed: spec.keys });
  return { type, enabled, config: config ? spec.normalize(issues, config, configField) : undefined };
}

function flagDuplicateSources(issues, entries, field) {
  const seen = new Set();
  const duplicates = new Set();
  entries.forEach((entry, index) => {
    const key = JSON.stringify(entry.type === 'preset' ? [entry.type, entry.preset] : [entry.type, entry.config]);
    if (seen.has(key)) {
      duplicates.add(index);
      issues.add(fieldPath(field, index), 'duplicate', 'Nguồn này đã có trong danh sách.');
    }
    seen.add(key);
  });
  for (const { index, sourceId } of collectSourcePlugins(entries).collisions) {
    if (duplicates.has(index)) continue;
    issues.add(
      fieldPath(field, index),
      'duplicate_source_id',
      `ID nguồn "${sourceId}" trùng với một nguồn khác trong danh sách.`,
    );
  }
}

function collectSourcePlugins(entries) {
  const sourceKeys = new Map();
  const plugins = [];
  const collisions = [];
  entries.forEach((entry, index) => {
    const created = entry.type === 'preset'
      ? PRESET_FACTORIES[entry.preset]()
      : [TYPED_SOURCES[entry.type].create(entry.config)];
    for (const plugin of created) {
      const known = sourceKeys.get(plugin.id);
      if (known === undefined) {
        sourceKeys.set(plugin.id, plugin.sourceKey);
        plugins.push(plugin);
      } else if (known !== plugin.sourceKey) {
        collisions.push({ index, sourceId: plugin.id });
      }
    }
  });
  return { plugins, collisions };
}

function readIdentity(issues, config, field) {
  return {
    id: readString(issues, config.id, fieldPath(field, 'id'), {
      required: true,
      max: 64,
      pattern: SOURCE_ID_PATTERN,
      patternMessage: SOURCE_ID_MESSAGE,
    }),
    name: readString(issues, config.name, fieldPath(field, 'name'), { required: true, max: MAX_NAME_LENGTH }),
  };
}

function readPresentation(issues, config, field) {
  return {
    icon: readString(issues, config.icon, fieldPath(field, 'icon'), { max: MAX_ICON_LENGTH }),
    category: readString(issues, config.category, fieldPath(field, 'category'), { max: MAX_CATEGORY_LENGTH }),
  };
}

function readJsonPath(issues, value, field, { required = false } = {}) {
  const path = readString(issues, value, field, {
    required,
    max: 200,
    pattern: JSON_PATH_PATTERN,
    patternMessage: JSON_PATH_MESSAGE,
  });
  if (typeof path === 'string' && path.split('.').some(segment => UNSAFE_PATH_SEGMENTS.has(segment))) {
    return issues.add(field, 'invalid_format', JSON_PATH_MESSAGE);
  }
  return path;
}

function readJsonFields(issues, value, field) {
  const fields = readObject(issues, value, field, { allowed: JSON_FIELD_KEYS });
  if (!fields) return undefined;
  return compact(Object.fromEntries(JSON_FIELD_KEYS.map(key => [
    key,
    readJsonPath(issues, fields[key], fieldPath(field, key), { required: key === 'title' || key === 'url' }),
  ])));
}

// Maps a JSON API response to articles with the declarative `fields` paths.
// Items without a title or URL are skipped; a missing item list is an
// invalid source shape (JSONAPISource reports a thrown transform as such).
function createJsonTransform({ name, category, icon, itemsPath, fields }) {
  return data => {
    const items = itemsPath ? valueAt(data, itemsPath) : data;
    if (!Array.isArray(items)) throw new TypeError('JSON source response has no item list');
    const articles = [];
    for (const item of items) {
      const title = cleanHTML(textAt(item, fields.title) ?? '');
      const url = textAt(item, fields.url);
      if (!title || !url) continue;
      const author = fields.author ? textAt(item, fields.author) : undefined;
      articles.push({
        id: (fields.id && textAt(item, fields.id)) || url,
        title,
        url,
        content: fields.content ? cleanHTML(textAt(item, fields.content) ?? '').substring(0, 1000) : '',
        source: name,
        ...(category && { category }),
        ...(author && { author }),
        publishedAt: fields.publishedAt ? dateAt(item, fields.publishedAt) : null,
        meta: { icon: icon || '🔌' },
      });
    }
    return articles;
  };
}

function valueAt(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function textAt(value, path) {
  const found = valueAt(value, path);
  if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  if (typeof found !== 'string') return undefined;
  const text = found.trim();
  return text === '' ? undefined : text;
}

function dateAt(value, path) {
  const found = valueAt(value, path);
  let date = null;
  if (typeof found === 'string' && found.trim() !== '') date = new Date(found);
  // Numeric timestamps below 1e12 are Unix seconds, larger ones milliseconds.
  if (typeof found === 'number' && Number.isFinite(found)) date = new Date(found < 1e12 ? found * 1_000 : found);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}
