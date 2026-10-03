/**
 * Field validation shared by the channel and credential boundaries. Readers
 * record problems as `{ field, code, message }` issues instead of throwing, so
 * one pass reports every problem: `field` is a dotted path (`sources.0.config.id`),
 * `code` is a stable English machine code, and `message` is short Vietnamese
 * text for the dashboard. Issues never echo the submitted value.
 */

const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_URL_LENGTH = 2_048;
const MAX_ACTOR_LENGTH = 320;
const MAX_ECHOED_KEY_LENGTH = 64;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * @typedef {object} ValidationIssue
 * @property {string} field Dotted path of the offending field; `''` for the whole input.
 * @property {string} code Stable English machine code.
 * @property {string} message Short Vietnamese explanation for the UI.
 */

/**
 * Input rejected at a configuration boundary; `issues` lists every problem
 * found. The message names fields and codes only, so it is safe to log.
 */
export class ValidationError extends Error {
  /**
   * @param {string} summary
   * @param {ValidationIssue[]} issues
   */
  constructor(summary, issues) {
    const fields = issues.map(issue => `${issue.field || '(input)'} ${issue.code}`).join(', ');
    super(fields ? `${summary}: ${fields}` : summary);
    this.name = 'ValidationError';
    this.code = 'validation_failed';
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue })));
  }
}

/** Accumulates issues while a validator walks its input. */
export class IssueCollector {
  constructor() {
    /** @type {ValidationIssue[]} */
    this.issues = [];
  }

  /**
   * @param {string} field
   * @param {string} code
   * @param {string} message
   * @returns {undefined} So readers can `return issues.add(...)` on failure.
   */
  add(field, code, message) {
    this.issues.push({ field, code, message });
    return undefined;
  }

  get hasIssues() {
    return this.issues.length > 0;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {string} parent
 * @param {string|number} key
 * @returns {string}
 */
export function fieldPath(parent, key) {
  return parent === '' ? String(key) : `${parent}.${key}`;
}

/**
 * Read a plain object and flag keys outside `allowed` (keys in `ignored` are
 * accepted and dropped by the caller).
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {{ allowed: readonly string[], ignored?: readonly string[], required?: boolean }} options
 * @returns {Record<string, unknown>|null} `null` when missing or invalid.
 */
export function readObject(issues, value, field, { allowed, ignored = [], required = true }) {
  if (value === undefined || value === null) {
    if (required) issues.add(field, 'required', 'Bắt buộc.');
    return null;
  }
  if (!isPlainObject(value)) {
    issues.add(field, 'invalid_type', 'Phải là object.');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !ignored.includes(key)) {
      const name = key.length > MAX_ECHOED_KEY_LENGTH ? `${key.slice(0, MAX_ECHOED_KEY_LENGTH)}…` : key;
      issues.add(fieldPath(field, name), 'unknown_field', 'Trường này không được hỗ trợ.');
    }
  }
  return value;
}

/**
 * Read a trimmed string. Missing (`undefined`, `null`, blank) yields
 * `defaultValue`, or a `required` issue when `required` is set.
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {{
 *   required?: boolean,
 *   max?: number,
 *   pattern?: RegExp,
 *   patternMessage?: string,
 *   multiline?: boolean,
 *   defaultValue?: string|null,
 * }} [options]
 * @returns {string|null|undefined} `undefined` after recording an issue.
 */
export function readString(issues, value, field, {
  required = false,
  max,
  pattern,
  patternMessage = 'Sai định dạng.',
  multiline = false,
  defaultValue = null,
} = {}) {
  if (value === undefined || value === null) return missing(issues, field, required, defaultValue);
  if (typeof value !== 'string') return issues.add(field, 'invalid_type', 'Phải là chuỗi ký tự.');
  const text = value.trim();
  if (text === '') return missing(issues, field, required, defaultValue);
  const controls = multiline ? MULTILINE_CONTROL_CHARACTERS : SINGLE_LINE_CONTROL_CHARACTERS;
  if (controls.test(text)) return issues.add(field, 'invalid_characters', 'Không được chứa ký tự điều khiển.');
  if (max !== undefined && text.length > max) return issues.add(field, 'too_long', `Tối đa ${max} ký tự.`);
  if (pattern && !pattern.test(text)) return issues.add(field, 'invalid_format', patternMessage);
  return text;
}

/**
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {{ min: number, max: number, required?: boolean, defaultValue?: number }} options
 * @returns {number|undefined}
 */
export function readInteger(issues, value, field, { min, max, required = false, defaultValue }) {
  if (value === undefined || value === null) return missing(issues, field, required, defaultValue);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return issues.add(field, 'invalid_type', 'Phải là số nguyên.');
  }
  if (value < min || value > max) return issues.add(field, 'out_of_range', `Phải từ ${min} đến ${max}.`);
  return value;
}

/**
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {{ defaultValue: boolean }} options
 * @returns {boolean|undefined}
 */
export function readBoolean(issues, value, field, { defaultValue }) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') return issues.add(field, 'invalid_type', 'Phải là true hoặc false.');
  return value;
}

/**
 * @template {string} T
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {readonly T[]} allowed
 * @param {{ required?: boolean, defaultValue?: T|null }} [options]
 * @returns {T|null|undefined}
 */
export function readEnum(issues, value, field, allowed, { required = false, defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') return missing(issues, field, required, defaultValue);
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return issues.add(field, 'invalid_value', `Giá trị không hợp lệ. Chọn một trong: ${allowed.join(', ')}.`);
  }
  return value;
}

/**
 * Read an absolute http(s) URL without embedded credentials. The trimmed text
 * is returned unchanged so stored config matches what the operator entered.
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @param {{ required?: boolean }} [options]
 * @returns {string|null|undefined}
 */
export function readHttpUrl(issues, value, field, { required = false } = {}) {
  const text = readString(issues, value, field, { required, max: MAX_URL_LENGTH });
  if (typeof text !== 'string') return text;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return issues.add(field, 'invalid_url', 'Phải là URL http:// hoặc https:// hợp lệ, không chứa thông tin đăng nhập.');
  }
  return text;
}

/**
 * Read an ISO-8601 instant with an explicit zone (`Z` or `±HH:MM`) and
 * normalize it to UTC `toISOString()` form. Impossible calendar values that
 * `Date` would silently roll over (February 30, hour 24) are rejected.
 * @param {IssueCollector} issues
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null|undefined}
 */
export function readIsoInstant(issues, value, field) {
  const text = readString(issues, value, field, { max: 40 });
  if (typeof text !== 'string') return text;
  const match = ISO_INSTANT_PATTERN.exec(text);
  const date = match && hasValidCalendarParts(match) ? new Date(text) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    return issues.add(field, 'invalid_format', 'Phải là thời điểm ISO 8601 có múi giờ, ví dụ 2026-10-03T00:00:00Z.');
  }
  return date.toISOString();
}

function hasValidCalendarParts(match) {
  const [, year, month, day, hour, minute, second = '0', offsetHours = '0', offsetMinutes = '0'] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12
    && Number(day) >= 1 && Number(day) <= daysInMonth
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && Number(offsetHours) <= 23 && Number(offsetMinutes) <= 59;
}

/**
 * Audit identity (operator email, service-token client id, or `system-*`)
 * supplied by trusted code rather than request input, so a bad value is a
 * programming error.
 * @param {unknown} actor
 * @returns {string}
 * @throws {TypeError}
 */
export function requireActor(actor) {
  if (typeof actor !== 'string' || actor.trim() === '' || actor.length > MAX_ACTOR_LENGTH) {
    throw new TypeError(`Actor must be a non-empty string of at most ${MAX_ACTOR_LENGTH} characters`);
  }
  return actor.trim();
}

function missing(issues, field, required, defaultValue) {
  if (required) return issues.add(field, 'required', 'Bắt buộc.');
  return defaultValue;
}
