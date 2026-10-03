/**
 * AI Plugin: Anthropic Claude
 */

import { AIPlugin } from '../core/contracts.js';
import { buildPromptForDelivery, outputRulesFor } from './_prompts.js';

const PROVIDER_ID = 'claude';
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export class ClaudeAI extends AIPlugin {
  /**
   * @param {Object} config
   * @param {string} config.apiKey
   * @param {string} [config.model='claude-sonnet-4-20250514']
   * @param {string} [config.baseUrl='https://api.anthropic.com']
   * @param {typeof fetch} [config.fetch] - Optional injected transport
   */
  constructor(config) {
    super();
    this._config = {
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://api.anthropic.com',
      ...config,
    };
  }

  get id() { return 'claude'; }
  get name() { return `Claude (${this._config.model})`; }

  async summarize(articles, options = {}) {
    const {
      language = 'vi', style = 'digest', audience, platform, systemPrompt, customSystemPrompt,
      _rawUserPrompt, maxTokens = 4096,
    } = options;
    const prompt = buildPromptForDelivery(articles, {
      language,
      style,
      audience,
      platform,
      deliveryMode: options.deliveryMode,
      customSystemPrompt,
    });
    // A legacy `systemPrompt` still replaces the whole prompt, but the output
    // language rules for the requested language are always enforced.
    const systemContent = systemPrompt || prompt.system;
    const outputRules = outputRulesFor(language);
    const finalSystem = systemContent.includes(outputRules)
      ? systemContent
      : `${systemContent}\n\n${outputRules}`;

    let response;
    try {
      const fetchImpl = this._config.fetch || globalThis.fetch;
      response = await fetchImpl(`${this._config.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this._config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this._config.model,
          max_tokens: maxTokens,
          system: finalSystem,
          messages: [{ role: 'user', content: _rawUserPrompt || prompt.user }],
        }),
      });
    } catch (error) {
      throw classifyRequestError(error, options.signal);
    }

    const status = normalizeHttpStatus(response?.status);
    if (!response || typeof response.ok !== 'boolean') {
      await discardResponseBody(response);
      throw new AIProviderError('provider_invalid_response', status);
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new AIProviderError('provider_http_error', status);
    }

    const data = await readProviderJson(response, status, options.signal);
    if (!Array.isArray(data?.content)) {
      throw new AIProviderError('provider_invalid_response', status);
    }
    const text = data.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
    if (!text.trim()) throw new AIProviderError('provider_invalid_response', status);

    return {
      text,
      model: this._config.model,
      usage: {
        input: normalizeTokenCount(data.usage?.input_tokens),
        output: normalizeTokenCount(data.usage?.output_tokens),
      },
    };
  }
}

class AIProviderError extends Error {
  constructor(code, status = null) {
    const normalizedStatus = normalizeHttpStatus(status);
    super(`AI provider request failed (${code}${normalizedStatus === null ? '' : `; status=${normalizedStatus}`})`);
    this.name = 'AIProviderError';
    this.code = code;
    this.status = normalizedStatus;
    this.provider = PROVIDER_ID;
  }
}

function classifyRequestError(error, signal) {
  const aborted = signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
  return new AIProviderError(aborted ? 'provider_aborted' : 'provider_network_error');
}

async function readProviderJson(response, status, signal) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    throw new AIProviderError('provider_invalid_response', status);
  }

  if (declaredBodyLength(response) > MAX_PROVIDER_RESPONSE_BYTES) {
    await discardResponseBody(response);
    throw new AIProviderError('provider_response_too_large', status);
  }

  let reader;
  const chunks = [];
  let totalBytes = 0;
  try {
    reader = body.getReader();
    while (true) {
      const result = await readWithAbort(reader, signal);
      if (!result || typeof result.done !== 'boolean') throw new TypeError('Invalid stream result');
      if (result.done) break;

      const chunk = asByteChunk(result.value);
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > MAX_PROVIDER_RESPONSE_BYTES - totalBytes) {
        await cancelReader(reader);
        throw new AIProviderError('provider_response_too_large', status);
      }
      chunks.push(chunk.slice());
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    await cancelReader(reader);
    if (signal?.aborted) throw new AIProviderError('provider_aborted', status);
    throw new AIProviderError('provider_invalid_response', status);
  } finally {
    try { reader?.releaseLock(); } catch {}
  }

  if (totalBytes === 0) throw new AIProviderError('provider_invalid_response', status);
  try {
    const bytes = joinChunks(chunks, totalBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Invalid JSON envelope');
    }
    return data;
  } catch {
    throw new AIProviderError('provider_invalid_response', status);
  }
}

function readWithAbort(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function discardResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function cancelReader(reader) {
  try { await reader?.cancel?.(); } catch {}
}

function declaredBodyLength(response) {
  try {
    const value = Number(response?.headers?.get?.('content-length'));
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  } catch {
    return -1;
  }
}

function asByteChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Invalid response chunk');
}

function joinChunks(chunks, totalBytes) {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function normalizeTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}
