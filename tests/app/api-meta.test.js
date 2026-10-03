import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildDashboardMeta } from '../../src/app/api/meta-routes.js';
import {
  AI_PROVIDERS,
  CHANNEL_ID_PATTERN,
  CREDENTIAL_KINDS,
  ChannelValidationError,
  DEFAULT_LIMITS,
  LIMIT_RANGES,
  validateChannelConfig,
} from '../../src/app/channels/config-schema.js';
import { PRESET_NAMES, SOURCE_TYPES } from '../../src/app/channels/source-factories.js';
import { startStubApp } from './helpers/stub-app.js';

const META = buildDashboardMeta();

/** A valid sample config per typed source that sets every field the meta lists. */
const SOURCE_SAMPLES = Object.freeze({
  rss: { id: 'meta-rss', name: 'Meta RSS', feedUrl: 'https://example.test/feed.xml', icon: '📰', category: 'AI/ML', baseUrl: 'https://example.test' },
  hackernews: { query: 'rust', filter: 'front_page', minPoints: 10 },
  reddit: { subreddit: 'programming', sort: 'top', minUpvotes: 5 },
  devto: { tag: 'rust', minReactions: 3 },
  'github-trending': { language: 'c++', since: 'weekly', minStars: 50 },
  html: { id: 'meta-html', name: 'Meta HTML', url: 'https://example.test/blog', icon: '🌐', category: 'Web' },
  json: {
    id: 'meta-json',
    name: 'Meta JSON',
    url: 'https://example.test/api.json',
    icon: '🔌',
    category: 'AI',
    itemsPath: 'data.items',
    fields: { title: 'title', url: 'link', id: 'id', content: 'body', publishedAt: 'published', author: 'author.name' },
  },
});

function channelInput(overrides = {}) {
  return {
    id: 'meta-check',
    name: 'Meta check',
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'UTC',
    sources: [{ type: 'preset', preset: 'bigTechBlogs', enabled: true }],
    prompt: { audience: 'Kỹ sư phần mềm' },
    ai: { provider: 'claude' },
    ...overrides,
  };
}

/** `[field, code]` pairs reported for the input (empty when it is valid). */
function issuesOf(input) {
  try {
    validateChannelConfig(input);
    return [];
  } catch (error) {
    if (!(error instanceof ChannelValidationError)) throw error;
    return error.issues.map(issue => [issue.field, issue.code]);
  }
}

function sourceIssues(type, config) {
  return issuesOf(channelInput({ sources: [{ type, enabled: true, config }] }));
}

function aiIssues(ai) {
  return issuesOf(channelInput({ ai }));
}

function without(object, key) {
  const { [key]: _removed, ...rest } = object;
  return rest;
}

test('GET /api/meta serves the frozen meta to viewers and operators only', async t => {
  const app = await startStubApp(t);
  const viewer = await app.api('/api/meta', { as: 'viewer' });
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(viewer.headers['cache-control'], 'no-store');
  assert.deepEqual(viewer.body, JSON.parse(JSON.stringify(META)));
  assert.equal((await app.api('/api/meta', { as: 'operator' })).status, 200);

  const anonymous = await app.api('/api/meta');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'unauthenticated');
  const unmapped = await app.api('/api/meta', { as: 'unmapped' });
  assert.equal(unmapped.status, 403);
  assert.equal(unmapped.body.error, 'forbidden');
  assert.equal(Object.isFrozen(META.sources.types[0].fields[0]), true);
});

test('the dashboard unit-test fixture is the meta the API serves', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../web/src/test/meta-fixture.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    fixture,
    JSON.parse(JSON.stringify(META)),
    'web/src/test/meta-fixture.json is stale; regenerate it from buildDashboardMeta() (src/app/api/meta-routes.js)',
  );
});

test('meta enumerations come from the validating modules', () => {
  assert.deepEqual(META.channel.modes, ['digest', 'drip']);
  assert.equal(META.channel.idPattern, CHANNEL_ID_PATTERN.source);
  assert.deepEqual(META.sources.presets.map(preset => preset.id), PRESET_NAMES);
  for (const preset of META.sources.presets) {
    assert.ok(preset.sources.length > 0, `${preset.id} lists its sources`);
    for (const source of preset.sources) assert.ok(source.id && source.name, `${preset.id} source has an id and a name`);
  }
  assert.deepEqual(META.sources.types.map(entry => entry.type), SOURCE_TYPES.filter(type => type !== 'preset'));
  assert.deepEqual(META.ai.providers.map(provider => provider.id), AI_PROVIDERS);
  assert.deepEqual(META.credentials.kinds, CREDENTIAL_KINDS);
  assert.deepEqual(
    META.limits.ranges,
    Object.fromEntries(Object.entries(LIMIT_RANGES).map(([key, [min, max]]) => [key, { min, max }])),
  );
  assert.deepEqual(META.limits.defaults, DEFAULT_LIMITS);
  assert.ok(META.controls.actions.includes('pause') && META.controls.actions.includes('resume'));
  assert.ok(META.content.statuses.includes('delivered'));
  assert.deepEqual(META.content.dateFields, ['seen', 'published', 'delivered']);
});

test('every typed-source field spec matches what channel validation accepts', () => {
  assert.deepEqual(Object.keys(SOURCE_SAMPLES).sort(), META.sources.types.map(entry => entry.type).sort());
  for (const { type, fields } of META.sources.types) {
    const sample = SOURCE_SAMPLES[type];
    assert.deepEqual(fields.map(spec => spec.key).sort(), Object.keys(sample).sort(), `${type}: the sample covers every spec field`);
    assert.deepEqual(sourceIssues(type, sample), [], `${type}: a config with every field is valid`);
    assert.deepEqual(sourceIssues(type, { ...sample, surprise: 'x' }), [['sources.0.config.surprise', 'unknown_field']]);

    for (const spec of fields) {
      const path = `sources.0.config.${spec.key}`;
      assert.deepEqual(
        sourceIssues(type, without(sample, spec.key)),
        spec.required ? [[path, 'required']] : [],
        `${type}.${spec.key}: required=${spec.required}`,
      );
      if (spec.pattern) {
        assert.ok(new RegExp(spec.pattern).test(sample[spec.key]), `${type}.${spec.key}: the sample matches the pattern`);
        assert.equal(new RegExp(spec.pattern).test('Not Valid!'), false, `${type}.${spec.key}: the meta pattern rejects what the server rejects`);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'Not Valid!' }), [[path, 'invalid_format']], `${type}.${spec.key}: pattern`);
      }
      if (spec.maxLength && spec.kind !== 'url' && spec.kind !== 'jsonFields') {
        // Both directions: exactly maxLength passes, one more fails.
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'a'.repeat(spec.maxLength) }), [], `${type}.${spec.key}: maxLength accepted`);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'a'.repeat(spec.maxLength + 1) }), [[path, 'too_long']], `${type}.${spec.key}: maxLength`);
      }
      if (spec.kind === 'url') {
        assert.equal(spec.maxLength, META.ai.baseUrlMaxLength);
        const prefix = 'https://example.test/';
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'ftp://example.test/feed' }), [[path, 'invalid_url']]);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: `${prefix}${'a'.repeat(spec.maxLength - prefix.length)}` }), []);
        assert.deepEqual(
          sourceIssues(type, { ...sample, [spec.key]: `${prefix}${'a'.repeat(spec.maxLength - prefix.length + 1)}` }),
          [[path, 'too_long']],
        );
      }
      if (spec.kind === 'integer') {
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: spec.min }), []);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: spec.max }), []);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: spec.min - 1 }), [[path, 'out_of_range']]);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: spec.max + 1 }), [[path, 'out_of_range']]);
      }
      if (spec.kind === 'enum') {
        for (const option of spec.options) assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: option }), [], `${type}.${spec.key}=${option}`);
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'bogus' }), [[path, 'invalid_value']]);
      }
      if (spec.kind === 'jsonPath') {
        assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: 'a..b' }), [[path, 'invalid_format']]);
      }
      if (spec.kind === 'jsonFields') {
        const mapping = sample[spec.key];
        assert.deepEqual(spec.fields.map(entry => entry.key).sort(), Object.keys(mapping).sort());
        for (const nested of spec.fields) {
          assert.deepEqual(
            sourceIssues(type, { ...sample, [spec.key]: without(mapping, nested.key) }),
            nested.required ? [[`${path}.${nested.key}`, 'required']] : [],
            `${type}.${spec.key}.${nested.key}: required=${nested.required}`,
          );
          assert.deepEqual(sourceIssues(type, { ...sample, [spec.key]: { ...mapping, [nested.key]: 'a'.repeat(nested.maxLength) } }), []);
          assert.deepEqual(
            sourceIssues(type, { ...sample, [spec.key]: { ...mapping, [nested.key]: 'a'.repeat(nested.maxLength + 1) } }),
            [[`${path}.${nested.key}`, 'too_long']],
          );
          assert.deepEqual(
            sourceIssues(type, { ...sample, [spec.key]: { ...mapping, [nested.key]: 'a..b' } }),
            [[`${path}.${nested.key}`, 'invalid_format']],
          );
        }
      }
    }
  }
});

test('AI provider rules match channel validation', () => {
  for (const provider of META.ai.providers) {
    const base = { provider: provider.id, ...(provider.baseUrl === 'required' ? { baseUrl: 'https://llm.example.test/v1' } : {}) };
    assert.deepEqual(aiIssues(base), [], `${provider.id}: minimal config is valid`);

    assert.deepEqual(
      aiIssues({ ...base, apiKeyCredentialId: 'credential-1' }),
      provider.apiKey === 'none' ? [['ai.apiKeyCredentialId', 'not_applicable']] : [],
      `${provider.id}: apiKey=${provider.apiKey}`,
    );
    if (provider.baseUrl === 'required') {
      assert.deepEqual(aiIssues(without(base, 'baseUrl')), [['ai.baseUrl', 'required']]);
    } else {
      assert.deepEqual(
        aiIssues({ ...base, baseUrl: 'https://llm.example.test/v1' }),
        provider.baseUrl === 'optional' ? [] : [['ai.baseUrl', 'not_applicable']],
        `${provider.id}: baseUrl=${provider.baseUrl}`,
      );
    }
    assert.deepEqual(
      aiIssues({ ...base, name: 'Display name' }),
      provider.customName ? [] : [['ai.name', 'not_applicable']],
      `${provider.id}: customName=${provider.customName}`,
    );

    const gateway = { accountId: 'account_1', gatewayId: 'gateway-1', byokAlias: 'alias.1' };
    if (!provider.gateway) {
      assert.deepEqual(aiIssues({ ...base, gateway }), [['ai.gateway', 'not_applicable']], `${provider.id}: no gateway`);
      continue;
    }
    assert.deepEqual(aiIssues({ ...base, gateway }), []);
    assert.deepEqual(
      aiIssues({ ...base, gateway, apiKeyCredentialId: 'credential-1' }),
      provider.gateway.apiKey === 'none' ? [['ai.apiKeyCredentialId', 'not_applicable']] : [],
    );
    assert.equal(provider.gateway.tokenRequired, true);
    for (const spec of provider.gateway.fields) {
      const path = `ai.gateway.${spec.key}`;
      assert.ok(new RegExp(spec.pattern).test(gateway[spec.key]));
      assert.equal(new RegExp(spec.pattern).test('not valid!'), false);
      assert.deepEqual(aiIssues({ ...base, gateway: { ...gateway, [spec.key]: 'a'.repeat(spec.maxLength) } }), []);
      assert.deepEqual(aiIssues({ ...base, gateway: without(gateway, spec.key) }), spec.required ? [[path, 'required']] : []);
      assert.deepEqual(aiIssues({ ...base, gateway: { ...gateway, [spec.key]: 'not valid!' } }), [[path, 'invalid_format']]);
      assert.deepEqual(aiIssues({ ...base, gateway: { ...gateway, [spec.key]: 'a'.repeat(spec.maxLength + 1) } }), [[path, 'too_long']]);
    }
  }
  assert.ok(new RegExp(META.ai.modelPattern).test('gemini-2.0-flash'));
  assert.equal(new RegExp(META.ai.modelPattern).test('claude sonnet'), false);
  assert.deepEqual(aiIssues({ provider: 'claude', model: 'a'.repeat(META.ai.modelMaxLength) }), []);
  assert.deepEqual(aiIssues({ provider: 'claude', model: 'claude sonnet' }), [['ai.model', 'invalid_format']]);
  assert.deepEqual(aiIssues({ provider: 'claude', model: 'a'.repeat(META.ai.modelMaxLength + 1) }), [['ai.model', 'too_long']]);
  assert.deepEqual(aiIssues({ provider: 'custom', baseUrl: 'https://llm.example.test', name: 'a'.repeat(META.ai.nameMaxLength + 1) }), [['ai.name', 'too_long']]);
});

test('channel and prompt bounds and defaults match channel validation', () => {
  const normalized = validateChannelConfig(channelInput());
  assert.equal(normalized.prompt.language, META.prompt.defaultLanguage);
  assert.equal(normalized.prompt.style, META.prompt.defaultStyle);
  assert.deepEqual(issuesOf(channelInput({ name: 'a'.repeat(META.channel.nameMaxLength) })), []);
  assert.deepEqual(issuesOf(channelInput({ name: 'a'.repeat(META.channel.nameMaxLength + 1) })), [['name', 'too_long']]);
  assert.deepEqual(issuesOf(channelInput({ id: 'a'.repeat(META.channel.idMaxLength) })), []);
  assert.deepEqual(issuesOf(channelInput({ id: 'a'.repeat(META.channel.idMaxLength + 1) })), [['id', 'too_long']]);
  assert.equal(new RegExp(META.channel.idPattern).test('Bad Id'), false);
  assert.deepEqual(issuesOf(channelInput({ id: 'Bad Id' })), [['id', 'invalid_format']]);
  const longCron = `${Array.from({ length: 60 }, (_, minute) => minute).join(',')} * * * *`;
  assert.ok(longCron.length > META.channel.cronMaxLength);
  assert.deepEqual(issuesOf(channelInput({ cron: longCron })), [['cron', 'too_long']]);
  assert.deepEqual(issuesOf(channelInput({ prompt: { audience: 'a'.repeat(META.prompt.audienceMaxLength) } })), []);
  assert.deepEqual(
    issuesOf(channelInput({ prompt: { audience: 'a'.repeat(META.prompt.audienceMaxLength + 1) } })),
    [['prompt.audience', 'too_long']],
  );
  assert.deepEqual(issuesOf(channelInput({ prompt: { audience: 'Dev', customSystemPrompt: 'a'.repeat(META.prompt.customSystemPromptMaxLength) } })), []);
  assert.deepEqual(
    issuesOf(channelInput({ prompt: { audience: 'Dev', customSystemPrompt: 'a'.repeat(META.prompt.customSystemPromptMaxLength + 1) } })),
    [['prompt.customSystemPrompt', 'too_long']],
  );
  for (const language of META.prompt.languages) {
    assert.deepEqual(issuesOf(channelInput({ prompt: { audience: 'Dev', language } })), []);
  }
  for (const style of META.prompt.styles) {
    assert.deepEqual(issuesOf(channelInput({ prompt: { audience: 'Dev', style } })), []);
  }
});
