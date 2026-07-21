/**
 * PrefixedCache — wraps any CachePlugin with key namespace
 * Used by channel runner to isolate cache per channel
 */

import { CachePlugin } from './contracts.js';

export class PrefixedCache extends CachePlugin {
  /**
   * @param {CachePlugin} inner - The underlying cache implementation
   * @param {string} prefix - Namespace prefix (e.g., 'news:telegram-main')
   */
  constructor(inner, prefix) {
    super();
    if (!(inner instanceof CachePlugin)) {
      throw new Error('PrefixedCache requires a CachePlugin instance');
    }
    this._inner = inner;
    this._prefix = prefix;
  }

  _key(key) { return `${this._prefix}:${key}`; }

  async get(key) { return this._inner.get(this._key(key)); }
  async peek(key) { return this._inner.peek(this._key(key)); }
  async set(key, value, ttlMs) { return this._inner.set(this._key(key), value, ttlMs); }
  async has(key) { return this._inner.has(this._key(key)); }
  async delete(key) { return this._inner.delete(this._key(key)); }

  get capabilities() { return this._inner.capabilities; }
  async preflight(options) {
    return typeof this._inner.preflight === 'function'
      ? this._inner.preflight(options)
      : this.capabilities;
  }

}
