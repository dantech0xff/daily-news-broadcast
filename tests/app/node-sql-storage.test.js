import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';

function memoryStorage(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, storage: createNodeSqlStorage(db) };
}

function first(cursor) {
  for (const row of cursor) return row;
  return null;
}

function count(sql, table) {
  return sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

test('exec returns a single-pass cursor of plain row objects', t => {
  const { storage: { sql } } = memoryStorage(t);
  sql.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  for (const name of ['a', 'b', 'c']) sql.exec('INSERT INTO items(name) VALUES (?)', name);

  const cursor = sql.exec('SELECT id, name FROM items ORDER BY id');
  const head = cursor.next();
  assert.deepEqual(head, { done: false, value: { id: 1, name: 'a' } });
  assert.equal(Object.getPrototypeOf(head.value), Object.prototype);
  assert.deepEqual([...cursor], [{ id: 2, name: 'b' }, { id: 3, name: 'c' }]);
  assert.equal(cursor.next().done, true);
  assert.deepEqual(cursor.toArray(), []);

  assert.deepEqual(first(sql.exec('SELECT name FROM items WHERE id = ?', 2)), { name: 'b' });
  assert.equal(first(sql.exec('SELECT name FROM items WHERE id = ?', 99)), null);
});

test('toArray and one follow Durable Object cursor semantics', t => {
  const { storage: { sql } } = memoryStorage(t);
  sql.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
  sql.exec('INSERT INTO items(id) VALUES (1), (2)');

  const cursor = sql.exec('SELECT id FROM items ORDER BY id');
  assert.deepEqual(cursor.toArray(), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(cursor.toArray(), []);

  assert.deepEqual(sql.exec('SELECT id FROM items WHERE id = ?', 2).one(), { id: 2 });
  assert.throws(() => sql.exec('SELECT id FROM items WHERE id = ?', 3).one(), /got no results/);
  assert.throws(() => sql.exec('SELECT id FROM items').one(), /got multiple results/);
});

test('statements without result rows run immediately and return an empty cursor', t => {
  const { storage: { sql } } = memoryStorage(t);
  assert.deepEqual(sql.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)').toArray(), []);

  sql.exec('INSERT INTO items(id, name) VALUES (?, ?)', 1, 'kept');
  sql.exec('INSERT INTO items(id, name) VALUES (?, ?)', 2, 'removed');
  sql.exec('UPDATE items SET name = ? WHERE id = ?', 'renamed', 1);
  sql.exec('DELETE FROM items WHERE id = ?', 2);

  assert.deepEqual(sql.exec('SELECT id, name FROM items').toArray(), [{ id: 1, name: 'renamed' }]);
});

test('multi-statement queries run in order and return the last statement rows', t => {
  const { storage: { sql } } = memoryStorage(t);
  const result = sql.exec(`
    -- leading comment; with a semicolon
    CREATE TABLE notes (body TEXT);
    /* block comment; also with a semicolon */
    INSERT INTO notes VALUES ('first; not a separator');
    ;
    INSERT INTO notes VALUES ('second');
    SELECT COUNT(*) AS n FROM notes;
    -- trailing comment
  `).toArray();
  assert.deepEqual(result, [{ n: 2 }]);

  sql.exec(`
    CREATE TABLE events (value INTEGER);
    CREATE TABLE audit (value INTEGER);
    CREATE TRIGGER events_audit AFTER INSERT ON events BEGIN
      INSERT INTO audit VALUES (new.value);
      INSERT INTO audit VALUES (new.value * 2);
    END;
    INSERT INTO events VALUES (?);
  `, 5);
  assert.deepEqual(sql.exec('SELECT value FROM audit ORDER BY value').toArray(), [{ value: 5 }, { value: 10 }]);

  assert.deepEqual(sql.exec(' -- nothing but comments\n /* and blanks */ ;').toArray(), []);
  assert.throws(() => sql.exec('-- nothing', 1), /Wrong number of parameter bindings/);
});

test('only the last statement of a multi-statement query may have parameters', t => {
  const { storage: { sql } } = memoryStorage(t);
  assert.throws(
    () => sql.exec('CREATE TABLE early (value TEXT); INSERT INTO early VALUES (?); SELECT 1', 'x'),
    /only the last statement can have parameters/,
  );
  assert.equal(count(sql, 'early'), 0);
});

test('bindings map JavaScript values onto SQLite types', t => {
  const { storage: { sql } } = memoryStorage(t);
  const bind = value => sql.exec('SELECT ? AS value, typeof(?) AS type', value, value).one();

  assert.deepEqual(bind(null), { value: null, type: 'null' });
  assert.deepEqual(bind(undefined), { value: null, type: 'null' });
  assert.deepEqual(bind(true), { value: 1, type: 'integer' });
  assert.deepEqual(bind(false), { value: 0, type: 'integer' });
  assert.deepEqual(bind(7n), { value: 7, type: 'integer' });
  assert.deepEqual(bind('text'), { value: 'text', type: 'text' });
  assert.deepEqual(bind(2.5), { value: 2.5, type: 'real' });
  assert.deepEqual([...bind(new Uint8Array([1, 2])).value], [1, 2]);
  assert.deepEqual([...bind(new Uint8Array([3, 4]).buffer).value], [3, 4]);
  assert.equal(bind(new ArrayBuffer(1)).type, 'blob');

  // JavaScript numbers bind as doubles, exactly like Durable Object storage;
  // INTEGER columns still store whole numbers as integers.
  sql.exec('CREATE TABLE counters (value INTEGER)');
  sql.exec('INSERT INTO counters VALUES (?)', 42);
  assert.deepEqual(sql.exec('SELECT value, typeof(value) AS type FROM counters').one(), { value: 42, type: 'integer' });

  for (const unsupported of [{ secret: 'do-not-echo' }, new Date(), Symbol('s'), () => {}]) {
    assert.throws(
      () => sql.exec('SELECT ?, ?', 1, unsupported),
      error => error instanceof TypeError
        && /Unsupported SQL binding type at position 2/.test(error.message)
        && !error.message.includes('do-not-echo'),
    );
  }
});

test('binding counts must match the statement parameters exactly', t => {
  const { storage: { sql } } = memoryStorage(t);
  sql.exec('CREATE TABLE items (id TEXT, version INTEGER)');

  assert.throws(() => sql.exec('INSERT INTO items VALUES (?, ?)', 'a'), /Wrong number of parameter bindings/);
  assert.throws(() => sql.exec('INSERT INTO items VALUES (?, ?)', 'a', 1, 2), /Wrong number of parameter bindings/);
  assert.equal(count(sql, 'items'), 0);

  assert.deepEqual(
    sql.exec(`SELECT '?' AS literal, ? AS value, "id" AS quoted /* ? */ FROM (SELECT 1 AS id) -- ?`, 7).one(),
    { literal: '?', value: 7, quoted: 1 },
  );
  assert.deepEqual(sql.exec('SELECT ?2 AS second, ?1 AS first', 'a', 'b').one(), { second: 'b', first: 'a' });
  assert.throws(() => sql.exec('SELECT :name', 'x'), /Named SQL parameters are not supported/);
  assert.throws(() => sql.exec(42), TypeError);
});

test('SQL transaction statements are rejected in favour of transactionSync', t => {
  const { storage: { sql } } = memoryStorage(t);
  for (const statement of [
    'BEGIN',
    'BEGIN IMMEDIATE TRANSACTION',
    'COMMIT',
    'END TRANSACTION',
    'ROLLBACK',
    'SAVEPOINT nested',
    'RELEASE nested',
    '/* comment */ begin',
    'SELECT 1; COMMIT',
  ]) {
    assert.throws(() => sql.exec(statement), /transactionSync/, statement);
  }
});

test('integers beyond the JavaScript safe range fail instead of losing precision', t => {
  const { storage: { sql } } = memoryStorage(t);
  assert.throws(() => sql.exec('SELECT ? AS value', 2n ** 60n).toArray(), { code: 'ERR_OUT_OF_RANGE' });
  assert.deepEqual(sql.exec('SELECT ? AS value', 2n ** 52n).one(), { value: 2 ** 52 });
});

test('rows are a snapshot, so writes inside the loop body never disturb iteration', t => {
  const { storage: { sql } } = memoryStorage(t);
  sql.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag INTEGER)');
  sql.exec('WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 50) INSERT INTO items(id) SELECT v FROM n');

  let visits = 0;
  for (const row of sql.exec('SELECT id FROM items WHERE flag IS NULL ORDER BY id')) {
    sql.exec('UPDATE items SET flag = 1 WHERE id = ?', row.id);
    sql.exec('INSERT INTO items(id) VALUES (?)', row.id + 1_000);
    visits += 1;
  }
  assert.equal(visits, 50);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM items WHERE flag = 1').one().n, 50);
  assert.equal(count(sql, 'items'), 100);
});

test('transactionSync commits, returns the callback value, and rethrows the original error after rollback', t => {
  const { storage } = memoryStorage(t);
  const { sql } = storage;
  sql.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');

  const value = { ok: true };
  assert.equal(storage.transactionSync(() => {
    sql.exec('INSERT INTO items VALUES (?)', 'committed');
    return value;
  }), value);

  const failure = new Error('abort the transaction');
  assert.throws(() => storage.transactionSync(() => {
    sql.exec('INSERT INTO items VALUES (?)', 'rolled-back');
    throw failure;
  }), error => error === failure);

  storage.transactionSync(() => sql.exec('INSERT INTO items VALUES (?)', 'after-failure'));
  assert.deepEqual(sql.exec('SELECT id FROM items ORDER BY id').toArray(), [
    { id: 'after-failure' },
    { id: 'committed' },
  ]);
  assert.throws(() => storage.transactionSync('not a function'), TypeError);
});

test('nested transactionSync calls use savepoints', t => {
  const { storage } = memoryStorage(t);
  const { sql } = storage;
  sql.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
  const insert = id => sql.exec('INSERT INTO items VALUES (?)', id);
  const ids = () => sql.exec('SELECT id FROM items ORDER BY id').toArray().map(row => row.id);

  storage.transactionSync(() => {
    insert('outer-a');
    assert.throws(() => storage.transactionSync(() => {
      insert('inner-rolled-back');
      throw new Error('inner failure');
    }), /inner failure/);
    storage.transactionSync(() => {
      insert('inner-kept');
      storage.transactionSync(() => insert('innermost-kept'));
    });
    insert('outer-b');
  });
  assert.deepEqual(ids(), ['inner-kept', 'innermost-kept', 'outer-a', 'outer-b']);

  assert.throws(() => storage.transactionSync(() => {
    insert('discarded-outer');
    storage.transactionSync(() => insert('discarded-inner'));
    throw new Error('outer failure');
  }), /outer failure/);
  assert.deepEqual(ids(), ['inner-kept', 'innermost-kept', 'outer-a', 'outer-b']);
});

test('asynchronous transaction callbacks are rejected and rolled back', t => {
  const { storage } = memoryStorage(t);
  const { sql } = storage;
  sql.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');

  assert.throws(
    () => storage.transactionSync(async () => sql.exec('INSERT INTO items VALUES (?)', 'async')),
    /must be synchronous/,
  );
  assert.equal(count(sql, 'items'), 0);
});

test('a failed COMMIT rolls back and surfaces the commit error', t => {
  const { storage } = memoryStorage(t);
  const { sql } = storage;
  sql.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE children (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED
    );
  `);

  assert.throws(
    () => storage.transactionSync(() => sql.exec('INSERT INTO children VALUES (?, ?)', 'orphan', 'missing')),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(count(sql, 'children'), 0);
  storage.transactionSync(() => sql.exec('INSERT INTO parents VALUES (?)', 'parent'));
  assert.equal(count(sql, 'parents'), 1);
});

test('one storage object is shared per connection so nesting is tracked once', t => {
  const { db, storage } = memoryStorage(t);
  const other = new DatabaseSync(':memory:');
  t.after(() => other.close());

  assert.equal(createNodeSqlStorage(db), storage);
  assert.notEqual(createNodeSqlStorage(other), storage);
  assert.ok(Object.isFrozen(storage) && Object.isFrozen(storage.sql));

  storage.sql.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
  storage.transactionSync(() => createNodeSqlStorage(db).transactionSync(
    () => storage.sql.exec('INSERT INTO items VALUES (?)', 'nested-through-second-handle'),
  ));
  assert.equal(count(storage.sql, 'items'), 1);

  for (const invalid of [null, undefined, {}, { prepare() {}, exec() {} }]) {
    assert.throws(() => createNodeSqlStorage(invalid), TypeError);
  }
});
