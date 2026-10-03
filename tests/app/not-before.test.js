import test from 'node:test';
import assert from 'node:assert/strict';

import { NOT_BEFORE_LABEL, createNotBeforeMiddleware } from '../../src/app/runtime/not-before.js';

const CUTOFF = '2026-10-03T00:00:00.000Z';

function article(id, publishedAt) {
  return { id, title: id, source: 'Fixture', ...(publishedAt !== undefined && { publishedAt }) };
}

test('articles published before the cutoff are dropped; at or after it they are kept', () => {
  const middleware = createNotBeforeMiddleware(CUTOFF);
  const kept = middleware([
    article('before', '2026-10-02T23:59:59.999Z'),
    article('exact', CUTOFF),
    article('after', '2026-10-03T00:00:00.001Z'),
    article('date-object-before', new Date('2026-09-30T12:00:00.000Z')),
    article('offset-after', '2026-10-03T08:00:00+07:00'),
  ]);
  assert.deepEqual(kept.map(entry => entry.id), ['exact', 'after', 'offset-after']);
});

test('articles without a readable publishedAt are kept (accepted risk)', () => {
  const middleware = createNotBeforeMiddleware(CUTOFF);
  const kept = middleware([
    article('missing'),
    article('null', null),
    article('blank', ''),
    article('unreadable', 'not a date'),
  ]);
  assert.deepEqual(kept.map(entry => entry.id), ['missing', 'null', 'blank', 'unreadable']);
});

test('a null or undefined cutoff disables the filter', () => {
  const articles = [article('old', '2001-01-01T00:00:00.000Z'), article('undated')];
  for (const notBefore of [null, undefined]) {
    const middleware = createNotBeforeMiddleware(notBefore);
    assert.equal(middleware(articles), articles);
    assert.equal(middleware.selectionKey, JSON.stringify([NOT_BEFORE_LABEL, null]));
  }
});

test('the selection key carries the normalized cutoff so a change invalidates drip batches', () => {
  const middleware = createNotBeforeMiddleware('2026-10-03T07:00:00+07:00');
  assert.equal(middleware.label, NOT_BEFORE_LABEL);
  assert.equal(middleware.selectionKey, JSON.stringify([NOT_BEFORE_LABEL, CUTOFF]));
  assert.notEqual(middleware.selectionKey, createNotBeforeMiddleware('2026-10-04T00:00:00.000Z').selectionKey);
});

test('an invalid cutoff is rejected at construction', () => {
  assert.throws(() => createNotBeforeMiddleware('yesterday'), TypeError);
  assert.throws(() => createNotBeforeMiddleware(new Date('invalid')), TypeError);
});
