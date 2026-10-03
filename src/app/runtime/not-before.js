/**
 * Cutover filter: drop articles published before a channel's `notBefore`
 * instant so a channel taking over from another runtime never posts content
 * from before its cutover. Articles without a readable `publishedAt` are kept
 * (accepted risk: their age cannot be proven).
 */

export const NOT_BEFORE_LABEL = 'not-before';

/**
 * @param {string|Date|null|undefined} notBefore Cutoff instant; `null`/`undefined` disables the filter.
 * @returns {((articles: object[]) => object[]) & { label: string, selectionKey: string }}
 *   Middleware whose `selectionKey` includes the cutoff, so changing it
 *   invalidates the drip day batch's source topology like any other selection change.
 * @throws {TypeError} When `notBefore` is set but is not a valid instant.
 */
export function createNotBeforeMiddleware(notBefore) {
  const cutoff = parseCutoff(notBefore);
  const middleware = articles => (cutoff === null
    ? articles
    : articles.filter(article => !publishedBefore(article, cutoff)));
  middleware.label = NOT_BEFORE_LABEL;
  middleware.selectionKey = JSON.stringify([
    NOT_BEFORE_LABEL,
    cutoff === null ? null : new Date(cutoff).toISOString(),
  ]);
  return middleware;
}

function parseCutoff(notBefore) {
  if (notBefore === null || notBefore === undefined) return null;
  const time = notBefore instanceof Date ? notBefore.getTime() : Date.parse(String(notBefore));
  if (!Number.isFinite(time)) throw new TypeError('notBefore must be a valid instant or null');
  return time;
}

function publishedBefore(article, cutoff) {
  const value = article?.publishedAt;
  if (value === null || value === undefined || value === '') return false;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  // An unreadable date cannot prove the article is old, so it is treated like a missing one.
  return Number.isFinite(time) && time < cutoff;
}
