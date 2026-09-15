/**
 * Tech relevance middleware — keeps Content Radar focused on technology content.
 * Articles from curated engineering and AI-lab categories pass unchanged; every other
 * article needs technology signals that outweigh off-topic signals. This is a topic
 * filter, not a trust boundary: it never judges whether a linked page is safe.
 * Zero dependencies. Usage: engine.use(createTechRelevanceMiddleware()) before scoring.
 */

/** Categories assigned by curated presets; matched exactly, never inferred from article text. */
export const TRUSTED_TECH_CATEGORIES = Object.freeze([
  'Big Tech', 'Cloud', 'Developer Tools', 'AI/ML', 'AI Deep-Dive',
  'DevOps', 'Mobile', 'Web Platform', 'Fintech', 'E-commerce',
]);

const TECH_TERMS = Object.freeze([
  // AI and models
  'ai', 'artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'llm',
  'gpt', 'chatgpt', 'genai', 'generative ai', 'chatbot', 'deepfake', 'ai model', 'language model',
  'reasoning model', 'diffusion model', 'open-weight', 'model weights', 'fine-tuning', 'fine-tune',
  'pretraining', 'inference', 'benchmark', 'dataset', 'transformer', 'embedding', 'vector database',
  'agentic', 'ai agent', 'coding agent', 'robot', 'robotics', 'humanoid',
  // Vendors, products, and platforms
  'openai', 'anthropic', 'claude', 'gemini', 'deepmind', 'hugging face', 'llama', 'qwen', 'deepseek',
  'mistral', 'grok', 'copilot', 'siri', 'alexa', 'nvidia', 'amd', 'intel', 'tsmc', 'qualcomm',
  'microsoft', 'google', 'apple', 'amazon', 'aws', 'azure', 'gcp', 'cloudflare', 'vercel', 'github',
  'gitlab', 'ollama', 'tokio',
  // Software engineering
  'software', 'hardware', 'firmware', 'open source', 'open-source', 'self-hosted', 'self-hosting',
  'api', 'sdk', 'cli', 'compiler', 'runtime', 'kernel', 'linux', 'macos', 'ios', 'android', 'chrome',
  'firefox', 'browser', 'app', 'smartphone', 'iphone', 'programming', 'programmer', 'developer',
  'software engineer', 'source code', 'codebase', 'code review', 'pull request', 'git', 'javascript',
  'typescript', 'python', 'rust', 'golang', 'java', 'kotlin', 'c++', 'webassembly', 'wasm', 'react',
  'node.js', 'deno', 'database', 'postgres', 'postgresql', 'mysql', 'sqlite', 'redis', 'sql',
  'distributed system', 'microservice', 'algorithm', 'encryption',
  // Infrastructure and hardware
  'cloud', 'kubernetes', 'docker', 'serverless', 'devops', 'data center', 'datacenter', 'gpu', 'cpu',
  'npu', 'chip', 'chipmaker', 'semiconductor', 'processor', 'quantum computing', 'quantum computer',
  'supercomputer',
  // Security
  'cybersecurity', 'vulnerability', 'vulnerabilities', 'cve', 'exploit', 'zero-day', 'malware',
  'ransomware', 'phishing', 'data breach', 'hacker', 'security patch', 'patch release',
  'patch tuesday', 'vpn', 'passkey',
]);

const OFF_TOPIC_TERMS = Object.freeze([
  'election', 'senate', 'senator', 'congressman', 'congresswoman', 'congressional', 'lawmaker',
  'politics', 'political', 'politician', 'democrat', 'republican', 'celebrity', 'celebrities',
  'gossip', 'kardashian', 'royal family', 'wedding', 'dating', 'fashion', 'recipe', 'horoscope',
  'astrology', 'zodiac', 'sports', 'football', 'soccer', 'nba', 'nfl', 'world cup', 'olympics',
  'gift guide', 'black friday', 'cyber monday', 'best deals', 'coupon', 'discount code', 'memecoin',
  'meme coin', 'meme', 'price prediction', 'to the moon', 'shitpost',
]);

const DEFAULT_MIN_TECH_SCORE = 2;
const TITLE_WEIGHT = 2;
const CONTENT_WEIGHT = 1;
const CONTENT_SCAN_LIMIT = 2_000;

const TECH_MATCHER = termMatcher(TECH_TERMS);
const OFF_TOPIC_MATCHER = termMatcher(OFF_TOPIC_TERMS);

/**
 * Score one article for technology relevance.
 * Each distinct term counts once: TITLE_WEIGHT when it appears in the title, otherwise
 * CONTENT_WEIGHT when it appears in the first CONTENT_SCAN_LIMIT characters of content.
 * @param {import('./contracts.js').Article} article
 * @param {Object} [options]
 * @param {readonly string[]} [options.trustedCategories=TRUSTED_TECH_CATEGORIES]
 * @param {number} [options.minTechScore=2]
 * @returns {{ trusted: boolean, techScore: number, offTopicScore: number, titleTechHits: number, relevant: boolean }}
 */
export function scoreTechRelevance(article, options = {}) {
  const { trustedCategories, minTechScore } = normalizeOptions(options);
  const trusted = typeof article?.category === 'string' && trustedCategories.includes(article.category);
  const title = String(article?.title ?? '');
  const content = String(article?.content ?? '').slice(0, CONTENT_SCAN_LIMIT);
  const tech = weightedTerms(TECH_MATCHER, title, content);
  const offTopic = weightedTerms(OFF_TOPIC_MATCHER, title, content);
  // An off-topic headline needs its technology signal in the title, not only in the body.
  const relevant = trusted || (
    tech.score >= minTechScore
    && tech.score > offTopic.score
    && (offTopic.score === 0 || tech.titleHits > 0)
  );
  return {
    trusted,
    techScore: tech.score,
    offTopicScore: offTopic.score,
    titleTechHits: tech.titleHits,
    relevant,
  };
}

/**
 * Create a middleware that drops articles without clear technology relevance.
 * @param {Object} [options]
 * @param {readonly string[]} [options.trustedCategories=TRUSTED_TECH_CATEGORIES]
 * @param {number} [options.minTechScore=2]
 * @returns {(articles: Article[]) => Article[]}
 */
export function createTechRelevanceMiddleware(options = {}) {
  const normalized = normalizeOptions(options);
  const middleware = articles => articles.filter(article => scoreTechRelevance(article, normalized).relevant);
  middleware.label = 'tech-relevance';
  middleware.selectionKey = JSON.stringify([
    'tech-relevance',
    [...normalized.trustedCategories].sort(),
    normalized.minTechScore,
    TECH_TERMS,
    OFF_TOPIC_TERMS,
  ]);
  return middleware;
}

function normalizeOptions({ trustedCategories = TRUSTED_TECH_CATEGORIES, minTechScore = DEFAULT_MIN_TECH_SCORE } = {}) {
  if (!Array.isArray(trustedCategories) || trustedCategories.some(value => typeof value !== 'string' || !value)) {
    throw new Error('trustedCategories must be an array of non-empty strings');
  }
  if (!Number.isSafeInteger(minTechScore) || minTechScore < 1) {
    throw new Error('minTechScore must be a positive integer');
  }
  return { trustedCategories, minTechScore };
}

function weightedTerms(matcher, title, content) {
  const titleTerms = matchedTerms(matcher, title);
  let score = titleTerms.size * TITLE_WEIGHT;
  for (const term of matchedTerms(matcher, content)) {
    if (!titleTerms.has(term)) score += CONTENT_WEIGHT;
  }
  return { score, titleHits: titleTerms.size };
}

function matchedTerms(matcher, text) {
  const terms = new Set();
  for (const match of text.matchAll(matcher)) terms.add(match[1].toLowerCase());
  return terms;
}

/**
 * One case-insensitive alternation per lexicon. Terms may take a plural or inflected
 * suffix and may be followed by digits (for example "Qwen3.5" or "GPUs"), but never
 * match inside a longer word ("Rustic", "said").
 */
function termMatcher(terms) {
  const alternation = [...terms]
    .sort((left, right) => right.length - left.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`(?<![a-z0-9])(${alternation})(?:s|es|ed|ing)?(?![a-z])`, 'gi');
}
