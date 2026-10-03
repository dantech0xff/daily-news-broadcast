/**
 * The environment of a Dokploy application is one dotenv text, and
 * `application.saveEnvironment` replaces it as a whole. These helpers rewrite
 * the keys the deploy script owns and keep every other line verbatim.
 * Errors name keys only, never values.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';

const MASTER_KEY_BYTES = 32;
const LINE = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;
// Characters that would change the meaning of an unquoted dotenv value.
const UNSAFE_VALUE = /[\r\n#"'`\\]/;

/** The current environment cannot be rewritten safely, or a managed value is not plain text. */
export class EnvTextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvTextError';
  }
}

/**
 * @typedef {object} ParsedEnv
 * @property {Map<string, string>} values Last occurrence of each key wins, like `dotenv.parse`.
 * @property {{ key: string, line: string }[]} entries Assignment lines in order.
 * @property {string[]} unsupported Keys whose quoted value spans several lines.
 */

/**
 * Parse dotenv text: `KEY=value` lines, optional `export`, quoted values,
 * and `#` comments.
 * @param {string|null|undefined} text
 * @returns {ParsedEnv}
 */
export function parseEnvText(text) {
  const values = new Map();
  const entries = [];
  const unsupported = [];
  if (typeof text !== 'string') return { values, entries, unsupported };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    const value = parseValue(rest);
    if (value === null) {
      unsupported.push(key);
      continue;
    }
    values.set(key, value);
    entries.push({ key, line });
  }
  return { values, entries, unsupported };
}

/**
 * Write `managed` into the current dotenv text: managed keys first, in the
 * given order, then every other assignment line unchanged.
 * @param {string|null|undefined} currentText
 * @param {Record<string, string>} managed
 * @returns {{ text: string, changed: boolean, kept: string[] }} `kept` names the unmanaged keys.
 * @throws {EnvTextError}
 */
export function mergeEnvText(currentText, managed) {
  const current = parseEnvText(currentText);
  if (current.unsupported.length > 0) {
    throw new EnvTextError(`The application environment has multi-line values the script cannot preserve (${current.unsupported.join(', ')}); edit them in Dokploy first.`);
  }
  const lines = [];
  for (const [key, value] of Object.entries(managed)) {
    if (typeof value !== 'string' || UNSAFE_VALUE.test(value) || value !== value.trim()) {
      throw new EnvTextError(`The value for ${key} must be plain text without quotes, "#", backslashes, line breaks, or surrounding spaces.`);
    }
    lines.push(`${key}=${value}`);
  }
  const kept = [];
  for (const entry of current.entries) {
    if (Object.hasOwn(managed, entry.key)) continue;
    lines.push(entry.line);
    if (!kept.includes(entry.key)) kept.push(entry.key);
  }
  const text = lines.join('\n');
  return { text, changed: !sameValues(parseEnvText(text).values, current.values), kept };
}

/**
 * A new `APP_MASTER_KEY`: base64 of 32 random bytes (the format
 * `parseMasterKey()` in `src/app/secrets/vault.js` accepts).
 * @param {(size: number) => Buffer} [randomBytes]
 * @returns {string}
 */
export function generateMasterKey(randomBytes = nodeRandomBytes) {
  const bytes = randomBytes(MASTER_KEY_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== MASTER_KEY_BYTES) throw new Error('Random source returned the wrong number of bytes');
  return bytes.toString('base64');
}

// `null` marks a quoted value that does not close on its line (a multi-line value).
function parseValue(rest) {
  const quote = rest[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '\\') {
        index += 1;
      } else if (rest[index] === quote) {
        const inner = rest.slice(1, index);
        return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner;
      }
    }
    return null;
  }
  const comment = rest.indexOf('#');
  return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}

function sameValues(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}
