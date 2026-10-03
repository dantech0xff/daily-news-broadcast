import { DatabaseSync } from 'node:sqlite';

const TRANSACTION_KEYWORDS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const LEADING_TRIVIA = /^(?:\s|;|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))+/;
// Mirrors SQLite's tokenizer closely enough to find host parameters: literals,
// quoted identifiers, and comments are consumed whole so their contents never count.
const SQL_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[\w\u0080-\uffff][\w$\u0080-\uffff]*|\?(\d*)|([:@$#][\w$\u0080-\uffff]+)/g;

const storages = new WeakMap();

/**
 * @typedef {object} SqlCursor
 * @property {() => { done: boolean, value?: object }} next
 * @property {() => object[]} toArray Remaining rows; consumes the cursor.
 * @property {() => object} one Exactly one remaining row, otherwise throws.
 */

/**
 * @typedef {object} NodeSqlStorage
 * @property {{ exec: (query: string, ...bindings: unknown[]) => SqlCursor }} sql
 * @property {<T>(callback: () => T) => T} transactionSync
 */

/**
 * Exposes a node:sqlite connection through the subset of the Durable Object
 * storage API that SQLiteDeliveryStore uses (`sql.exec` + `transactionSync`).
 *
 * Statements execute eagerly when `exec` is called and the cursor holds a
 * snapshot of the result rows, so writes made while iterating never disturb the
 * iteration. Bindings follow Durable Object rules: the count must match the
 * statement's `?`/`?NNN` parameters exactly, `undefined` binds NULL, and only
 * the last statement of a multi-statement query may have parameters. Booleans
 * bind as 1/0, ArrayBuffers as blobs, and named parameters are rejected.
 * Integers outside the JavaScript safe range fail to read instead of losing
 * precision. Transaction statements must go through `transactionSync`, which
 * nests with savepoints.
 *
 * The same storage object is returned for the same connection so transaction
 * nesting is tracked once per connection.
 *
 * @param {DatabaseSync} db
 * @returns {NodeSqlStorage}
 */
export function createNodeSqlStorage(db) {
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError('createNodeSqlStorage requires a node:sqlite DatabaseSync connection');
  }
  let storage = storages.get(db);
  if (!storage) {
    storage = Object.freeze({
      sql: Object.freeze({ exec: (query, ...bindings) => execute(db, query, bindings) }),
      transactionSync: createTransactionRunner(db),
    });
    storages.set(db, storage);
  }
  return storage;
}

function execute(db, query, bindings) {
  if (typeof query !== 'string') throw new TypeError('SQL query must be a string');
  const values = bindings.map(toBindingValue);
  let remaining = stripLeadingTrivia(query);
  if (remaining === '') {
    assertBindingCount(0, values.length);
    return new Cursor([]);
  }
  for (;;) {
    const statement = db.prepare(remaining);
    const text = statement.sourceSQL;
    if (!remaining.startsWith(text)) throw new Error('Unable to split the SQL query into statements');
    assertNotTransactionControl(text);
    const rest = stripLeadingTrivia(remaining.slice(text.length));
    if (rest === '') {
      assertBindingCount(countParameters(text), values.length);
      return new Cursor(statement.all(...values).map(row => ({ ...row })));
    }
    if (countParameters(text) > 0) {
      throw new Error('When executing multiple SQL statements in a single call, only the last statement can have parameters.');
    }
    statement.run();
    remaining = rest;
  }
}

function createTransactionRunner(db) {
  let depth = 0;
  return function transactionSync(callback) {
    if (typeof callback !== 'function') throw new TypeError('transactionSync requires a callback function');
    const savepoint = depth === 0 ? null : `node_sql_storage_${depth}`;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth += 1;
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        throw new TypeError('transactionSync callbacks must be synchronous');
      }
      db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      rollback(db, savepoint);
      throw error;
    } finally {
      depth -= 1;
    }
  };
}

function rollback(db, savepoint) {
  try {
    if (savepoint) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } else {
      db.exec('ROLLBACK');
    }
  } catch {
    // SQLite already ended the transaction itself (a failed COMMIT or a fatal
    // I/O error), so there is nothing left to undo; the caller rethrows the
    // error that caused the rollback.
  }
}

class Cursor {
  constructor(rows) {
    this._rows = rows;
    this._index = 0;
  }

  next() {
    if (this._index >= this._rows.length) return { done: true, value: undefined };
    return { done: false, value: this._rows[this._index++] };
  }

  [Symbol.iterator]() {
    return this;
  }

  toArray() {
    const rows = this._rows.slice(this._index);
    this._index = this._rows.length;
    return rows;
  }

  one() {
    const rows = this.toArray();
    if (rows.length === 0) throw new Error('Expected exactly one result from SQL query, but got no results.');
    if (rows.length > 1) throw new Error('Expected exactly one result from SQL query, but got multiple results.');
    return rows[0];
  }
}

function toBindingValue(value, index) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
      return value;
    case 'boolean':
      return value ? 1n : 0n;
    default:
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return value;
      throw new TypeError(`Unsupported SQL binding type at position ${index + 1}`);
  }
}

function assertBindingCount(expected, received) {
  if (expected !== received) {
    throw new Error(`Wrong number of parameter bindings for SQL query (expected ${expected}, received ${received}).`);
  }
}

function assertNotTransactionControl(statementText) {
  const keyword = /^[A-Za-z]+/.exec(stripLeadingTrivia(statementText))?.[0]?.toUpperCase();
  if (TRANSACTION_KEYWORDS.has(keyword)) {
    throw new Error('Use transactionSync() instead of SQL transaction statements');
  }
}

function stripLeadingTrivia(sql) {
  return sql.replace(LEADING_TRIVIA, '');
}

// node:sqlite binds positional values only to `?`/`?NNN` slots and skips named
// ones, so a named parameter could never receive its value and would read NULL.
function countParameters(sql) {
  let count = 0;
  for (const [, digits, named] of sql.matchAll(SQL_TOKEN)) {
    if (named !== undefined) {
      throw new Error('Named SQL parameters are not supported; use ? placeholders');
    }
    if (digits !== undefined) count = digits === '' ? count + 1 : Math.max(count, Number(digits));
  }
  return count;
}
