import test from 'node:test';
import assert from 'node:assert/strict';

import { createScoringMiddleware } from '../../src/core/scoring.js';

test('AI News receives the established-source credibility weight', () => {
  const publishedAt = new Date();
  const ranked = createScoringMiddleware()([
    { id: 'news', title: 'AI News', source: 'Publisher', category: 'AI News', publishedAt },
    { id: 'unknown', title: 'Unknown', source: 'Unknown', category: 'Unknown', publishedAt },
    { id: 'lab', title: 'AI Lab', source: 'Lab', category: 'AI/ML', publishedAt },
  ]);
  const byId = Object.fromEntries(ranked.map(article => [article.id, article]));

  assert.equal(byId.news.meta.score, byId.lab.meta.score);
  assert.equal(byId.news.meta.score - byId.unknown.meta.score, 15);
});
