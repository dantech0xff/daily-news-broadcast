/**
 * Operator controls and system pauses for stored channels. Every action goes
 * through the delivery state machine on the same code path as the CLI
 * (`executeRecoveryControl`): exact `expectedVersion`, durable
 * `idempotencyKey` replay, bounded `reason`, and the authenticated operator
 * identity as `operatorId`. The library is re-synced after every action.
 */

import { randomUUID } from 'node:crypto';

import { executeRecoveryControl as defaultExecuteRecoveryControl } from '../../adapters/node.js';
import { sanitizeRuntimeError } from '../../channels/runner.js';
import { DeliveryStateMachine } from '../../core/delivery-state-machine.js';
import { ChannelNotFoundError } from '../channels/channel-repository.js';
import { CHANNEL_ID_PATTERN } from '../channels/config-schema.js';
import {
  IssueCollector,
  ValidationError,
  readBoolean,
  readObject,
  readString,
  requireActor,
} from '../channels/validation.js';
import { readQueryInteger } from '../db/content-repository.js';
import { assertCutoverReady } from './cutover-guard.js';
import { RuntimeError } from './errors.js';

export const CONTROL_ACTIONS = Object.freeze([
  'pause', 'resume', 'retry-generation', 'retry-output',
  'restore-topology', 'confirm-delivered', 'abandon', 'retry-maintenance',
]);
export const MAX_CONTROL_REASON_LENGTH = 500;
export const SYSTEM_OPERATOR_ID = 'system';
export const NEW_CHANNEL_PAUSE_REASON = 'New channel starts paused until an operator resumes it';

// Actions that call the channel's AI or output, or compare its output
// topology, need the channel built with its credentials.
const BUILD_REQUIRED_ACTIONS = new Set(['resume', 'retry-generation', 'retry-output', 'restore-topology']);
// Actions that start delivering: refused while the channel's cutover instant is unset.
const CUTOVER_GUARDED_ACTIONS = new Set(['resume', 'retry-output']);
const DELIVERY_TARGET_ACTIONS = new Set(['retry-generation', 'retry-output', 'restore-topology', 'confirm-delivered', 'abandon']);
const OUTPUT_TARGET_ACTIONS = new Set(['retry-output', 'confirm-delivered']);
const PARAM_KEYS = Object.freeze([
  'idempotencyKey', 'expectedVersion', 'reason', 'deliveryId', 'outputKey', 'outboxId', 'messageId',
  'confirmPausedMutation', 'confirmDuplicateRisk',
]);
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const PAUSE_ATTEMPTS = 3;

/**
 * @typedef {object} ControlParams
 * @property {string} idempotencyKey 1–200 visible ASCII characters; replays return the first result.
 * @property {number} expectedVersion Channel-state version (pause/resume) or target version.
 * @property {string} reason At most 500 characters.
 * @property {string} [deliveryId] Required for delivery and output targets.
 * @property {string} [outputKey] Required for retry-output and confirm-delivered.
 * @property {string} [outboxId] Required for retry-maintenance.
 * @property {string} [messageId] Optional provider message id when confirming delivery.
 * @property {boolean} [confirmPausedMutation] Authorize a retry while the channel is paused.
 * @property {boolean} [confirmDuplicateRisk] Accept the duplicate risk of retrying an ambiguous output.
 */

export class ChannelControls {
  /**
   * @param {{
   *   channels: import('../channels/channel-repository.js').ChannelRepository,
   *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
   *   cache: import('../../core/contracts.js').CachePlugin,
   *   buildChannel: (record: object) => Promise<object>,
   *   contentSync: import('./content-sync.js').ContentSync,
   *   clock?: () => Date,
   *   executeRecoveryControl?: typeof defaultExecuteRecoveryControl,
   * }} options
   */
  constructor({
    channels, deliveryStore, cache, buildChannel, contentSync,
    clock = () => new Date(), executeRecoveryControl = defaultExecuteRecoveryControl,
  }) {
    this._channels = channels;
    this._store = deliveryStore;
    this._cache = cache;
    this._buildChannel = buildChannel;
    this._contentSync = contentSync;
    this._clock = clock;
    this._executeRecoveryControl = executeRecoveryControl;
  }

  /**
   * Pause a channel's delivery state through the state machine. Idempotent:
   * an already paused channel is left untouched. Works before the channel's
   * config row exists, so callers pause first and insert second; a crash in
   * between can never leave an unpaused channel behind.
   * @param {string} channelId
   * @param {{ operatorId?: string, reason?: string }} [context]
   * @returns {Promise<{ status: 'paused'|'already_paused', channelId: string, paused: true, version: number }>}
   */
  async pauseChannel(channelId, { operatorId = SYSTEM_OPERATOR_ID, reason = NEW_CHANNEL_PAUSE_REASON } = {}) {
    if (typeof channelId !== 'string' || !CHANNEL_ID_PATTERN.test(channelId)) {
      throw new TypeError('pauseChannel requires a kebab-case channel id');
    }
    const operator = requireActor(operatorId);
    const pauseReason = requireReason(reason);
    const machine = new DeliveryStateMachine({ store: this._store, channelId, clock: this._clock });
    for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt += 1) {
      const state = await machine.getChannelState();
      if (state?.paused === true) return { status: 'already_paused', channelId, paused: true, version: state.version };
      try {
        // A channel without state gets it created at version 1 inside the same transaction.
        const result = await machine.setPaused(true, {
          expectedVersion: state?.version ?? 1,
          idempotencyKey: `system-pause:${randomUUID()}`,
          operatorId: operator,
          reason: pauseReason,
        });
        return { status: 'paused', channelId, paused: true, version: result.channel.version };
      } catch (error) {
        // Another writer changed the channel state between the read and the pause; re-read.
        if (!/version conflict/i.test(String(error?.message))) throw error;
      }
    }
    throw new RuntimeError('control_rejected', `Channel "${channelId}" could not be paused because its delivery state kept changing`);
  }

  /**
   * Apply one operator action. Resume and output retries are refused
   * (`cutover_required`) while a cutover channel's `notBefore` is unset.
   * Resume is refused unless the channel builds with every credential it
   * needs; the error names the missing slots only.
   * @param {string} channelId
   * @param {string} action One of `CONTROL_ACTIONS`.
   * @param {ControlParams} params
   * @param {string} actor Authenticated operator identity (audit `operatorId`).
   * @returns {Promise<{ channelId: string, action: string, status: string, replayed: boolean } & Record<string, unknown>>}
   * @throws {ValidationError|ChannelNotFoundError|RuntimeError|import('../channels/build-channel.js').ChannelCredentialError}
   */
  async execute(channelId, action, params, actor) {
    const operatorId = requireActor(actor);
    const normalized = readControlParams(action, params);
    const record = this._channels.get(channelId);
    if (!record) throw new ChannelNotFoundError(channelId);
    if (CUTOVER_GUARDED_ACTIONS.has(action)) assertCutoverReady(record);
    const channel = BUILD_REQUIRED_ACTIONS.has(action) ? await this._buildChannel(record) : { id: record.id };
    try {
      const result = await this._executeRecoveryControl(channel, { ...normalized, action, operatorId }, {
        cache: this._cache,
        deliveryStore: this._store,
        clock: this._clock,
      });
      return { channelId: record.id, action, ...result };
    } catch (error) {
      throw classifyControlError(error);
    } finally {
      await this._contentSync.syncQuietly(record.id);
    }
  }
}

/**
 * Validate operator control input.
 * @param {string} action
 * @param {unknown} params
 * @returns {Omit<ControlParams, 'confirmPausedMutation'|'confirmDuplicateRisk'> & { confirmPausedMutation: boolean, confirmDuplicateRisk: boolean }}
 * @throws {ValidationError}
 */
export function readControlParams(action, params) {
  const issues = new IssueCollector();
  if (!CONTROL_ACTIONS.includes(action)) {
    issues.add('action', 'invalid_value', `Thao tác hợp lệ: ${CONTROL_ACTIONS.join(', ')}.`);
    throw new ValidationError('Control request is invalid', issues.issues);
  }
  const value = readObject(issues, params, '', { allowed: PARAM_KEYS }) ?? {};
  const normalized = {
    idempotencyKey: readString(issues, value.idempotencyKey, 'idempotencyKey', {
      required: true,
      max: 200,
      pattern: VISIBLE_ASCII,
      patternMessage: 'Chỉ gồm ký tự ASCII hiển thị, không khoảng trắng.',
    }),
    expectedVersion: readQueryInteger(issues, value.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER, undefined),
    reason: readString(issues, value.reason, 'reason', { required: true, max: MAX_CONTROL_REASON_LENGTH }),
    deliveryId: readTarget(issues, value.deliveryId, 'deliveryId', 500, DELIVERY_TARGET_ACTIONS.has(action)),
    outputKey: readTarget(issues, value.outputKey, 'outputKey', 500, OUTPUT_TARGET_ACTIONS.has(action)),
    outboxId: readTarget(issues, value.outboxId, 'outboxId', 500, action === 'retry-maintenance'),
    messageId: readTarget(issues, value.messageId, 'messageId', 200, false),
    confirmPausedMutation: readBoolean(issues, value.confirmPausedMutation, 'confirmPausedMutation', { defaultValue: false }),
    confirmDuplicateRisk: readBoolean(issues, value.confirmDuplicateRisk, 'confirmDuplicateRisk', { defaultValue: false }),
  };
  if (normalized.expectedVersion === undefined && !issues.issues.some(issue => issue.field === 'expectedVersion')) {
    issues.add('expectedVersion', 'required', 'Bắt buộc.');
  }
  if (issues.hasIssues) throw new ValidationError('Control request is invalid', issues.issues);
  return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== null && entry !== undefined));
}

function readTarget(issues, value, field, max, required) {
  return readString(issues, value, field, {
    required,
    max,
    pattern: VISIBLE_ASCII,
    patternMessage: 'Chỉ gồm ký tự ASCII hiển thị, không khoảng trắng.',
  });
}

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > MAX_CONTROL_REASON_LENGTH) {
    throw new TypeError(`Pause reason must be a non-empty string of at most ${MAX_CONTROL_REASON_LENGTH} characters`);
  }
  return reason.trim();
}

function classifyControlError(error) {
  if (error instanceof ValidationError || error instanceof RuntimeError || error instanceof TypeError) return error;
  const message = sanitizeRuntimeError(error);
  if (/version conflict/i.test(message)) return new RuntimeError('version_conflict', message, { cause: error });
  if (/not found/i.test(message)) return new RuntimeError('target_not_found', message, { cause: error });
  return new RuntimeError('control_rejected', message, { cause: error });
}
