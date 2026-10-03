/**
 * Secret vault: AES-256-GCM encryption for credentials stored in SQLite.
 *
 * The 32-byte master key comes from `APP_MASTER_KEY` (base64) and is held only
 * in a private field. A keyed fingerprint of it is recorded in `app_settings`
 * on first use so a different key fails fast instead of producing records
 * that can never be decrypted. Errors never contain key material or secrets.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const VAULT_FINGERPRINT_SETTING = 'vault.key_fingerprint';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FINGERPRINT_BYTES = 16;
const FINGERPRINT_LABEL = 'content-radar/app-master-key/fingerprint/v1';
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The master key is missing, malformed, or not the key the database was encrypted with. */
export class VaultKeyError extends Error {
  /**
   * @param {'vault_key_missing'|'vault_key_invalid'|'vault_key_mismatch'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'VaultKeyError';
    this.code = code;
  }
}

/** Stored ciphertext failed authentication (tampered, truncated, or bound to another record). */
export class VaultDecryptionError extends Error {
  constructor() {
    super('Stored secret could not be decrypted: the ciphertext failed authentication');
    this.name = 'VaultDecryptionError';
    this.code = 'vault_decrypt_failed';
  }
}

/**
 * @typedef {object} SealedSecret
 * @property {string} ciphertext Base64.
 * @property {string} iv Base64 of a random 12-byte nonce.
 * @property {string} authTag Base64 of the 16-byte GCM tag.
 * @property {string} keyFingerprint Fingerprint of the key that sealed it.
 */

/**
 * Decode `APP_MASTER_KEY`: canonical base64 of exactly 32 bytes.
 * @param {unknown} value
 * @returns {Buffer}
 * @throws {VaultKeyError}
 */
export function parseMasterKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    throw new VaultKeyError('vault_key_missing', 'APP_MASTER_KEY is required: set it to the base64 encoding of 32 random bytes');
  }
  const key = CANONICAL_BASE64.test(text) ? Buffer.from(text, 'base64') : null;
  if (!key || key.length !== KEY_BYTES || key.toString('base64') !== text) {
    throw new VaultKeyError('vault_key_invalid', 'APP_MASTER_KEY must be the base64 encoding of exactly 32 bytes');
  }
  return key;
}

/**
 * Non-reversible key identifier: hex of the first 16 bytes of
 * HMAC-SHA256(key, fixed label).
 * @param {Buffer} key
 * @returns {string}
 */
export function keyFingerprint(key) {
  return createHmac('sha256', key).update(FINGERPRINT_LABEL).digest().subarray(0, FINGERPRINT_BYTES).toString('hex');
}

export class SecretVault {
  #key;
  #fingerprint;
  #storage;
  #clock;
  #verified = false;

  /**
   * @param {{
   *   storage: import('../db/node-sql-storage.js').NodeSqlStorage,
   *   masterKey: string,
   *   clock?: () => Date,
   * }} options
   */
  constructor({ storage, masterKey, clock = () => new Date() } = {}) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage.transactionSync !== 'function') {
      throw new TypeError('SecretVault requires SQL storage with exec() and transactionSync()');
    }
    if (typeof clock !== 'function') throw new TypeError('SecretVault clock must be a function');
    this.#key = parseMasterKey(masterKey);
    this.#fingerprint = keyFingerprint(this.#key);
    this.#storage = storage;
    this.#clock = clock;
  }

  /** @returns {string} Fingerprint of the configured master key. */
  get fingerprint() {
    return this.#fingerprint;
  }

  /**
   * Check the master key against the database, recording its fingerprint on
   * first use. Call at startup to fail fast; encrypt/decrypt also run it once.
   * @returns {{ recorded: boolean }} `recorded` is true when this call stored the fingerprint.
   * @throws {VaultKeyError} When the database belongs to a different key.
   */
  initialize() {
    const result = this.#storage.transactionSync(() => {
      const { sql } = this.#storage;
      const [stored] = sql.exec('SELECT value FROM app_settings WHERE key = ?', VAULT_FINGERPRINT_SETTING).toArray();
      if (stored) {
        if (stored.value !== this.#fingerprint) throw mismatchError();
        return { recorded: false };
      }
      // Credentials sealed by another key without a recorded fingerprint
      // (for example after a lost settings row) must still fail fast.
      const foreign = sql.exec(
        'SELECT 1 AS present FROM app_credentials WHERE key_fingerprint <> ? LIMIT 1',
        this.#fingerprint,
      ).toArray();
      if (foreign.length > 0) throw mismatchError();
      sql.exec(
        'INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)',
        VAULT_FINGERPRINT_SETTING,
        this.#fingerprint,
        this.#now().toISOString(),
      );
      return { recorded: true };
    });
    this.#verified = true;
    return result;
  }

  /**
   * Encrypt with a fresh random IV. `associatedData` binds the ciphertext to
   * its record so it cannot be moved to another one.
   * @param {string} plaintext
   * @param {string} associatedData
   * @returns {SealedSecret}
   */
  encrypt(plaintext, associatedData) {
    if (typeof plaintext !== 'string') throw new TypeError('Vault plaintext must be a string');
    this.#ensureVerified();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(associatedDataBytes(associatedData));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyFingerprint: this.#fingerprint,
    };
  }

  /**
   * @param {SealedSecret} sealed
   * @param {string} associatedData Must match the value used to encrypt.
   * @returns {string}
   * @throws {VaultKeyError|VaultDecryptionError}
   */
  decrypt(sealed, associatedData) {
    this.#ensureVerified();
    if (sealed?.keyFingerprint !== this.#fingerprint) throw mismatchError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, decodeBase64(sealed.iv, IV_BYTES), {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(associatedDataBytes(associatedData));
      decipher.setAuthTag(decodeBase64(sealed.authTag, AUTH_TAG_BYTES));
      return Buffer.concat([decipher.update(decodeBase64(sealed.ciphertext)), decipher.final()]).toString('utf8');
    } catch {
      throw new VaultDecryptionError();
    }
  }

  #ensureVerified() {
    if (!this.#verified) this.initialize();
  }

  #now() {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError('SecretVault clock must return a valid Date');
    }
    return now;
  }
}

function mismatchError() {
  return new VaultKeyError(
    'vault_key_mismatch',
    'APP_MASTER_KEY does not match the key that encrypted the stored credentials; restore the original key',
  );
}

function associatedDataBytes(associatedData) {
  if (typeof associatedData !== 'string' || associatedData === '') {
    throw new TypeError('Vault associated data must be a non-empty string');
  }
  return Buffer.from(associatedData, 'utf8');
}

function decodeBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) throw new TypeError('Invalid base64 field');
  const bytes = Buffer.from(value, 'base64');
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new TypeError('Unexpected field length');
  return bytes;
}
