/**
 * AI Plugin: OpenAI-compatible API
 * Works with: OpenAI, Groq, OpenRouter, Together, Ollama, LM Studio, vLLM, etc.
 */

import { AIPlugin } from '../core/contracts.js';
import { buildPromptForDelivery, VIETNAMESE_OUTPUT_RULES } from './_prompts.js';

const PROVIDER_ID = 'openai-compatible';
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export class OpenAICompatibleAI extends AIPlugin {
  /**
   * @param {Object} config
   * @param {string} [config.apiKey]
   * @param {string} [config.model='gpt-4o-mini']
   * @param {string} [config.baseUrl='https://api.openai.com/v1']
   * @param {string} [config.name]          - Custom display name
   * @param {Object} [config.extraHeaders]  - Additional headers
   * @param {Object} [config.extraBody]     - Additional body params
   * @param {typeof fetch} [config.fetch]   - Optional injected transport
   */
  constructor(config = {}) {
    super();
    this._config = {
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      ...config,
    };
  }

  get id() { return 'openai-compatible'; }
  get name() { return this._config.name || `OpenAI (${this._config.model})`; }

  async summarize(articles, options = {}) {
    const { language = 'vi', style = 'digest', audience, platform, systemPrompt, _rawUserPrompt, maxTokens = 4096 } = options;
    const prompt = buildPromptForDelivery(articles, {
      language,
      style,
      audience,
      platform,
      deliveryMode: options.deliveryMode,
    });
    const systemContent = systemPrompt || prompt.system;
    const finalSystem = systemContent.includes(VIETNAMESE_OUTPUT_RULES)
      ? systemContent
      : `${systemContent}\n\n${VIETNAMESE_OUTPUT_RULES}`;

    const headers = {
      'Content-Type': 'application/json',
      ...this._config.extraHeaders,
    };
    if (this._config.apiKey) {
      headers['Authorization'] = `Bearer ${this._config.apiKey}`;
    }

    let response;
    try {
      const fetchImpl = this._config.fetch || globalThis.fetch;
      response = await fetchImpl(`${this._config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options.signal,
        headers,
        body: JSON.stringify({
          model: this._config.model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: finalSystem },
            { role: 'user', content: _rawUserPrompt || prompt.user },
          ],
          ...this._config.extraBody,
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
    const choice = data?.choices?.[0]?.message?.content;
    if (typeof choice !== 'string' || !choice.trim()) {
      throw new AIProviderError('provider_invalid_response', status);
    }

    return {
      text: choice,
      model: typeof data.model === 'string' && data.model.length <= 256
        ? data.model
        : this._config.model,
      usage: data.usage ? {
        input: normalizeTokenCount(data.usage.prompt_tokens),
        output: normalizeTokenCount(data.usage.completion_tokens),
      } : undefined,
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

// ============================================
// Pre-configured factory helpers
// ============================================

/** OpenAI GPT */
export function openai(apiKey, model = 'gpt-4o-mini') {
  return new OpenAICompatibleAI({ apiKey, model, name: `OpenAI (${model})` });
}

/** Groq (ultra fast inference) */
export function groq(apiKey, model = 'llama-3.3-70b-versatile') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://api.groq.com/openai/v1',
    name: `Groq (${model})`,
  });
}

/** OpenRouter (model marketplace) */
export function openRouter(apiKey, model = 'anthropic/claude-3.5-sonnet') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://openrouter.ai/api/v1',
    name: `OpenRouter (${model})`,
  });
}

/** Together AI */
export function togetherAI(apiKey, model = 'meta-llama/Llama-3.3-70B-Instruct-Turbo') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://api.together.xyz/v1',
    name: `Together (${model})`,
  });
}

/** Ollama (local) */
export function ollama(model = 'llama3.2', baseUrl = 'http://localhost:11434/v1') {
  return new OpenAICompatibleAI({
    model, baseUrl,
    name: `Ollama (${model})`,
  });
}

/** Google Gemini via OpenAI-compatible endpoint */
export function gemini(apiKey, model = 'gemini-2.0-flash') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    name: `Gemini (${model})`,
  });
}

/** Google Gemini via Cloudflare AI Gateway with a stored provider key (BYOK). */
export function geminiGateway({
  accountId,
  gatewayId,
  token,
  model = 'gemini-2.0-flash',
  byokAlias,
  fetch,
}) {
  if (!String(accountId ?? '').trim()) throw new Error('Missing Cloudflare account ID');
  if (!String(gatewayId ?? '').trim()) throw new Error('Missing Cloudflare AI Gateway ID');
  if (!String(token ?? '').trim()) throw new Error('Missing Cloudflare AI Gateway token');

  const gatewayModel = model.startsWith('google-ai-studio/')
    ? model
    : `google-ai-studio/${model}`;
  return new OpenAICompatibleAI({
    apiKey: token,
    model: gatewayModel,
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`,
    name: `Gemini via Cloudflare AI Gateway (${model})`,
    extraHeaders: {
      'cf-aig-gateway-id': gatewayId,
      'cf-aig-collect-log': 'false',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
      ...(byokAlias ? { 'cf-aig-byok-alias': byokAlias } : {}),
    },
    ...(fetch && { fetch }),
  });
}

/** Alibaba Qwen via DashScope OpenAI-compatible endpoint */
export function qwen(apiKey, model = 'qwen-plus') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    name: `Qwen (${model})`,
  });
}

/** DeepSeek */
export function deepseek(apiKey, model = 'deepseek-chat') {
  return new OpenAICompatibleAI({
    apiKey, model,
    baseUrl: 'https://api.deepseek.com/v1',
    name: `DeepSeek (${model})`,
  });
}
