/** Operational derivations shared by the overview and the queue/operations pages. */

import type { ChannelRecord, ChannelStatus, RecoveryTarget, SelectionStats } from '../api/types';
import type { BadgeTone } from '../components/badge';
import { formatNumber } from './format';
import { SELECTION_STEPS } from './labels';

/** Id of the cutover section heading of the channel form. */
export const CUTOVER_SECTION_ID = 'section-cutover';

/**
 * Whether the channel still waits for its cutover instant: the server then
 * refuses resume, manual runs, and output retries (409 `cutover_required`).
 */
export function isCutoverPending(channel: Pick<ChannelStatus, 'cutoverRequired' | 'notBefore'> | undefined): boolean {
  return channel?.cutoverRequired === true && !channel.notBefore;
}

/** The cutover section of the channel's edit page. */
export function cutoverSectionPath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}/edit#${CUTOVER_SECTION_ID}`;
}

/** `Lấy về: 40 → Mới: 10 → …` for the steps the scan reported. */
export function formatSelectionChain(selection: SelectionStats | null | undefined): string | null {
  if (!selection) return null;
  const steps = SELECTION_STEPS.filter(([key]) => selection[key] !== undefined && selection[key] !== null);
  if (steps.length === 0) return null;
  return steps.map(([key, label]) => `${label}: ${formatNumber(selection[key])}`).join(' → ');
}

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
