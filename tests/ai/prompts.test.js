import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeAI } from '../../src/ai/claude.js';
import { OpenAICompatibleAI } from '../../src/ai/openai-compat.js';
import { buildHookPrompt, buildPromptForDelivery } from '../../src/ai/_prompts.js';

const article = {
  title: 'Cloudflare introduces Agent Lee',
  source: 'Cloudflare',
  url: 'https://example.test/agent-lee',
  content: 'Agent Lee combines Workers, KV, D1 and R2 for AI agent workflows.',
};

test('Telegram hook prompt requires a short title, summary, and source link', () => {
  const prompt = buildHookPrompt(article, { platform: 'telegram', style: 'digest' });

  assert.match(prompt.system, /Dòng đầu là tiêu đề bài viết/);
  assert.match(prompt.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.match(prompt.system, /không quá 700 ký tự/);
  assert.match(prompt.system, /Link gốc ở cuối/);
  assert.doesNotMatch(prompt.system, /3-5 câu/);
  assert.doesNotMatch(prompt.system, /Dan Tech Content Radar/);
});

test('X, Threads, and Facebook hook prompts sign posts with the Content Radar brand', () => {
  for (const platform of ['x', 'threads', 'facebook']) {
    const prompt = buildHookPrompt(article, { platform, style: 'digest' });

    assert.match(prompt.system, /End with "— Dan Tech Content Radar"/, platform);
    assert.doesNotMatch(prompt.system, /Daily News/, platform);
  }
});

test('digest prompt opens with the Content Radar header', () => {
  const prompt = buildPromptForDelivery([article], { deliveryMode: 'digest', platform: 'telegram' });

  assert.match(prompt.system, /📡 Dan Tech Content Radar - \[DD\/MM\/YYYY\]/);
  assert.doesNotMatch(prompt.system, /Daily Tech Digest/);
});

test('Telegram hot-take style still resolves to the concise news-summary contract', () => {
  const prompt = buildHookPrompt(article, { platform: 'telegram', style: 'hot_take' });

  assert.match(prompt.system, /Chỉ tóm tắt thông tin trong article/);
  assert.match(prompt.system, /Không thêm viewpoint, opinion/);
  assert.doesNotMatch(prompt.system, /Viết 1 post hot take/);
});

test('non-Telegram hook prompts keep their existing editorial structure', () => {
  const prompt = buildHookPrompt(article, { platform: 'facebook', style: 'digest' });

  assert.match(prompt.system, /3-5 câu/);
  assert.doesNotMatch(prompt.system, /không quá 700 ký tự/);
});

test('delivery prompt selector uses the concise hook only for one-article drip mode', () => {
  const drip = buildPromptForDelivery([article], { deliveryMode: 'drip', platform: 'telegram' });
  const digest = buildPromptForDelivery([article], { deliveryMode: 'digest', platform: 'telegram' });

  assert.match(drip.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.doesNotMatch(digest.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
});

test('bundled AI providers send the concise hook prompt for Telegram drip delivery', async () => {
  let claudeBody;
  const claude = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      claudeBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'summary' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    },
  });

  let openAIBody;
  const openAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      openAIBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'summary' } }],
      }), { status: 200 });
    },
  });

  const options = { deliveryMode: 'drip', platform: 'telegram', style: 'digest' };
  await claude.summarize([article], options);
  await openAI.summarize([article], options);

  assert.match(claudeBody.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.match(openAIBody.messages[0].content, /đúng 2-3 câu ngắn chỉ tóm tắt/);
});
