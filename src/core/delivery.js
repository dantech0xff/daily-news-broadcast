const DELIVERY_STATES = new Set(['success', 'definitive_failure', 'ambiguous']);
const RETRY_DISPOSITIONS = new Set(['automatic', 'manual', 'never']);
const MAX_ERROR_LENGTH = 500;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/**
 * Normalize old and new OutputPlugin results into the only delivery contract
 * consumed by the state machine. Unknown/legacy failures are ambiguous.
 */
export function normalizeSendResult(result, { error, now = Date.now() } = {}) {
  const raw = result && typeof result === 'object' ? result : {};
  const sourceMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const hasCanonicalState = sourceMeta.deliveryState !== undefined;
  const deliveryState = hasCanonicalState
    ? sourceMeta.deliveryState
    : raw.success === true ? 'success' : 'ambiguous';

  if (!DELIVERY_STATES.has(deliveryState)) {
    throw new Error(`Invalid SendResult meta.deliveryState: ${String(deliveryState)}`);
  }
  if (hasCanonicalState && typeof raw.success === 'boolean' && raw.success !== (deliveryState === 'success')) {
    throw new Error('SendResult success conflicts with meta.deliveryState');
  }

  const retryDisposition = sourceMeta.retryDisposition ?? (
    deliveryState === 'success' ? 'never' : deliveryState === 'ambiguous' ? 'manual' : 'manual'
  );
  if (!RETRY_DISPOSITIONS.has(retryDisposition)) {
    throw new Error(`Invalid SendResult meta.retryDisposition: ${String(retryDisposition)}`);
  }
  if (deliveryState === 'success' && retryDisposition !== 'never') {
    throw new Error('Successful SendResult must use retryDisposition=never');
  }
  if (deliveryState === 'ambiguous' && retryDisposition === 'automatic') {
    throw new Error('Ambiguous SendResult cannot be retried automatically');
  }

  const successfulMessageIds = uniqueStrings([
    ...(Array.isArray(sourceMeta.successfulMessageIds) ? sourceMeta.successfulMessageIds : []),
    ...(raw.messageId ? [raw.messageId] : []),
  ], 50, 200);
  const meta = { deliveryState, retryDisposition };

  copyBoundedString(meta, 'providerCode', sourceMeta.providerCode, 80);
  copyBoundedNumber(meta, 'retryAfterMs', sourceMeta.retryAfterMs, 0, 7 * 24 * 60 * 60 * 1000);
  copyBoundedNumber(meta, 'partsAttempted', sourceMeta.partsAttempted, 0, 1_000);
  copyBoundedNumber(meta, 'partsTotal', sourceMeta.partsTotal, 0, 1_000);
  copyBoundedNumber(meta, 'failedAt', sourceMeta.failedAt, 0, 1_000);
  if (sourceMeta.nextAttemptAt !== undefined && sourceMeta.nextAttemptAt !== null) {
    meta.nextAttemptAt = canonicalRetryInstant(sourceMeta.nextAttemptAt);
  }
  copyBoundedString(meta, 'providerRequestId', sourceMeta.providerRequestId, 200);
  if (successfulMessageIds.length > 0) meta.successfulMessageIds = successfulMessageIds;
  if (sourceMeta.partialMutation !== undefined) {
    meta.partialMutation = normalizePartialMutation(sourceMeta.partialMutation);
  }
  if (Array.isArray(sourceMeta.partResults)) {
    meta.partResults = sourceMeta.partResults.slice(0, 50).map((part, index) => normalizePartResult(part, index));
  }

  const errorText = sourceMeta.sanitizedError ?? raw.error ?? error;
  if (errorText) meta.sanitizedError = sanitizeError(errorText);
  if (meta.retryAfterMs !== undefined && meta.nextAttemptAt === undefined) {
    const currentTime = Number(now);
    if (!Number.isFinite(currentTime)) throw new Error('SendResult retry clock is invalid');
    meta.nextAttemptAt = new Date(currentTime + meta.retryAfterMs).toISOString();
  }
  if (meta.nextAttemptAt !== undefined && retryDisposition !== 'automatic') {
    throw new Error('SendResult nextAttemptAt requires retryDisposition=automatic');
  }

  const normalized = { success: deliveryState === 'success' };
  if (raw.messageId !== undefined) normalized.messageId = boundedString(raw.messageId, 200);
  if (!normalized.success && meta.sanitizedError) normalized.error = meta.sanitizedError;
  normalized.meta = meta;
  return normalized;
}

function canonicalRetryInstant(value) {
  if (typeof value !== 'string' || value.length > 80) {
    throw new Error('SendResult meta.nextAttemptAt must be a canonical ISO instant');
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error('SendResult meta.nextAttemptAt must be a canonical ISO instant');
  }
  return value;
}

export function aggregateSendResults(results) {
  const normalized = results.map(value => normalizeSendResult(value));
  const successCount = normalized.filter(value => value.meta.deliveryState === 'success').length;
  const ambiguousCount = normalized.filter(value => value.meta.deliveryState === 'ambiguous').length;
  const failureCount = normalized.length - successCount - ambiguousCount;
  let status;
  if (normalized.length > 0 && successCount === normalized.length) status = 'success';
  else if (ambiguousCount > 0) status = 'ambiguous';
  else if (successCount > 0) status = 'partial';
  else status = 'failed';
  return { status, successCount, failureCount, ambiguousCount, total: normalized.length };
}

export function projectArticle(article) {
  assertSerializableAndBounded(article);
  if (!article || typeof article !== 'object') throw new Error('Article snapshot must be an object');
  const id = boundedRequiredString(article.id ?? article.url, 'Article id', 2_048);
  const title = boundedRequiredString(article.title, 'Article title', 500);
  const source = boundedRequiredString(article.source, 'Article source', 200);
  const projected = { id, title, source };
  copyBoundedString(projected, 'url', article.url, 2_048);
  copyBoundedString(projected, 'content', article.content, 4_000);
  copyBoundedString(projected, 'category', article.category, 120);
  copyBoundedString(projected, 'author', article.author, 200);
  copyBoundedString(projected, 'imageUrl', article.imageUrl, 2_048);
  if (article.publishedAt !== undefined && article.publishedAt !== null) {
    const date = article.publishedAt instanceof Date ? article.publishedAt : new Date(article.publishedAt);
    if (!Number.isFinite(date.getTime())) throw new Error('Article publishedAt is invalid');
    projected.publishedAt = date.toISOString();
  }
  return projected;
}

export async function buildOutputTopology(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('At least one output is required');
  const rawKeys = outputs.map(output => boundedRequiredString(output.deliveryKey, 'Output deliveryKey', 500));
  const duplicate = rawKeys.find((key, index) => rawKeys.indexOf(key) !== index);
  if (duplicate) throw new Error('Duplicate output deliveryKey is not allowed');

  const entries = [];
  for (let ordinal = 0; ordinal < outputs.length; ordinal++) {
    entries.push({
      outputKey: await sha256Hex(rawKeys[ordinal]),
      ordinal,
      providerId: boundedRequiredString(outputs[ordinal].id, 'Output id', 100),
    });
  }
  return {
    outputs: entries,
    fingerprint: await sha256Hex(entries.map(entry => `${entry.ordinal}:${entry.providerId}:${entry.outputKey}`).join('|')),
  };
}

export async function opaqueId(namespace, ...parts) {
  return sha256Hex(`${boundedRequiredString(namespace, 'ID namespace', 100)}\u0000${parts.map(stableValue).join('\u0000')}`);
}

export async function articleHash(article) {
  const snapshot = projectArticle(article);
  return opaqueId('article', snapshot.source, snapshot.id, snapshot.url ?? '');
}

/**
 * Delivery ownership is channel-local. A shared Node/dashboard store may host
 * several channels, so the durable article key must include that channel even
 * when two channels consume the same source article.
 */
export async function channelArticleHash(channelId, article) {
  return opaqueId(
    'channel-article',
    boundedRequiredString(channelId, 'Channel id', 100),
    await articleHash(article),
  );
}

export function publishingDayFor(instant = new Date(), timeZone = 'UTC') {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid publishing instant');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    throw new Error(`Invalid publishing timezone: ${timeZone}`);
  }
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function sanitizeError(value) {
  const input = value instanceof Error ? value.message : String(value);
  return input
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[redacted-url]')
    .slice(0, MAX_ERROR_LENGTH);
}

function assertSerializableAndBounded(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new Error('Snapshot must be serializable and non-cyclic'); }
  if (json === undefined) throw new Error('Snapshot must be serializable');
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
}

function normalizePartialMutation(value) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const partial = { occurred: value.occurred !== false };
  copyBoundedNumber(partial, 'successfulSteps', value.successfulSteps, 0, 1_000);
  copyBoundedNumber(partial, 'failedStep', value.failedStep, 0, 1_000);
  const ids = uniqueStrings(value.messageIds ?? [], 50, 200);
  if (ids.length) partial.messageIds = ids;
  return partial;
}

function normalizePartResult(value, index) {
  const source = value && typeof value === 'object' ? value : {};
  const part = {};
  copyBoundedNumber(part, 'part', source.part ?? index, 0, 1_000);
  if (typeof source.success === 'boolean') part.success = source.success;
  copyBoundedString(part, 'messageId', source.messageId, 200);
  if (DELIVERY_STATES.has(source.deliveryState)) part.deliveryState = source.deliveryState;
  copyBoundedString(part, 'providerCode', source.providerCode, 80);
  if (source.sanitizedError) part.sanitizedError = sanitizeError(source.sanitizedError);
  return part;
}

function uniqueStrings(values, maxItems, maxLength) {
  return [...new Set(values.filter(value => value !== undefined && value !== null)
    .slice(0, maxItems)
    .map(value => boundedString(value, maxLength)))];
}

function copyBoundedString(target, key, value, maxLength) {
  if (value !== undefined && value !== null) target[key] = boundedString(value, maxLength);
}

function copyBoundedNumber(target, key, value, min, max) {
  if (value === undefined || value === null) return;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return;
  target[key] = number;
}

function boundedRequiredString(value, label, maxLength) {
  const string = boundedString(value, maxLength).trim();
  if (!string) throw new Error(`${label} is required`);
  return string;
}

function boundedString(value, maxLength) {
  return String(value ?? '').slice(0, maxLength);
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return JSON.stringify(sorted);
  }
  return String(value);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const deliveryContract = Object.freeze({
  deliveryStates: [...DELIVERY_STATES],
  retryDispositions: [...RETRY_DISPOSITIONS],
});
