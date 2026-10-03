import { runAppMigrations } from '../../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../../src/app/db/node-sql-storage.js';
import { createRuntime } from '../../../src/app/runtime/create-runtime.js';
import { CredentialRepository } from '../../../src/app/secrets/credential-repository.js';
import { SecretVault } from '../../../src/app/secrets/vault.js';
import { SQLiteDeliveryStore } from '../../../src/core/sqlite-delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../../helpers/fakes.js';
import { createTempDataDir } from './temp-data-dir.js';

export const OPERATOR = 'ops@example.test';
export const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
export const SECRETS = Object.freeze({
  botToken: '123456:FAKE-runtime-bot-token',
  chatId: '-1001234567890',
  aiKey: 'fake-runtime-ai-key',
});
export const SILENT_LOGGER = Object.freeze({ log() {}, warn() {}, error() {} });

/** A clock tests can move; every runtime component reads it. */
export function mutableClock(start = '2026-10-03T08:00:00.000Z') {
  let current = new Date(start);
  const clock = () => new Date(current);
  clock.set = value => { current = new Date(value); };
  clock.advance = ms => { current = new Date(current.getTime() + ms); };
  return clock;
}

/** Articles from a trusted technology category pass the tech gate. */
export function techArticle(id, title, overrides = {}) {
  return {
    id,
    title,
    url: `https://example.test/${id}`,
    content: `${title}. Engineering details for platform teams.`,
    source: 'Recording Source',
    category: 'AI/ML',
    ...overrides,
  };
}

/** Records cron registrations; `fire()` simulates a tick. */
export class FakeCron {
  constructor() {
    this.tasks = [];
  }

  schedule(expression, callback, options) {
    const task = {
      expression,
      callback,
      options,
      stopped: false,
      destroyed: false,
      stop() { this.stopped = true; },
      destroy() { this.destroyed = true; },
    };
    this.tasks.push(task);
    return task;
  }

  /** Active (not stopped) tasks, keyed by channel id. */
  active() {
    return new Map(this.tasks.filter(task => !task.stopped).map(task => [task.options.name.replace(/^channel:/, ''), task]));
  }

  fire(channelId, date) {
    const task = this.active().get(channelId);
    if (!task) throw new Error(`No active cron task for ${channelId}`);
    return task.callback(date ? { date: new Date(date) } : undefined);
  }
}

/** Manual timers: nothing fires unless a test calls `runIntervals()`. */
export class FakeTimers {
  constructor() {
    this.intervals = new Map();
    this.timeouts = new Map();
    this._next = 1;
  }

  setInterval(callback, ms) {
    const id = this._next++;
    this.intervals.set(id, { callback, ms });
    return id;
  }

  clearInterval(id) { this.intervals.delete(id); }

  setTimeout(callback, ms) {
    const id = this._next++;
    this.timeouts.set(id, { callback, ms });
    return id;
  }

  clearTimeout(id) { this.timeouts.delete(id); }

  async runIntervals() {
    for (const { callback } of [...this.intervals.values()]) await callback();
  }

  fireTimeouts() {
    const due = [...this.timeouts.entries()];
    this.timeouts.clear();
    for (const [, { callback }] of due) callback();
  }
}

/**
 * A database with migrations, a delivery store, an initialized vault, and
 * three stored credentials.
 */
export async function createRuntimeDatabase(t, { clock = mutableClock() } = {}) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  const storage = createNodeSqlStorage(db);
  const deliveryStore = new SQLiteDeliveryStore(storage);
  await deliveryStore.initialize();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: clock() });
  const vault = new SecretVault({ storage, masterKey: MASTER_KEY, clock });
  vault.initialize();
  const credentials = new CredentialRepository({ storage, vault, clock });
  const credentialIds = {
    botToken: credentials.create({ label: 'Bot', kind: 'telegram_bot_token', value: SECRETS.botToken, actor: OPERATOR }).id,
    chatId: credentials.create({ label: 'Chat', kind: 'telegram_chat_id', value: SECRETS.chatId, actor: OPERATOR }).id,
    aiKey: credentials.create({ label: 'Claude', kind: 'ai_api_key', value: SECRETS.aiKey, actor: OPERATOR }).id,
  };
  return { workspace, db, storage, deliveryStore, vault, credentials, credentialIds, clock };
}

/** Valid channel input that references the fixture's stored credentials. */
export function channelInput(credentialIds, overrides = {}) {
  return {
    id: 'telegram-ops',
    name: 'Telegram Ops',
    enabled: true,
    mode: 'drip',
    cron: '0 * * * *',
    timezone: 'Asia/Singapore',
    sources: [{ type: 'preset', preset: 'bigTechBlogs', enabled: true }],
    prompt: { language: 'vi', style: 'digest', audience: 'IT', customSystemPrompt: null },
    ai: { provider: 'claude', model: 'claude-sonnet-4-20250514', apiKeyCredentialId: credentialIds.aiKey },
    telegram: { botTokenCredentialId: credentialIds.botToken, chatIdCredentialId: credentialIds.chatId },
    limits: { batchSize: 1, delayMs: 0, dailyLimit: 18, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
    ...overrides,
  };
}

/**
 * A runtime on a temp database with fake cron/timers and recording plugins
 * shared by every run (`plugins.source.articles` can be changed between runs).
 */
export async function createRuntimeFixture(t, {
  clock = mutableClock(),
  articles = [],
  aiText = 'Bản tin công nghệ đã tóm tắt',
  outputResults = [],
  ai = null,
  ownerId = 'runtime-test-owner',
  logger = SILENT_LOGGER,
  runtimeOptions = {},
} = {}) {
  const database = await createRuntimeDatabase(t, { clock });
  const plugins = {
    source: new RecordingSource(articles),
    ai: ai ?? new RecordingAI(aiText),
    output: new RecordingOutput({ results: outputResults }),
  };
  const cron = new FakeCron();
  const timers = new FakeTimers();
  const runtime = await createRuntime({
    db: database.db,
    dataDir: database.workspace.dataDir,
    vault: database.vault,
    deliveryStore: database.deliveryStore,
    cron,
    timers,
    clock,
    logger,
    ownerId,
    channelFactories: {
      createSources: () => [plugins.source],
      createAI: () => plugins.ai,
      createOutput: () => plugins.output,
    },
    ...runtimeOptions,
  });
  t.after(() => runtime.stop({ timeoutMs: 1_000 }));
  return { ...database, runtime, plugins, cron, timers };
}

/** Pause → create, then resume as an operator with the current state version. */
export async function createActiveChannel(runtime, credentialIds, overrides = {}) {
  const record = await runtime.createChannel(channelInput(credentialIds, overrides), OPERATOR);
  const status = await runtime.getStatus(record.id);
  await runtime.control(record.id, 'resume', {
    idempotencyKey: `resume-${record.id}-${status.version}`,
    expectedVersion: status.version,
    reason: 'Ready to deliver',
  }, OPERATOR);
  return record;
}
