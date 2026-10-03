import { describe, expect, it } from 'vitest';

import { META, channelRecord } from '../../test/fixtures';
import {
  createEmptyForm,
  emptySourceDraft,
  formToConfig,
  recordToForm,
  toCreateInput,
  toUpdateInput,
  validateChannelForm,
  type ChannelFormValues,
} from './channel-form-model';

function validNewForm(): ChannelFormValues {
  const values = createEmptyForm(META);
  return {
    ...values,
    id: 'telegram-ai',
    name: 'Telegram AI',
    sources: [emptySourceDraft('preset', 'aiNewsSources')],
    prompt: { ...values.prompt, audience: 'Kỹ sư AI' },
  };
}

describe('validateChannelForm', () => {
  it('accepts a complete new channel', () => {
    expect(validateChannelForm(validNewForm(), META, { isNew: true })).toEqual({});
  });

  it('reports every problem by API field path', () => {
    const values = validNewForm();
    const rss = emptySourceDraft('rss');
    rss.values = { id: 'Bad Id', feedUrl: 'ftp://example.test/feed', name: '' };
    const json = emptySourceDraft('json');
    json.values = { id: 'api', name: 'API', url: 'https://example.test/api.json', itemsPath: 'data..items' };
    json.mapping = { title: 'title' };
    const reddit = emptySourceDraft('reddit');
    reddit.values = { subreddit: 'r/programming', minUpvotes: '-1' };
    const errors = validateChannelForm({
      ...values,
      id: 'Telegram AI',
      name: '  ',
      cron: 'every minute',
      timezone: 'Mars/Olympus',
      sources: [...values.sources, emptySourceDraft('preset', 'aiNewsSources'), rss, json, reddit],
      prompt: { ...values.prompt, audience: '', customSystemPrompt: 'x'.repeat(META.prompt.customSystemPromptMaxLength + 1) },
      ai: { ...values.ai, provider: 'custom', baseUrl: '', model: 'has space' },
      limits: { ...values.limits, dailyLimit: '0', delayMs: '1.5', batchSize: '' },
    }, META, { isNew: true });

    expect(Object.keys(errors).sort()).toEqual([
      'ai.baseUrl',
      'ai.model',
      'cron',
      'id',
      'limits.batchSize',
      'limits.dailyLimit',
      'limits.delayMs',
      'name',
      'prompt.audience',
      'prompt.customSystemPrompt',
      'sources.1',
      'sources.2.config.feedUrl',
      'sources.2.config.id',
      'sources.2.config.name',
      'sources.3.config.fields.url',
      'sources.3.config.itemsPath',
      'sources.4.config.minUpvotes',
      'sources.4.config.subreddit',
      'timezone',
    ]);
    expect(errors['limits.dailyLimit']).toBe('Phải từ 1 đến 500.');
    expect(errors['sources.1']).toBe('Nguồn này đã có trong danh sách.');
  });

  it('requires at least one enabled source on an enabled channel', () => {
    expect(validateChannelForm({ ...validNewForm(), sources: [] }, META, { isNew: true }).sources).toBe('Cần ít nhất một nguồn.');
    const disabled = { ...emptySourceDraft('preset', 'aiNewsSources'), enabled: false };
    expect(validateChannelForm({ ...validNewForm(), sources: [disabled] }, META, { isNew: true }).sources)
      .toBe('Kênh đang bật cần ít nhất một nguồn đang bật.');
    expect(validateChannelForm({ ...validNewForm(), enabled: false, sources: [disabled] }, META, { isNew: true })).toEqual({});
  });

  it('checks gateway fields only while the gateway is used', () => {
    const values = validNewForm();
    const gemini = { ...values.ai, provider: 'gemini', useGateway: true, gateway: { accountId: '', gatewayId: 'bad id!', byokAlias: '', tokenCredentialId: '' } };
    expect(validateChannelForm({ ...values, ai: gemini }, META, { isNew: true })).toEqual({
      'ai.gateway.accountId': 'Bắt buộc.',
      'ai.gateway.gatewayId': 'Sai định dạng.',
    });
    expect(validateChannelForm({ ...values, ai: { ...gemini, useGateway: false } }, META, { isNew: true })).toEqual({});
  });
});

describe('payloads', () => {
  it('builds the create body with normalized values and nulls for empty optionals', () => {
    const values = validNewForm();
    const rss = emptySourceDraft('rss');
    rss.values = { id: 'feed', name: ' Feed ', feedUrl: 'https://example.test/rss', icon: '', category: '' };
    const hn = emptySourceDraft('hackernews');
    hn.values = { query: 'rust', minPoints: '100', filter: '' };
    const input = toCreateInput({
      ...values,
      cron: '  0   7-22 * * * ',
      notBefore: '2026-10-03T00:00:00.000Z',
      sources: [...values.sources, rss, { ...hn, enabled: false }],
      ai: { ...values.ai, provider: 'claude', model: ' claude-sonnet ', apiKeyCredentialId: 'cred-ai', name: 'ignored', baseUrl: 'https://ignored.test' },
      telegram: { botTokenCredentialId: 'cred-bot', chatIdCredentialId: '' },
    }, META);

    expect(input).toEqual({
      id: 'telegram-ai',
      name: 'Telegram AI',
      enabled: true,
      mode: 'drip',
      cron: '0 7-22 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      notBefore: '2026-10-03T00:00:00.000Z',
      sources: [
        { type: 'preset', preset: 'aiNewsSources', enabled: true },
        { type: 'rss', enabled: true, config: { id: 'feed', name: 'Feed', feedUrl: 'https://example.test/rss' } },
        { type: 'hackernews', enabled: false, config: { query: 'rust', minPoints: 100 } },
      ],
      prompt: { language: 'vi', style: 'digest', audience: 'Kỹ sư AI', customSystemPrompt: null },
      ai: { provider: 'claude', model: 'claude-sonnet', name: null, baseUrl: null, apiKeyCredentialId: 'cred-ai', gateway: null },
      telegram: { botTokenCredentialId: 'cred-bot', chatIdCredentialId: null },
      limits: META.limits.defaults,
    });
  });

  it('drops the API key for Gemini through the gateway and keeps the gateway settings', () => {
    const values = validNewForm();
    const config = formToConfig({
      ...values,
      ai: {
        ...values.ai,
        provider: 'gemini',
        apiKeyCredentialId: 'cred-ai',
        useGateway: true,
        gateway: { accountId: ' acc ', gatewayId: 'gw', byokAlias: '', tokenCredentialId: 'cred-gateway' },
      },
    }, META);
    expect(config.ai).toEqual({
      provider: 'gemini',
      model: null,
      name: null,
      baseUrl: null,
      apiKeyCredentialId: null,
      gateway: { accountId: 'acc', gatewayId: 'gw', byokAlias: null, tokenCredentialId: 'cred-gateway' },
    });
  });

  it('sends the JSON source mapping as a nested fields object', () => {
    const json = emptySourceDraft('json');
    json.values = { id: 'api', name: 'API', url: 'https://example.test/api.json', itemsPath: 'data.items' };
    json.mapping = { title: 'headline', url: 'link', author: '', publishedAt: 'meta.date' };
    const config = formToConfig({ ...validNewForm(), sources: [json] }, META);
    expect(config.sources).toEqual([{
      type: 'json',
      enabled: true,
      config: {
        id: 'api',
        name: 'API',
        url: 'https://example.test/api.json',
        itemsPath: 'data.items',
        fields: { title: 'headline', url: 'link', publishedAt: 'meta.date' },
      },
    }]);
  });

  it('round-trips a stored record without losing data and sends the base version on update', () => {
    const record = channelRecord({
      notBefore: '2026-10-02T17:00:30.000Z',
      sources: [
        { type: 'preset', preset: 'bigTechBlogs', enabled: true },
        { type: 'json', enabled: false, config: { id: 'api', name: 'API', url: 'https://example.test/a.json', fields: { title: 't', url: 'u' }, futureKey: 'kept' } },
      ],
      prompt: { language: 'en', style: 'bullet', audience: 'Devs', customSystemPrompt: 'Viết ngắn gọn.' },
    });
    const update = toUpdateInput(recordToForm(record, META), META, record.version);
    const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, updatedBy: _updatedBy, platform: _platform, ...expected } = record;
    expect(update).toEqual({ version: 3, ...expected });
  });
});
