/**
 * Write-only credential store backed by `app_credentials`. Values are sealed
 * by the vault before they reach SQL; reads return metadata only. The single
 * plaintext path, `resolvePlaintext()`, exists for the runtime building a
 * channel and must never be exposed through the API or logged.
 */

import { randomUUID } from 'node:crypto';

import { CREDENTIAL_KINDS, listCredentialReferences } from '../channels/config-schema.js';
import {
  IssueCollector,
  ValidationError,
  readEnum,
  readObject,
  readString,
  requireActor,
} from '../channels/validation.js';

export const MAX_CREDENTIAL_VALUE_LENGTH = 4_096;
export const MAX_CREDENTIAL_LABEL_LENGTH = 100;

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const VALUE_FORMATS = Object.freeze({
  telegram_bot_token: {
    pattern: /^\d{1,20}:[A-Za-z0-9_-]{1,200}$/,
    message: 'Bot token Telegram có dạng <số>:<chuỗi ký tự>, ví dụ 123456:ABC-xyz.',
  },
  telegram_chat_id: {
    pattern: /^(?:-?\d{1,20}|@[A-Za-z0-9_]{1,64})$/,
    message: 'Chat ID Telegram là số (ví dụ -1001234567890) hoặc @tên_kênh.',
  },
});

const METADATA_COLUMNS = 'id, label, kind, length(ciphertext) AS sealed_length, created_at, updated_at, updated_by';

/** Credential input rejected at the boundary; `issues` never contain the value. */
export class CredentialValidationError extends ValidationError {
  /** @param {import('../channels/validation.js').ValidationIssue[]} issues */
  constructor(issues) {
    super('Credential input is invalid', issues);
    this.name = 'CredentialValidationError';
  }
}

export class CredentialNotFoundError extends Error {
  /** @param {string} credentialId */
  constructor(credentialId) {
    super(`Credential "${credentialId}" does not exist`);
    this.name = 'CredentialNotFoundError';
    this.code = 'credential_not_found';
    this.credentialId = credentialId;
  }
}

/** Deleting a credential that channels still reference. */
export class CredentialInUseError extends Error {
  /**
   * @param {string} credentialId
   * @param {string[]} usedBy Channel ids.
   */
  constructor(credentialId, usedBy) {
    super(`Credential "${credentialId}" is used by channel(s): ${usedBy.join(', ')}`);
    this.name = 'CredentialInUseError';
    this.code = 'credential_in_use';
    this.credentialId = credentialId;
    this.usedBy = usedBy;
  }
}

/**
 * @typedef {object} CredentialMetadata
 * @property {string} id
 * @property {string} label
 * @property {string} kind One of `CREDENTIAL_KINDS`.
 * @property {boolean} isSet
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} updatedBy
 * @property {string[]} usedBy Ids of channels referencing this credential.
 */

export class CredentialRepository {
  /**
   * @param {{
   *   storage: import('../db/node-sql-storage.js').NodeSqlStorage,
   *   vault: import('./vault.js').SecretVault,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ storage, vault, clock = () => new Date() } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('CredentialRepository requires SQL storage with exec() and transactionSync()');
    }
    if (typeof vault?.encrypt !== 'function' || typeof vault.decrypt !== 'function') {
      throw new TypeError('CredentialRepository requires a SecretVault');
    }
    if (typeof clock !== 'function') throw new TypeError('CredentialRepository clock must be a function');
    this._storage = storage;
    this._vault = vault;
    this._clock = clock;
  }

  /** @returns {CredentialMetadata[]} Oldest first. */
  list() {
    const usage = this._usage();
    return this._storage.sql.exec(`SELECT ${METADATA_COLUMNS} FROM app_credentials ORDER BY created_at, id`)
      .toArray()
      .map(row => toMetadata(row, usage));
  }

  /**
   * @param {string} id
   * @returns {CredentialMetadata|null}
   */
  get(id) {
    const row = this._readMetadata(id);
    return row ? toMetadata(row, this._usage()) : null;
  }

  /**
   * @param {{ label: string, kind: string, value: string, actor: string }} input
   *   `actor` must come from the authenticated identity, never from request data.
   * @returns {CredentialMetadata}
   * @throws {CredentialValidationError}
   */
  create(input) {
    const issues = new IssueCollector();
    const fields = readObject(issues, input, '', { allowed: ['label', 'kind', 'value', 'actor'] });
    if (!fields) throw new CredentialValidationError(issues.issues);
    const actor = requireActor(fields.actor);
    const label = readLabel(issues, fields.label);
    const kind = readEnum(issues, fields.kind, 'kind', CREDENTIAL_KINDS, { required: true });
    const value = readValue(issues, fields.value, kind);
    if (issues.hasIssues) throw new CredentialValidationError(issues.issues);

    const id = randomUUID();
    const now = this._now();
    this._storage.transactionSync(() => {
      const sealed = this._vault.encrypt(value, associatedData(id, kind));
      this._storage.sql.exec(
        `INSERT INTO app_credentials(
          id, label, kind, ciphertext, iv, auth_tag, key_fingerprint, created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, label, kind, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyFingerprint, now, now, actor,
      );
    });
    return this.get(id);
  }

  /**
   * Replace the stored value; label and kind are unchanged.
   * @param {string} id
   * @param {{ value: string, actor: string }} input
   * @returns {CredentialMetadata}
   * @throws {CredentialNotFoundError|CredentialValidationError}
   */
  replace(id, input) {
    const issues = new IssueCollector();
    const fields = readObject(issues, input, '', { allowed: ['value', 'actor'] });
    if (!fields) throw new CredentialValidationError(issues.issues);
    const actor = requireActor(fields.actor);
    if (issues.hasIssues) throw new CredentialValidationError(issues.issues);
    this._storage.transactionSync(() => {
      const current = this._readMetadata(id);
      if (!current) throw new CredentialNotFoundError(id);
      const value = readValue(issues, fields.value, current.kind);
      if (issues.hasIssues) throw new CredentialValidationError(issues.issues);
      const sealed = this._vault.encrypt(value, associatedData(id, current.kind));
      this._storage.sql.exec(
        `UPDATE app_credentials
         SET ciphertext = ?, iv = ?, auth_tag = ?, key_fingerprint = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
        sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyFingerprint, this._now(), actor, id,
      );
    });
    return this.get(id);
  }

  /**
   * @param {string} id
   * @throws {CredentialNotFoundError|CredentialInUseError}
   */
  delete(id) {
    this._storage.transactionSync(() => {
      if (!this._readMetadata(id)) throw new CredentialNotFoundError(id);
      const usedBy = this._usage().get(id) ?? [];
      if (usedBy.length > 0) throw new CredentialInUseError(id, usedBy);
      this._storage.sql.exec('DELETE FROM app_credentials WHERE id = ?', id);
    });
  }

  /**
   * Decrypt a credential for the runtime. Never return the result to API
   * clients and never log it.
   * @param {string} id
   * @param {{ kind?: string }} [options] Expected kind; a mismatch is rejected.
   * @returns {string}
   * @throws {CredentialNotFoundError|import('./vault.js').VaultKeyError|import('./vault.js').VaultDecryptionError}
   */
  resolvePlaintext(id, { kind } = {}) {
    const [row] = this._storage.sql.exec(
      'SELECT id, kind, ciphertext, iv, auth_tag, key_fingerprint FROM app_credentials WHERE id = ?',
      id,
    ).toArray();
    if (!row) throw new CredentialNotFoundError(id);
    if (kind !== undefined && row.kind !== kind) {
      throw new Error(`Credential "${id}" has kind ${row.kind}, but ${kind} is required`);
    }
    return this._vault.decrypt({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyFingerprint: row.key_fingerprint,
    }, associatedData(row.id, row.kind));
  }

  _readMetadata(id) {
    if (typeof id !== 'string' || id === '') return null;
    return this._storage.sql.exec(`SELECT ${METADATA_COLUMNS} FROM app_credentials WHERE id = ?`, id).toArray()[0] ?? null;
  }

  // Credential id -> ids of channels whose config references it.
  _usage() {
    const usage = new Map();
    for (const row of this._storage.sql.exec('SELECT id, config_json FROM app_channels ORDER BY id').toArray()) {
      for (const { credentialId } of listCredentialReferences(parseChannelConfig(row))) {
        const channels = usage.get(credentialId) ?? [];
        if (!channels.includes(row.id)) channels.push(row.id);
        usage.set(credentialId, channels);
      }
    }
    return usage;
  }

  _now() {
    const now = this._clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError('CredentialRepository clock must return a valid Date');
    }
    return now.toISOString();
  }
}

// Binds a ciphertext to its credential so a sealed value cannot be moved to
// another row or reused as a different kind.
function associatedData(id, kind) {
  return `content-radar:credential:v1\u001f${id}\u001f${kind}`;
}

function toMetadata(row, usage) {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    isSet: Number(row.sealed_length) > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
    usedBy: [...(usage.get(row.id) ?? [])],
  };
}

function readLabel(issues, value) {
  return readString(issues, value, 'label', { required: true, max: MAX_CREDENTIAL_LABEL_LENGTH });
}

function readValue(issues, value, kind) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return issues.add('value', 'required', 'Bắt buộc.');
  }
  if (typeof value !== 'string') return issues.add('value', 'invalid_type', 'Phải là chuỗi ký tự.');
  const text = value.trim();
  if (text.length > MAX_CREDENTIAL_VALUE_LENGTH) {
    return issues.add('value', 'too_long', `Tối đa ${MAX_CREDENTIAL_VALUE_LENGTH} ký tự.`);
  }
  if (!VISIBLE_ASCII.test(text)) {
    return issues.add('value', 'invalid_characters', 'Chỉ dùng ký tự ASCII hiển thị, không có khoảng trắng.');
  }
  const format = VALUE_FORMATS[kind];
  if (format && !format.pattern.test(text)) return issues.add('value', 'invalid_format', format.message);
  return text;
}

function parseChannelConfig(row) {
  try {
    return JSON.parse(row.config_json);
  } catch {
    // Fail closed: an unreadable channel might reference any credential.
    throw new Error(`Stored config for channel "${row.id}" is unreadable`);
  }
}
