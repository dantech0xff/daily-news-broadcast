/** Operational derivations shared by the overview and the queue/operations pages. */

import type { ChannelRecord, ChannelStatus, RecoveryTarget } from '../api/types';
import type { BadgeTone } from '../components/badge';

/**
 * Delivery states that wait for an operator (the engine's "blocked" states);
 * other unresolved deliveries are still progressing on their own.
 */
export const OPERATOR_DELIVERY_STATES: ReadonlySet<string> = new Set([
  'manual_generation_retry_pending',
  'generation_exhausted',
  'output_manual_retry_required',
  'output_exhausted',
  'blocked_topology',
  'needs_reconciliation',
]);

/** A recovery target that only an operator action can move forward ("mục kẹt"). */
export function isStuckTarget(target: RecoveryTarget): boolean {
  if (target.kind === 'delivery') return OPERATOR_DELIVERY_STATES.has(target.state);
  // Output targets (ambiguous, manual retry, exhausted) and dead-letter maintenance items.
  return true;
}

export interface ChannelStateView {
  label: string;
  tone: BadgeTone;
}

/** One badge for the channel's overall state (disabled > paused > busy > active). */
export function channelStateView(record: Pick<ChannelRecord, 'enabled'>, status: ChannelStatus | undefined): ChannelStateView {
  if (!record.enabled) return { label: 'Đã tắt', tone: 'slate' };
  if (!status) return { label: 'Đang tải…', tone: 'slate' };
  if (status.paused === true) return { label: 'Tạm dừng', tone: 'amber' };
  if (status.paused === null) return { label: 'Chưa có trạng thái', tone: 'slate' };
  if (status.running) return { label: 'Đang chạy', tone: 'blue' };
  if (status.queued) return { label: 'Đang chờ chạy', tone: 'blue' };
  return { label: 'Đang hoạt động', tone: 'green' };
}

export const MUTATION_STATE_LABELS: Readonly<Record<string, string>> = {
  free: 'Rảnh',
  active: 'Đang gửi',
  blocked_ambiguous: 'Bị chặn: có lần gửi không rõ kết quả',
};
