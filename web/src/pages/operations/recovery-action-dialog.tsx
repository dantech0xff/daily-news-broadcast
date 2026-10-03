/**
 * Confirmation of one recovery action on one exact target (a delivery, one
 * output of a delivery, or a dead-letter maintenance item). The request
 * carries exactly what the server needs:
 * - `deliveryId` for delivery and output actions, plus `outputKey` for
 *   `retry-output` and `confirm-delivered`, `outboxId` for `retry-maintenance`;
 * - `messageId` (optional) when confirming a delivery by hand;
 * - `confirmDuplicateRisk` when retrying an output whose last send has an
 *   unknown outcome, and `confirmPausedMutation` when a retry would call the
 *   AI, Telegram, or the cache while the channel is paused: the server
 *   refuses those retries without the explicit confirmation.
 * The target's `expectedVersion` makes a stale request fail with a version
 * conflict instead of acting on a changed target.
 */

import { useId, useState } from 'react';

import type { ControlAction, ControlResult, RecoveryTarget } from '../../api/types';
import { Checkbox, describedBy, Field, TextInput } from '../../components/form-controls';
import { Notice } from '../../components/states';
import { ControlDialog, type ControlRequest } from '../../features/channel-actions/control-dialog';
import { cn } from '../../lib/cn';
import { formatDay, formatNumber } from '../../lib/format';
import { CONTROL_ACTION_LABELS, DELIVERY_STATE_LABELS, RECOVERY_TARGET_KIND_LABELS, labelOf, recoveryStateLabel } from '../../lib/labels';

/** Actions on a delivery (`deliveryId`). */
const DELIVERY_TARGET_ACTIONS: ReadonlySet<ControlAction> = new Set([
  'retry-generation', 'retry-output', 'restore-topology', 'confirm-delivered', 'abandon',
]);
/** Actions on one output of a delivery (`deliveryId` + `outputKey`). */
const OUTPUT_TARGET_ACTIONS: ReadonlySet<ControlAction> = new Set(['retry-output', 'confirm-delivered']);
/** Retries that the server refuses on a paused channel without `confirmPausedMutation`. */
const PAUSED_GUARDED_ACTIONS: ReadonlySet<ControlAction> = new Set(['retry-generation', 'retry-output', 'retry-maintenance']);
/** The server's rule for target ids and message ids: visible ASCII, no spaces. */
const MESSAGE_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;

interface ActionCopy {
  title: string;
  description: string;
  tone: 'primary' | 'danger';
  /** What the action still does while the channel is paused. */
  pausedEffect?: string;
}

const ACTION_COPY: Partial<Record<ControlAction, ActionCopy>> = {
  'retry-generation': {
    title: 'Tạo lại nội dung?',
    description: 'Gọi lại AI để tạo nội dung cho mục này ngay bây giờ. Thao tác này không gửi bài lên Telegram.',
    tone: 'primary',
    pausedEffect: 'gọi AI',
  },
  'retry-output': {
    title: 'Gửi lại lên Telegram?',
    description: 'Gửi lại nội dung đã tạo của mục này lên Telegram ngay bây giờ.',
    tone: 'primary',
    pausedEffect: 'gửi bài lên Telegram',
  },
  'confirm-delivered': {
    title: 'Xác nhận đã gửi?',
    description: 'Chỉ dùng khi bạn đã kiểm tra trên Telegram và thấy bài đã được đăng: mục được đánh dấu đã đăng mà không gửi lại.',
    tone: 'primary',
  },
  abandon: {
    title: 'Bỏ mục này?',
    description: 'Mục sẽ không được tạo nội dung hay gửi lên Telegram nữa. Không thể hoàn tác.',
    tone: 'danger',
  },
  'restore-topology': {
    title: 'Khôi phục topology?',
    description: 'Chỉ dùng khi cấu hình output Telegram của kênh đã được đưa về giống lúc tạo mục này; máy chủ kiểm tra lại trước khi mở khoá mục.',
    tone: 'primary',
  },
  'retry-maintenance': {
    title: 'Chạy lại bảo trì?',
    description: 'Ghi lại dữ liệu cache của một lần bảo trì bị lỗi. Thao tác này không gửi bài lên Telegram.',
    tone: 'primary',
    pausedEffect: 'ghi cache',
  },
};

export function RecoveryActionDialog({ channelId, target, action, channelPaused, onClose }: {
  channelId: string;
  target: RecoveryTarget;
  action: ControlAction;
  channelPaused: boolean;
  onClose: () => void;
}) {
  const messageInputId = useId();
  const duplicateId = useId();
  const pausedId = useId();
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);
  const [pausedConfirmed, setPausedConfirmed] = useState(false);
  const [messageId, setMessageId] = useState('');

  const label = CONTROL_ACTION_LABELS[action];
  const copy = ACTION_COPY[action] ?? { title: `${label}?`, description: '', tone: 'primary' as const };
  const needsDuplicateConfirm = action === 'retry-output' && target.state === 'needs_reconciliation';
  const needsPausedConfirm = channelPaused && PAUSED_GUARDED_ACTIONS.has(action);
  const asksMessageId = action === 'confirm-delivered';
  const message = messageId.trim();
  const messageError = asksMessageId && message !== '' && !MESSAGE_ID_PATTERN.test(message)
    ? 'Message ID chỉ gồm ký tự ASCII hiển thị (không khoảng trắng), tối đa 200 ký tự.'
    : null;
  const blocker = needsDuplicateConfirm && !duplicateConfirmed
    ? 'Hãy xác nhận rủi ro đăng trùng trước khi gửi lại.'
    : needsPausedConfirm && !pausedConfirmed
      ? 'Hãy xác nhận thực hiện thao tác khi kênh đang tạm dừng.'
      : messageError;

  const request: ControlRequest = {
    channelId,
    action,
    expectedVersion: target.expectedVersion,
    target: {
      ...(DELIVERY_TARGET_ACTIONS.has(action) && target.deliveryId ? { deliveryId: target.deliveryId } : {}),
      ...(OUTPUT_TARGET_ACTIONS.has(action) && target.outputKey ? { outputKey: target.outputKey } : {}),
      ...(action === 'retry-maintenance' && target.outboxId ? { outboxId: target.outboxId } : {}),
      ...(asksMessageId && message !== '' ? { messageId: message } : {}),
      ...(needsDuplicateConfirm ? { confirmDuplicateRisk: duplicateConfirmed } : {}),
      ...(needsPausedConfirm ? { confirmPausedMutation: pausedConfirmed } : {}),
    },
  };

  return (
    <ControlDialog
      request={request}
      title={copy.title}
      description={copy.description}
      tone={needsDuplicateConfirm ? 'danger' : copy.tone}
      confirmLabel={label}
      submitBlocker={blocker}
      successMessage={result => `Đã thực hiện: ${label} — ${describeResult(result)}.`}
      onClose={onClose}
    >
      {({ locked, pending }) => (
        <>
          <TargetSummary target={target} />
          {asksMessageId ? (
            <Field
              id={messageInputId}
              label="Telegram message ID (nếu có)"
              error={messageError}
              hint="Số ở cuối link bài trên Telegram, ví dụ t.me/ten_kenh/1234 → 1234. Để trống nếu không tìm thấy."
            >
              <TextInput
                id={messageInputId}
                value={messageId}
                maxLength={200}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                invalid={Boolean(messageError)}
                aria-describedby={describedBy(messageInputId, { error: messageError, hint: true })}
                readOnly={locked}
                disabled={pending}
                onChange={event => setMessageId(event.target.value)}
              />
            </Field>
          ) : null}
          {needsDuplicateConfirm ? (
            <Notice tone="danger" title="Rủi ro đăng trùng">
              <p>
                Lần gửi trước của mục này không rõ kết quả: bài có thể đã lên Telegram. Hãy kiểm tra kênh trước; nếu bài đã có,
                dùng “Xác nhận đã gửi” thay vì gửi lại.
              </p>
              <Checkbox
                id={duplicateId}
                label="Tôi đã kiểm tra và chấp nhận rủi ro đăng trùng"
                checked={duplicateConfirmed}
                disabled={locked || pending}
                onChange={setDuplicateConfirmed}
              />
            </Notice>
          ) : null}
          {needsPausedConfirm ? (
            <Notice tone="warning" title="Kênh đang tạm dừng (paused)">
              <p>
                Thao tác này vẫn {copy.pausedEffect ?? 'chạy'} ngay cả khi kênh đang tạm dừng; kênh vẫn giữ trạng thái pause sau đó.
                Chỉ xác nhận khi bạn chủ động muốn xử lý mục này lúc kênh dừng.
              </p>
              <Checkbox
                id={pausedId}
                label="Thực hiện dù kênh đang tạm dừng"
                checked={pausedConfirmed}
                disabled={locked || pending}
                onChange={setPausedConfirmed}
              />
            </Notice>
          ) : null}
        </>
      )}
    </ControlDialog>
  );
}

function TargetSummary({ target }: { target: RecoveryTarget }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium text-slate-900">{targetTitle(target)}</p>
      <p className="mt-0.5 text-slate-600">
        {RECOVERY_TARGET_KIND_LABELS[target.kind]} · {recoveryStateLabel(target)} · phiên bản {target.expectedVersion}
      </p>
      <TargetIds target={target} className="mt-1" />
    </div>
  );
}

/** Title of a recovery target (maintenance items have none). */
export function targetTitle(target: RecoveryTarget): string {
  if (target.title) return target.title;
  return target.kind === 'outbox' ? 'Ghi cache bảo trì' : 'Không có tiêu đề';
}

/** Identifiers of a recovery target, as compact monospace text. */
export function TargetIds({ target, className }: { target: RecoveryTarget; className?: string }) {
  const entries: [string, string][] = [];
  if (target.deliveryId) entries.push(['Delivery', target.deliveryId]);
  if (target.outputKey) entries.push(['Output', target.outputKey]);
  if (target.outboxId) entries.push(['Outbox', target.outboxId]);
  if (target.publishingDay) entries.push(['Ngày đăng', formatDay(target.publishingDay)]);
  if (target.articleCount !== undefined && target.articleCount > 1) entries.push(['Số bài', formatNumber(target.articleCount)]);
  return (
    <dl className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500', className)}>
      {entries.map(([name, value]) => (
        <div key={name} className="flex min-w-0 gap-1">
          <dt>{name}:</dt>
          <dd className="max-w-56 truncate font-mono text-slate-700" title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function describeResult(result: ControlResult): string {
  if (result.deliveryState) return `trạng thái mới: ${labelOf(DELIVERY_STATE_LABELS, result.deliveryState)}`;
  if (result.outboxState) return `trạng thái bảo trì: ${result.outboxState}`;
  return `kết quả: ${result.status}`;
}
