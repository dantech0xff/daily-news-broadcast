/**
 * Semantic dedup middleware — removes duplicate stories across sources
 * Uses bigram (Dice coefficient) similarity on titles. Zero dependencies.
 * Usage: engine.use(createSemanticDedupMiddleware({ threshold: 0.65 }))
 *
 * Run AFTER scoring middleware so higher-scored duplicates are kept.
 */

/** Extract character bigrams from a normalized string */
function bigrams(str) {
  const normalized = str.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalized.split(/\s+/).filter(Boolean);
  const bg = new Set();
  for (const w of words) {
    for (let i = 0; i < w.length - 1; i++) bg.add(w.slice(i, i + 2));
  }
  return bg;
}

/** Dice coefficient similarity between two strings (0-1) */
function similarity(a, b) {
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  if (bgA.size === 0 && bgB.size === 0) return 1;
  if (bgA.size === 0 || bgB.size === 0) return 0;
  let intersection = 0;
  for (const x of bgA) { if (bgB.has(x)) intersection++; }
  return (2 * intersection) / (bgA.size + bgB.size);
}

/**
 * Create a semantic dedup middleware
 * @param {Object} [options]
 * @param {number} [options.threshold=0.65] - Similarity threshold (0-1). Higher = stricter.
 * @returns {(articles: Article[]) => Article[]}
 */
export function createSemanticDedupMiddleware(options = {}) {
  const { threshold = 0.65 } = options;

  const middleware = (articles) => {
    const kept = [];
    const bigramCache = new Map();
    const cachedBigrams = (s) => {
      if (!bigramCache.has(s)) bigramCache.set(s, bigrams(s));
      return bigramCache.get(s);
    };
    const cachedSimilarity = (a, b) => {
      const bgA = cachedBigrams(a);
      const bgB = cachedBigrams(b);
      if (bgA.size === 0 && bgB.size === 0) return 1;
      if (bgA.size === 0 || bgB.size === 0) return 0;
      let intersection = 0;
      for (const x of bgA) { if (bgB.has(x)) intersection++; }
      return (2 * intersection) / (bgA.size + bgB.size);
    };

    for (const article of articles) {
      const match = kept.find(existing =>
        cachedSimilarity(existing.title, article.title) > threshold
      );

      if (!match) {
        kept.push(article);
        continue;
      }

      // Duplicate found — keep higher-scored version, merge source attribution
      const articleScore = article.meta?.score || 0;
      const matchScore = match.meta?.score || 0;

      if (articleScore > matchScore) {
        const idx = kept.indexOf(match);
        kept[idx] = {
          ...article,
          meta: {
            ...article.meta,
            alsoFrom: [...(match.meta?.alsoFrom || []), match.source],
          },
        };
      } else {
        match.meta = {
          ...match.meta,
          alsoFrom: [...(match.meta?.alsoFrom || []), article.source],
        };
      }
    }

    return kept;
  };
  middleware.selectionKey = JSON.stringify(['semantic-dedup', threshold]);
  return middleware;
}
