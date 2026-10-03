/**
 * Channel configuration store backed by `app_channels`. Scalar settings live
 * in columns; sources, prompt, AI, Telegram credential slots, and limits live
 * in `config_json`. Every write is validated by the channel schema, checks its
 * credential references in the same transaction, and bumps `version` for
 * optimistic concurrency.
 *
 * `cutoverRequired` is system state, not config: only `create()`'s
 * `cutoverRequired` option (the seed) sets it, input never does, and updates
 * leave it unchanged.
 */

import { ChannelValidationError, listCredentialReferences, validateChannelConfig } from './config-schema.js';
import { isPlainObject, requireActor } from './validation.js';

const SELECT_CHANNEL_SQL = `
  SELECT id, name, enabled, platform, mode, cron, timezone, config_json, not_before,
         cutover_required, version, created_at, updated_at, updated_by
  FROM app_channels
`;

export class ChannelNotFoundError extends Error {
  /** @param {string} channelId */
  constructor(channelId) {
    super(`Channel "${channelId}" does not exist`);
    this.name = 'ChannelNotFoundError';
    this.code = 'channel_not_found';
    this.channelId = channelId;
  }
}

/** A create collided with an existing id, or a write carried a stale version. */
export class ChannelConflictError extends Error {
  /**
   * @param {'channel_exists'|'version_conflict'} code
   * @param {string} channelId
   * @param {{ currentVersion?: number }} [details]
   */
  constructor(code, channelId, { currentVersion } = {}) {
    super(code === 'channel_exists'
      ? `Channel "${channelId}" already exists`
      : `Channel "${channelId}" was changed by someone else (current version ${currentVersion})`);
    this.name = 'ChannelConflictError';
    this.code = code;
    this.channelId = channelId;
    if (currentVersion !== undefined) this.currentVersion = currentVersion;
  }
}

/**
 * @typedef {import('./config-schema.js').ChannelConfig & {
 *   cutoverRequired: boolean,
 *   version: number,
 *   createdAt: string,
 *   updatedAt: string,
 *   updatedBy: string|null,
 * }} ChannelRecord `cutoverRequired` (read-only): the channel may not start
 *   delivering until `notBefore` is set.
 */

export class ChannelRepository {
  /**
   * @param {{
   *   storage: import('../db/node-sql-storage.js').NodeSqlStorage,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ storage, clock = () => new Date() } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('ChannelRepository requires SQL storage with exec() and transactionSync()');
    }
    if (typeof clock !== 'function') throw new TypeError('ChannelRepository clock must be a function');
    this._storage = storage;
    this._clock = clock;
  }

  /** @returns {ChannelRecord[]} Oldest first. */
  list() {
    return this._storage.sql.exec(`${SELECT_CHANNEL_SQL} ORDER BY created_at, id`).toArray().map(toRecord);
  }

  /**
   * @param {string} id
   * @returns {ChannelRecord|null}
   */
  get(id) {
    const row = this._readRow(id);
    return row ? toRecord(row) : null;
  }

  /**
   * @param {unknown} input Channel config; see `validateChannelConfig()`.
   * @param {{ actor: string, now?: Date, cutoverRequired?: boolean }} options
   *   `cutoverRequired`: system use only (the seed); API input never sets it.
   * @returns {ChannelRecord} Version 1.
   * @throws {ChannelValidationError|ChannelConflictError}
   */
  create(input, { actor, now, cutoverRequired = false } = {}) {
    const updatedBy = requireActor(actor);
    if (typeof cutoverRequired !== 'boolean') throw new TypeError('cutoverRequired must be a boolean');
    const config = validateChannelConfig(input);
    const timestamp = this._timestamp(now);
    this._storage.transactionSync(() => {
      if (this._readRow(config.id)) throw new ChannelConflictError('channel_exists', config.id);
      this._assertCredentialReferences(config);
      this._storage.sql.exec(
        `INSERT INTO app_channels(
          id, name, enabled, platform, mode, cron, timezone, config_json, not_before,
          cutover_required, version, created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        config.id, config.name, config.enabled, config.platform, config.mode, config.cron, config.timezone,
        serializeConfig(config), config.notBefore, cutoverRequired, timestamp, timestamp, updatedBy,
      );
    });
    return this.get(config.id);
  }

  /**
   * Apply `changes` over the stored channel. Top-level fields that are left
   * out (or `undefined`) keep their stored value, so clearing `notBefore`
   * takes an explicit `null`; a nested section (`prompt`, `ai`, ...) that is
   * given replaces the stored section. The id cannot change.
   *
   * @param {string} id
   * @param {Record<string, unknown>} changes
   * @param {{ expectedVersion: number, actor: string, now?: Date }} options
   * @returns {ChannelRecord}
   * @throws {ChannelValidationError|ChannelNotFoundError|ChannelConflictError}
   */
  update(id, changes, { expectedVersion, actor, now } = {}) {
    const updatedBy = requireActor(actor);
    if (!isPlainObject(changes)) {
      throw new ChannelValidationError([{ field: '', code: 'invalid_type', message: 'Phải là object.' }]);
    }
    assertVersion(expectedVersion);
    const timestamp = this._timestamp(now);
    this._storage.transactionSync(() => {
      const row = this._readRow(id);
      if (!row) throw new ChannelNotFoundError(id);
      if (row.version !== expectedVersion) {
        throw new ChannelConflictError('version_conflict', id, { currentVersion: row.version });
      }
      const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      const config = validateChannelConfig({ ...toRecord(row), ...given }, { existingId: row.id });
      this._assertCredentialReferences(config);
      this._storage.sql.exec(
        `UPDATE app_channels
         SET name = ?, enabled = ?, platform = ?, mode = ?, cron = ?, timezone = ?, config_json = ?,
             not_before = ?, version = version + 1, updated_at = ?, updated_by = ?
         WHERE id = ?`,
        config.name, config.enabled, config.platform, config.mode, config.cron, config.timezone,
        serializeConfig(config), config.notBefore, timestamp, updatedBy, row.id,
      );
    });
    return this.get(id);
  }

  /**
   * @param {string} id
   * @param {{ expectedVersion?: number }} [options] When given, a stale version is a conflict.
   * @throws {ChannelNotFoundError|ChannelConflictError}
   */
  delete(id, { expectedVersion } = {}) {
    if (expectedVersion !== undefined) assertVersion(expectedVersion);
    this._storage.transactionSync(() => {
      const row = this._readRow(id);
      if (!row) throw new ChannelNotFoundError(id);
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        throw new ChannelConflictError('version_conflict', id, { currentVersion: row.version });
      }
      this._storage.sql.exec('DELETE FROM app_channels WHERE id = ?', row.id);
    });
  }

  _readRow(id) {
    if (typeof id !== 'string' || id === '') return null;
    return this._storage.sql.exec(`${SELECT_CHANNEL_SQL} WHERE id = ?`, id).toArray()[0] ?? null;
  }

  _assertCredentialReferences(config) {
    const issues = [];
    for (const { field, kind, credentialId } of listCredentialReferences(config)) {
      const [credential] = this._storage.sql.exec('SELECT kind FROM app_credentials WHERE id = ?', credentialId).toArray();
      if (!credential) {
        issues.push({ field, code: 'credential_not_found', message: 'Credential không tồn tại.' });
      } else if (credential.kind !== kind) {
        issues.push({ field, code: 'credential_kind_mismatch', message: `Cần credential loại ${kind}.` });
      }
    }
    if (issues.length > 0) throw new ChannelValidationError(issues);
  }

  _timestamp(now) {
    const value = now === undefined ? this._clock() : now;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('ChannelRepository time must be a valid Date');
    }
    return value.toISOString();
  }
}

function assertVersion(expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ChannelValidationError([{
      field: 'version',
      code: 'required',
      message: 'Cần version hiện tại của kênh (số nguyên ≥ 1).',
    }]);
  }
}

function serializeConfig({ sources, prompt, ai, telegram, limits }) {
  return JSON.stringify({ sources, prompt, ai, telegram, limits });
}

function toRecord(row) {
  let config;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    config = null;
  }
  if (!isPlainObject(config)) throw new Error(`Stored config for channel "${row.id}" is unreadable`);
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    platform: row.platform,
    mode: row.mode,
    cron: row.cron,
    timezone: row.timezone,
    notBefore: row.not_before ?? null,
    sources: config.sources,
    prompt: config.prompt,
    ai: config.ai,
    telegram: config.telegram,
    limits: config.limits,
    cutoverRequired: Boolean(row.cutover_required),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}
