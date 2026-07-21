import test from 'node:test';
import assert from 'node:assert/strict';

test('default Node test transport blocks unexpected HTTP', async () => {
  await assert.rejects(
    fetch('https://example.com/should-not-leave-the-process'),
    /Unexpected network request blocked by tests/,
  );
});
