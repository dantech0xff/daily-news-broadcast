export const DEFAULT_RUNTIME_LEASE_NAME = 'runtime';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_IDENTIFIER_LENGTH = 200;

const SELECT_LEASE_SQL = `
  SELECT name, owner_id, acquired_at, heartbeat_at, expires_at
  FROM app_runtime_lease
  WHERE name = ?
`;

const UPSERT_LEASE_SQL = `
  INSERT INTO app_runtime_lease(name, owner_id, acquired_at, heartbeat_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    owner_id = excluded.owner_id,
    acquired_at = excluded.acquired_at,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
`;

/**
 * @typedef {object} RuntimeLeaseRecord
 * @property {string} name
 * @property {string} ownerId
 * @property {string} acquiredAt ISO timestamp when the owner's tenure began.
 * @property {string} heartbeatAt ISO timestamp of the latest acquire/renew.
 * @property {string} expiresAt ISO timestamp after which another owner may take over.
 */

/**
 * Single-writer lease stored in `app_runtime_lease`. Acquire, renew, and
 * release each run in one `BEGIN IMMEDIATE` storage transaction, so the
 * read-check-write is atomic across connections and processes sharing the
 * database file.
 *
 * The recorded owner can always extend its lease. Another owner can take it
 * over only once it has expired or been released, so a holder whose renewal
 * fails has lost the lease and must stop writing.
 */
export class RuntimeLease {
  /**
   * @param {{
   *   storage: import('./node-sql-storage.js').NodeSqlStorage,
   *   name?: string,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ storage, name = DEFAULT_RUNTIME_LEASE_NAME, clock = () => new Date() } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('RuntimeLease requires SQL storage with exec() and transactionSync()');
    }
    if (typeof clock !== 'function') throw new TypeError('RuntimeLease clock must be a function');
    this._storage = storage;
    this._name = requireIdentifier(name, 'Lease name');
    this._clock = clock;
  }

  /**
   * Take the lease when it is free, expired, or already held by `ownerId`.
   * @param {string} ownerId
   * @param {number} ttlMs
   * @returns {{ acquired: boolean, lease: RuntimeLeaseRecord }} `lease` is the holder after the call.
   */
  acquire(ownerId, ttlMs) {
    requireIdentifier(ownerId, 'Lease owner');
    requireTtl(ttlMs);
    return this._storage.transactionSync(() => {
      // Read the clock only once the write lock is held so a busy wait cannot
      // leave the expiry decision or the new expiry stale.
      const now = this._now();
      const current = this._read();
      if (current && current.ownerId !== ownerId && !isExpired(current, now)) {
        return { acquired: false, lease: current };
      }
      const lease = this._write({
        ownerId,
        acquiredAt: current?.ownerId === ownerId ? current.acquiredAt : now.toISOString(),
        now,
        ttlMs,
      });
      return { acquired: true, lease };
    });
  }

  /**
   * Extend the lease while `ownerId` is still its recorded owner.
   * @param {string} ownerId
   * @param {number} ttlMs
   * @returns {RuntimeLeaseRecord | null} `null` when the lease was released or taken over.
   */
  renew(ownerId, ttlMs) {
    requireIdentifier(ownerId, 'Lease owner');
    requireTtl(ttlMs);
    return this._storage.transactionSync(() => {
      const current = this._read();
      if (current?.ownerId !== ownerId) return null;
      return this._write({ ownerId, acquiredAt: current.acquiredAt, now: this._now(), ttlMs });
    });
  }

  /**
   * Give the lease up so another owner can take it immediately.
   * @param {string} ownerId
   * @returns {boolean} `false` when `ownerId` did not hold the lease.
   */
  release(ownerId) {
    requireIdentifier(ownerId, 'Lease owner');
    return this._storage.transactionSync(() => {
      if (this._read()?.ownerId !== ownerId) return false;
      this._storage.sql.exec(
        'DELETE FROM app_runtime_lease WHERE name = ? AND owner_id = ?',
        this._name,
        ownerId,
      );
      return true;
    });
  }

  /**
   * @returns {RuntimeLeaseRecord | null} The unexpired lease, if any.
   */
  current() {
    const lease = this._read();
    return lease && !isExpired(lease, this._now()) ? lease : null;
  }

  _read() {
    const [row] = this._storage.sql.exec(SELECT_LEASE_SQL, this._name).toArray();
    if (!row) return null;
    return {
      name: row.name,
      ownerId: row.owner_id,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    };
  }

  _write({ ownerId, acquiredAt, now, ttlMs }) {
    const lease = {
      name: this._name,
      ownerId,
      acquiredAt,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this._storage.sql.exec(
      UPSERT_LEASE_SQL,
      lease.name,
      lease.ownerId,
      lease.acquiredAt,
      lease.heartbeatAt,
      lease.expiresAt,
    );
    return lease;
  }

  _now() {
    const now = this._clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError('RuntimeLease clock must return a valid Date');
    }
    return now;
  }
}

// An unreadable expiry counts as expired so a corrupt row cannot block every
// future owner.
function isExpired(lease, now) {
  const expiresAt = Date.parse(lease.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${label} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  return value;
}

function requireTtl(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new TypeError(`Lease TTL must be an integer between 1 and ${MAX_LEASE_TTL_MS} milliseconds`);
  }
}
