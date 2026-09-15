/**
 * Story dedup — decides whether two articles cover the same story across sources.
 * Deterministic and zero-dependency: canonical links, distinctive headline tokens, and
 * version-like anchors ("gpt-5.5", "ios 27"). Radar scans use it to skip stories that
 * were already delivered and to enqueue at most one take per story in a scan.
 *
 * Character-bigram title similarity is deliberately not used: rewritten headlines about
 * one launch score low, while different launches sharing a headline template score high.
 */

const TRACKING_PARAMS = /^(utm_.+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;
const MIN_SHARED_TOKENS = 3;
const MIN_SHARED_RATIO = 0.6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by',
  'with', 'without', 'about', 'as', 'into', 'onto', 'over', 'under', 'after', 'before', 'amid',
  'via', 'vs', 'versus', 'per', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his',
  'her', 'them', 'us', 'my', 'me', 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'should', 'may', 'might', 'must', 'has', 'have', 'had', 'than', 'then', 'so', 'if',
  'just', 'off', 'up', 'down', 'out', 'all', 'more', 'most',
]);

// Words that describe how a headline is written rather than what the story is about.
const HEADLINE_FILLER = new Set([
  'new', 'now', 'here', 'today', 'latest', 'finally', 'first', 'big', 'best', 'top', 'why', 'how',
  'what', 'when', 'where', 'who', 'which', 'launch', 'launches', 'launched', 'announce',
  'announces', 'announced', 'unveil', 'unveils', 'unveiled', 'release', 'releases', 'released',
  'introduce', 'introduces', 'introduced', 'introducing', 'reveal', 'reveals', 'revealed', 'say',
  'says', 'said', 'show', 'shows', 'showed', 'ask', 'hn', 'get', 'gets', 'add', 'adds', 'added',
  'support', 'supports', 'supported', 'bring', 'brings', 'land', 'lands', 'report', 'reports',
  'reported', 'update', 'updates', 'updated', 'look', 'looks', 'make', 'makes', 'use', 'uses',
  'using',
]);

/**
 * @param {{ title?: string, url?: string }} article
 * @returns {{ url: string|null, tokens: Set<string>, anchors: Set<string> }}
 */
export function storySignature(article) {
  const tokens = headlineTokens(article?.title);
  const anchors = new Set([...tokens].filter(isAnchor));
  return { url: canonicalUrl(article?.url), tokens, anchors };
}

/**
 * Same story when links match, when a version-like anchor and another distinctive token
 * are shared, or when most distinctive tokens of the shorter headline are shared.
 */
export function isSameStory(left, right) {
  if (left.url && left.url === right.url) return true;
  let sharedTokens = 0;
  let sharedAnchors = 0;
  for (const token of left.tokens) {
    if (!right.tokens.has(token)) continue;
    sharedTokens += 1;
    if (left.anchors.has(token)) sharedAnchors += 1;
  }
  if (sharedAnchors >= 1 && sharedTokens - sharedAnchors >= 1) return true;
  const smaller = Math.min(left.tokens.size, right.tokens.size);
  return sharedTokens >= MIN_SHARED_TOKENS && sharedTokens / smaller >= MIN_SHARED_RATIO;
}

/** Drop candidates that cover a story already present in `coveredArticles`. */
export function excludeCoveredStories(articles, coveredArticles) {
  const covered = coveredArticles.map(storySignature);
  return articles.filter(article => {
    const signature = storySignature(article);
    return !covered.some(existing => isSameStory(signature, existing));
  });
}

/** Keep the first article of each story, in order, up to `limit` articles. */
export function pickDistinctStories(articles, limit) {
  const picked = [];
  const signatures = [];
  for (const article of articles) {
    if (picked.length >= limit) break;
    const signature = storySignature(article);
    if (signatures.some(existing => isSameStory(signature, existing))) continue;
    picked.push(article);
    signatures.push(signature);
  }
  return picked;
}

function canonicalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const host = parsed.hostname.replace(/^(www|m)\./, '');
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : '';
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return `${parsed.protocol}//${host}${port}${path}${query}`;
}

function headlineTokens(title) {
  const tokens = new Set();
  const words = String(title ?? '').toLowerCase().replace(/[^a-z0-9.+\-'’]+/g, ' ').split(' ');
  for (const word of words) {
    const cleaned = word.replace(/['’]s$/, '').replace(/['’]/g, '').replace(/^[.-]+|[.-]+$/g, '');
    if (!cleaned) continue;
    // Version-like tokens stay whole ("gpt-5.5"); plain compounds split ("zero-day").
    const parts = /\d/.test(cleaned) ? [cleaned] : cleaned.split(/[.-]+/);
    for (const part of parts) {
      const token = /\d/.test(part) ? part : singular(part);
      if (token.length < 2 || isFiller(part) || isFiller(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function singular(word) {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function isFiller(word) {
  return STOPWORDS.has(word) || HEADLINE_FILLER.has(word);
}

function isAnchor(token) {
  return /\d/.test(token) && !/^\d$/.test(token) && !/^(19|20)\d{2}$/.test(token);
}
