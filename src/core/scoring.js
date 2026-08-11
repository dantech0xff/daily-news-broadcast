/**
 * Article scoring middleware — ranks articles by engagement, recency, and source credibility
 * Usage: engine.use(createScoringMiddleware({ maxArticles: 20 }))
 */

const DEFAULT_CREDIBILITY = {
  'Big Tech': 30,
  'Cloud': 25,
  'Developer Tools': 25,
  'AI/ML': 25,
  'AI News': 25,
  'Fintech': 20,
  'E-commerce': 20,
  'Web Platform': 20,
  'Open Source': 20,
  'Mobile': 20,
  'DevOps': 20,
  'Community': 15,
  'Dev Community': 15,
};
const DEFAULT_CREDIBILITY_FALLBACK = 10;

/**
 * Calculate engagement score (0-40) from article metadata
 * Uses log scale so 10 points ≈ 100 upvotes ≈ 1000 upvotes are differentiated but not extreme
 */
function engagementScore(meta) {
  const points = (meta?.points || 0) + (meta?.upvotes || 0) + (meta?.reactions || 0) + (meta?.stars || 0);
  const comments = meta?.comments || 0;
  return Math.min(40, Math.log10(1 + points) * 10 + Math.log10(1 + comments) * 5);
}

/** Recency score (0-30): full marks for just-published, 0 after 24h */
function recencyScore(publishedAt) {
  if (!publishedAt) return 15; // unknown date gets middle score
  const ts = new Date(publishedAt).getTime();
  if (isNaN(ts)) return 15;
  const hoursAgo = (Date.now() - ts) / 3600000;
  return Math.max(0, 30 - hoursAgo * 1.25);
}

/** Source credibility score (0-30) based on article category */
function credibilityScore(category, weights) {
  if (!category) return DEFAULT_CREDIBILITY_FALLBACK;
  return weights[category] ?? DEFAULT_CREDIBILITY_FALLBACK;
}

/**
 * Create a scoring middleware function
 * @param {Object} [options]
 * @param {number} [options.maxArticles=20]         - Keep top N after scoring
 * @param {Object} [options.credibilityWeights]     - Override default category weights
 * @returns {(articles: Article[]) => Article[]}
 */
export function createScoringMiddleware(options = {}) {
  const { maxArticles = 20, credibilityWeights = {} } = options;
  const weights = { ...DEFAULT_CREDIBILITY, ...credibilityWeights };

  const middleware = (articles) => {
    const scored = articles.map(article => {
      const score = Math.round(
        engagementScore(article.meta) +
        recencyScore(article.publishedAt) +
        credibilityScore(article.category, weights)
      );
      return {
        ...article,
        meta: { ...article.meta, score },
      };
    });

    scored.sort((a, b) => (b.meta.score || 0) - (a.meta.score || 0));
    return scored.slice(0, maxArticles);
  };
  middleware.selectionKey = JSON.stringify([
    'scoring', maxArticles,
    Object.entries(weights).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  return middleware;
}
