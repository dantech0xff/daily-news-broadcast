/**
 * Stream Runner — Builds NewsEngine from stream config JSON, executes pipeline
 * Supports $ENV_VAR references in config values (resolved at runtime).
 */

import {
  DeliveryStateMachine,
  NewsEngine,
  PrefixedCache,
  buildOutputTopology,
  normalizeSendResult,
  opaqueId,
} from '../core/index.js';
import { deriveLocalForceIdentifiers, sanitizeRuntimeError } from '../channels/runner.js';
import { RSSSource, HTMLScraperSource, HackerNewsSource, RedditSource, DevToSource, JSONAPISource } from '../sources/index.js';
import { ClaudeAI, openai, groq, gemini, ollama, openRouter, togetherAI, qwen, deepseek, OpenAICompatibleAI } from '../ai/index.js';
import { TelegramOutput, SlackOutput, DiscordOutput, EmailOutput, WebhookOutput, MarkdownFileOutput } from '../outputs/index.js';
import { bigTechBlogs, communitySources, aiMLBlogs, aiNewsSources, aiDeepDiveSources, devopsSources, mobileSources } from '../presets/index.js';

const DEFAULT_GENERATION_TIMEOUT_MS = 25_000;
const DEFAULT_OUTPUT_TIMEOUT_MS = 25_000;

// ============================================
// Env var resolution — "$VAR_NAME" → process.env.VAR_NAME
// ============================================

function resolveEnv(value, env) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key = value.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment reference: ${value}`);
    const resolved = env[key];
    if (resolved === undefined || resolved === '' || String(resolved).startsWith('$')) {
      throw new Error(`Unresolved environment reference: ${key}`);
    }
    return resolved;
  }
  return value;
}

function resolveConfig(obj, env) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(value => resolveConfig(value, env));
  const resolved = {};
  for (const [k, v] of Object.entries(obj)) {
    resolved[k] = typeof v === 'object' ? resolveConfig(v, env) : resolveEnv(v, env);
  }
  return resolved;
}

export function resolveStreamConfig(streamConfig, env = process.env) {
  return resolveConfig(streamConfig, env);
}

const STREAM_INTEGER_OPTIONS = Object.freeze({
  concurrency: [1, 50],
  batchSize: [1, 100],
  delayMs: [0, 3_600_000],
  maxArticles: [1, 500],
  maxArticlesPerSource: [1, 100],
});

// ============================================
// Source factories
// ============================================

const SOURCE_FACTORIES = {
  rss: (cfg) => new RSSSource(cfg),
  'html-scraper': (cfg) => new HTMLScraperSource(cfg),
  hackernews: (cfg) => new HackerNewsSource(cfg),
  reddit: (cfg) => new RedditSource(cfg),
  devto: (cfg) => new DevToSource(cfg),
  'json-api': (cfg) => new JSONAPISource(cfg),
};

const PRESET_FACTORIES = {
  bigTechBlogs,
  communitySources,
  aiMLBlogs,
  aiNewsSources,
  aiDeepDiveSources,
  devopsSources,
  mobileSources,
};

/** Resolve environment references and reject unsafe stream runtime values. */
export function validateStreamConfig(streamConfig, env = process.env) {
  const resolved = resolveStreamConfig(streamConfig, env);
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error('Stream config must be an object');
  }
  if (!['digest', 'drip'].includes(resolved.mode || 'digest')) {
    throw new Error(`Invalid stream mode: ${resolved.mode}`);
  }
  if (!Array.isArray(resolved.sources)) throw new Error(`Stream ${resolved.id || '<unknown>'} sources must be an array`);
  if (!Array.isArray(resolved.outputs)) throw new Error(`Stream ${resolved.id || '<unknown>'} outputs must be an array`);
  if (resolved.options !== undefined
    && (!resolved.options || typeof resolved.options !== 'object' || Array.isArray(resolved.options))) {
    throw new Error(`Stream ${resolved.id || '<unknown>'} options must be an object`);
  }

  const options = { ...(resolved.options || {}) };
  for (const [key, [minimum, maximum]] of Object.entries(STREAM_INTEGER_OPTIONS)) {
    if (options[key] === undefined) continue;
    options[key] = configuredInteger(options[key], `Stream ${resolved.id || '<unknown>'} ${key}`, minimum, maximum);
  }
  return { ...resolved, options };
}

function createSource(config) {
  if (config.type === 'preset') {
    const fn = PRESET_FACTORIES[config.preset];
    if (!fn) throw new Error(`Unknown preset: ${config.preset}`);
    return fn();
  }
  const factory = SOURCE_FACTORIES[config.type];
  if (!factory) throw new Error(`Unknown source type: ${config.type}`);
  return factory(config.config || {});
}

// ============================================
// AI factories
// ============================================

function createAI(config) {
  if (!config || config.provider === 'none') return null;
  const { provider, model, baseUrl, name: customName } = config;
  const apiKey = config.apiKey;

  switch (provider) {
    case 'claude': return new ClaudeAI({ apiKey, ...(model && { model }), ...(baseUrl && { baseUrl }) });
    case 'openai': return openai(apiKey, model || 'gpt-4o-mini');
    case 'groq': return groq(apiKey, model || 'llama-3.3-70b-versatile');
    case 'gemini': return gemini(apiKey, model || 'gemini-2.0-flash');
    case 'qwen': return qwen(apiKey, model || 'qwen-plus');
    case 'deepseek': return deepseek(apiKey, model || 'deepseek-chat');
    case 'ollama': return ollama(model || 'llama3.2', baseUrl || 'http://localhost:11434/v1');
    case 'openrouter': return openRouter(apiKey, model || 'anthropic/claude-3.5-sonnet');
    case 'together': return togetherAI(apiKey, model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    case 'custom': return new OpenAICompatibleAI({ apiKey, baseUrl, model: model || 'default', name: customName || 'Custom AI' });
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

// ============================================
// Output factories
// ============================================

const OUTPUT_FACTORIES = {
  telegram: (cfg) => new TelegramOutput(cfg),
  slack: (cfg) => new SlackOutput(cfg),
  discord: (cfg) => new DiscordOutput(cfg),
  email: (cfg) => new EmailOutput(cfg),
  webhook: (cfg) => new WebhookOutput(cfg),
  markdown: (cfg) => new MarkdownFileOutput(cfg),
};

function createOutput(config) {
  const factory = OUTPUT_FACTORIES[config.type];
  if (!factory) throw new Error(`Unknown output type: ${config.type}`);
  return factory(config.config || {});
}

// ============================================
// Build engine from stream config
// ============================================

export function buildEngine(streamConfig, dependencies = {}) {
  const { cache, deliveryStore, clock, env = process.env, engineFactory = () => new NewsEngine() } = dependencies;
  if (!cache) throw new Error('Dashboard buildEngine requires a shared cache');
  if (!deliveryStore) throw new Error('Dashboard buildEngine requires a shared delivery store');
  const resolvedStream = validateStreamConfig(streamConfig, env);
  const engine = engineFactory();

  for (const src of resolvedStream.sources) {
    const result = createSource(src);
    if (Array.isArray(result)) {
      for (const s of result) engine.addSource(s);
    } else {
      engine.addSource(result);
    }
  }

  if (resolvedStream.ai) {
    const ai = createAI(resolvedStream.ai);
    if (ai) engine.useAI(ai);
  }

  for (const out of resolvedStream.outputs) {
    engine.addOutput(createOutput(out));
  }

  engine.useCache(new PrefixedCache(cache, `news:${resolvedStream.id}`));
  engine.useDeliveryStore(deliveryStore);

  const opts = resolvedStream.options || {};
  engine.configure({
    channelId: resolvedStream.id,
    timezone: resolvedStream.timezone || 'UTC',
    language: 'vi',
    style: resolvedStream.ai?.style || opts.style || 'digest',
    audience: resolvedStream.ai?.audience || opts.audience || 'IT professionals',
    platform: resolvedStream.ai?.platform || opts.platform || 'telegram',
    ...(clock && { clock }),
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    ...(opts.maxArticlesPerSource !== undefined && { maxArticlesPerSource: opts.maxArticlesPerSource }),
  });

  return engine;
}

// ============================================
// Execute a stream
// ============================================

export async function executeStream(streamConfig, options = {}, dependencies = {}) {
  const dryRun = options.dryRun === true || options.triggerType === 'preview';
  const triggerType = dryRun ? 'preview' : (options.triggerType || 'manual');
  if (!['scheduled', 'manual', 'force', 'preview'].includes(triggerType)) {
    return { status: 'error', error: `Invalid trigger type: ${triggerType}`, logs: [] };
  }
  if (!dryRun && options.force === true && triggerType !== 'force') {
    return { status: 'error', error: 'force requires triggerType "force"', logs: [] };
  }
  const logs = [];

  try {
    const resolvedStream = validateStreamConfig(streamConfig, dependencies.env ?? process.env);
    const engine = (dependencies.buildEngine ?? buildEngine)(resolvedStream, dependencies);
    const clock = dependencies.clock ?? (() => new Date());
    engine.setLogger((msg) => logs.push({ time: clock().toISOString(), msg: sanitizeRuntimeError(msg) }));
    const forceIdentifiers = !dryRun && triggerType === 'force'
      ? await resolveForceIdentifiers(resolvedStream.id, options)
      : null;
    const runOptions = {
      dryRun,
      force: !dryRun && triggerType === 'force',
      ...(forceIdentifiers ?? {}),
      ...(options.requestedAt && { requestedAt: options.requestedAt }),
    };
    const result = (resolvedStream.mode || 'digest') === 'drip'
      ? await engine.runDrip({
        ...runOptions,
        ...(resolvedStream.options.batchSize !== undefined && { batchSize: resolvedStream.options.batchSize }),
        ...(resolvedStream.options.delayMs !== undefined && { delayMs: resolvedStream.options.delayMs }),
      })
      : await engine.run(runOptions);
    return { ...result, logs };
  } catch (error) {
    return { status: 'error', error: sanitizeRuntimeError(error), logs };
  }
}

async function resolveForceIdentifiers(channelId, options) {
  if (options.requestId === undefined) {
    return deriveLocalForceIdentifiers(channelId, options.idempotencyKey);
  }
  const opaquePattern = /^[a-f0-9]{64}$/;
  if (!opaquePattern.test(String(options.idempotencyKey)) || !opaquePattern.test(String(options.requestId))) {
    throw new Error('Force engine identifiers must be opaque SHA-256 values');
  }
  return {
    idempotencyKey: String(options.idempotencyKey),
    requestId: String(options.requestId),
  };
}

/** Execute one exact local operator action without exposing durable content snapshots. */
export async function executeStreamControl(streamConfig, action, dependencies = {}) {
  const resolvedStream = validateStreamConfig(streamConfig, dependencies.env ?? process.env);
  const createMachine = dependencies.machineFactory ?? (options => new DeliveryStateMachine(options));
  const clock = dependencies.clock ?? (() => new Date());
  const machine = createMachine({
    store: dependencies.deliveryStore,
    channelId: resolvedStream.id,
    clock,
  });
  const common = {
    action: action.action,
    idempotencyKey: action.idempotencyKey,
    expectedVersion: action.expectedVersion,
    operatorId: action.operatorId,
    reason: action.reason,
  };

  if (action.action === 'pause' || action.action === 'resume') {
    const operatorActionId = await opaqueId('operator-action', resolvedStream.id, action.idempotencyKey);
    if (action.action === 'resume' && !await dependencies.deliveryStore.get('operator_actions', operatorActionId)) {
      await machine.recoverStaleAttempts();
    }
    return projectControlResult(await machine.setPaused(action.action === 'pause', common));
  }

  const retrying = ['retry-generation', 'retry-output'].includes(action.action);
  const requestId = retrying
    ? await opaqueId('local-operator-request', resolvedStream.id, action.action, action.idempotencyKey)
    : null;
  const coreAction = {
    ...common,
    ...(action.deliveryId && { deliveryId: action.deliveryId }),
    ...(action.outputKey && { outputKey: action.outputKey }),
    ...(action.outboxId && { outboxId: action.outboxId }),
    ...(action.messageId && { messageId: action.messageId }),
    ...(requestId && { requestId }),
    confirmPausedMutation: action.confirmPausedMutation === true,
    duplicateRiskAccepted: action.confirmDuplicateRisk === true,
  };
  const operatorActionId = await opaqueId('operator-action', resolvedStream.id, action.idempotencyKey);
  if (await dependencies.deliveryStore.get('operator_actions', operatorActionId)) {
    return projectControlResult(await machine.reconcile(coreAction));
  }
  let engine = null;
  let configuredOutput = null;
  let targetDelivery = null;
  if (['retry-generation', 'restore-topology', 'abandon'].includes(action.action)) {
    targetDelivery = await machine.getDelivery(action.deliveryId);
    if (!targetDelivery || targetDelivery.channelId !== resolvedStream.id) throw new Error('Recovery delivery target was not found');
  }
  if (['retry-output', 'confirm-delivered'].includes(action.action)) {
    targetDelivery = await machine.getDelivery(action.deliveryId);
    if (!targetDelivery || targetDelivery.channelId !== resolvedStream.id) throw new Error('Recovery output target was not found');
    const target = await machine.getOutput(action.deliveryId, action.outputKey);
    if (!target) throw new Error('Recovery output target was not found');
    if (action.action === 'retry-output') configuredOutput = { ordinal: target.ordinal };
  }
  if (retrying) {
    engine = (dependencies.buildEngine ?? buildEngine)(resolvedStream, dependencies);
    const topology = await buildOutputTopology(engine.outputs);
    if (targetDelivery.topologyFingerprint !== topology.fingerprint || targetDelivery.state === 'blocked_topology') {
      throw new Error('Output topology changed before operator retry');
    }
    if (action.action === 'retry-output') {
      configuredOutput = engine.outputs[configuredOutput.ordinal];
      if (!configuredOutput) throw new Error('Output topology changed before operator retry');
    }
  }
  if (action.action === 'restore-topology') {
    engine = (dependencies.buildEngine ?? buildEngine)(resolvedStream, dependencies);
    const topology = await buildOutputTopology(engine.outputs);
    if (targetDelivery.topologyFingerprint !== topology.fingerprint) {
      throw new Error('Configured output topology has not been restored');
    }
    coreAction.topologyFingerprint = topology.fingerprint;
  }
  if (action.action === 'retry-maintenance') {
    const target = (await machine.listOutbox(value => value.outboxId === action.outboxId))[0];
    if (!target) throw new Error('Recovery maintenance target was not found');
    engine = (dependencies.buildEngine ?? buildEngine)(resolvedStream, dependencies);
  }
  if (action.action === 'retry-generation') {
    if (typeof engine.ai?.summarize !== 'function') {
      throw new Error('Configured AI provider is unavailable for generation retry');
    }
  }
  const result = await machine.reconcile(coreAction);
  if (result.replayed || result.status !== 'claimed') return projectControlResult(result);

  if (action.action === 'retry-generation') {
    try {
      const timeoutMs = attemptBoundedTimeoutMs(
        result.attempt,
        engine.options?.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
        clock,
        'Generation retry',
      );
      const generated = await withOperationTimeout(signal => engine.ai.summarize(result.articles, {
        language: 'vi',
        style: resolvedStream.ai?.style || resolvedStream.options?.style,
        audience: resolvedStream.ai?.audience || resolvedStream.options?.audience,
        platform: resolvedStream.ai?.platform || resolvedStream.options?.platform,
        deliveryMode: result.delivery.mode,
        signal,
      }), timeoutMs, 'Generation retry');
      const delivery = await machine.commitGeneration(result.attempt.attemptId, { content: generated.text });
      return projectControlResult({ status: delivery.state, delivery });
    } catch (error) {
      const delivery = await machine.failGeneration(result.attempt.attemptId, error, { retryDisposition: 'never' });
      return projectControlResult({ status: delivery.state, delivery });
    }
  }

  if (action.action === 'retry-output') {
    if (configuredOutput.id !== result.output.providerId) {
      throw new Error('Output topology changed during operator retry');
    }
    let normalized;
    try {
      const timeoutMs = attemptBoundedTimeoutMs(
        result.attempt,
        engine.options?.outputTimeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS,
        clock,
        'Output retry',
      );
      normalized = normalizeSendResult(await withOperationTimeout(signal => configuredOutput.send(
        targetDelivery.singleMutation === true ? result.content : fitToOutput(result.content, configuredOutput),
        {
          articles: targetDelivery.articleSnapshot,
          article: targetDelivery.mode === 'drip' ? targetDelivery.articleSnapshot[0] : undefined,
          deliveryId: targetDelivery.deliveryId,
          attemptId: result.attempt.attemptId,
          singleMutation: targetDelivery.singleMutation === true,
          signal,
        },
      ), timeoutMs, 'Output retry'), { now: new Date(clock()).getTime() });
    } catch (error) {
      normalized = normalizeSendResult(null, { error, now: new Date(clock()).getTime() });
    }
    const committed = await machine.commitOutput(result.attempt.attemptId, normalized);
    return projectControlResult({ status: committed.delivery.state, delivery: committed.delivery });
  }

  if (action.action === 'retry-maintenance') {
    try {
      await engine.cache.set(
        result.outbox.targetKey,
        result.outbox.targetValue,
        result.outbox.kind === 'legacy_digest' ? 30 * 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000,
      );
      const outbox = await machine.commitMaintenance(result.outbox.outboxId, { success: true });
      return projectControlResult({ status: outbox.state, outbox });
    } catch (error) {
      const outbox = await machine.commitMaintenance(result.outbox.outboxId, { success: false, error });
      return projectControlResult({ status: outbox.state, outbox });
    }
  }

  return projectControlResult(result);
}

function projectControlResult(result) {
  const delivery = result.delivery;
  const channel = result.channel;
  const outbox = result.outbox;
  return {
    status: String(result.status ?? 'failed').slice(0, 80),
    ...(delivery ? {
      deliveryId: delivery.deliveryId,
      deliveryState: delivery.state,
      version: delivery.version,
    } : {}),
    ...(channel ? {
      channelId: channel.channelId,
      paused: channel.paused === true,
      version: channel.version,
    } : {}),
    ...(outbox ? {
      outboxId: outbox.outboxId,
      outboxState: outbox.state,
      version: outbox.version,
    } : {}),
    replayed: result.replayed === true,
  };
}

function fitToOutput(content, output) {
  const maxLength = output.maxLength ?? Infinity;
  if (content.length <= maxLength) return content;
  const truncated = content.substring(0, Math.max(0, maxLength - 50));
  const lastBreak = truncated.lastIndexOf('\n\n');
  return (lastBreak > content.length * 0.5 ? truncated.substring(0, lastBreak) : truncated) + '\n\n[...]';
}

function attemptBoundedTimeoutMs(attempt, preferredTimeoutMs, clock, label) {
  const preferred = Number(preferredTimeoutMs);
  if (!Number.isSafeInteger(preferred) || preferred <= 0) {
    throw new Error(`${label} timeout must be a positive safe integer`);
  }
  const startedAt = Date.parse(attempt?.startedAt);
  const deadlineAt = Date.parse(attempt?.deadlineAt);
  const nowValue = clock();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= startedAt) {
    throw new Error(`${label} attempt lease is invalid`);
  }
  if (!Number.isFinite(now.getTime())) throw new Error(`${label} clock is invalid`);
  const leaseMs = deadlineAt - startedAt;
  const remainingMs = deadlineAt - now.getTime();
  const strictCeiling = Math.floor(Math.min(leaseMs, remainingMs) - 1);
  if (strictCeiling < 1) throw new Error(`${label} attempt lease expired before the provider call`);
  return Math.min(preferred, Math.max(1, Math.floor(leaseMs - 100)), strictCeiling);
}

async function withOperationTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function configuredInteger(value, label, minimum, maximum) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} must be an integer in range ${minimum}-${maximum}`);
  }
  return normalized;
}
