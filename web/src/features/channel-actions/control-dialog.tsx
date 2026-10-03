/**
 * Confirmation dialog for one operator control (`POST /api/channels/:id/control/:action`).
 *
 * - A reason is required (audited with the operator identity), bounded by
 *   `meta.controls.reasonMaxLength`.
 * - The idempotency key is generated once per dialog: retrying after a lost
 *   response replays the first result instead of applying the action twice.
 *   The server fingerprints the reason with the key, so after a failure with
 *   an unknown outcome (network error, 5xx) the reason is locked: an edited
 *   reason would turn a harmless replay into a conflict.
 * - `expectedVersion` comes from the caller (channel status `version` for
 *   pause/resume, the target's `expectedVersion` for recovery actions); a
 *   stale version (409 `version_conflict`) asks the operator to reload.
 * - The server fingerprints the whole request (target, `messageId`, risk
 *   confirmations) with the key as well, so callers that collect such inputs
 *   pass `children` as a function and disable them while `locked`.
 * Mount it only while it should be open (`{request && <ControlDialog …/>}`)
 * so every opening starts with a fresh reason and key.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useApi } from '../../api/api-context';
import { ApiError } from '../../api/client';
import { queryKeys } from '../../api/query-keys';
import { useMeta } from '../../api/queries';
import type { ControlAction, ControlParams, ControlResult } from '../../api/types';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { describedBy, Field, Textarea } from '../../components/form-controls';
import { ErrorState } from '../../components/states';
import { useToast } from '../../components/toast';
import { isCutoverRequiredError } from '../../lib/errors';
import { newIdempotencyKey } from '../../lib/ids';
import { CONTROL_ACTION_LABELS } from '../../lib/labels';
import { cutoverSectionPath } from '../../lib/operations';

const DEFAULT_REASON_MAX_LENGTH = 500;

export interface ControlRequest {
  channelId: string;
  action: ControlAction;
  expectedVersion: number;
  /** Target and confirmation parameters of recovery actions. */
  target?: Omit<ControlParams, 'idempotencyKey' | 'expectedVersion' | 'reason'>;
}

export interface ControlDialogState {
  /**
   * A submission failed with an unknown outcome: every input that feeds the
   * request must stay as it is, so a retry replays the first submission.
   */
  locked: boolean;
  /** A submission is in flight. */
  pending: boolean;
}

export interface ControlDialogProps {
  request: ControlRequest;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  /** Extra warnings and inputs shown above the reason. */
  children?: ReactNode | ((state: ControlDialogState) => ReactNode);
  /** Why the action cannot be confirmed yet (e.g. a required confirmation is unchecked); disables the confirm button. */
  submitBlocker?: string | null;
  successMessage?: (result: ControlResult) => string;
  onClose: () => void;
  onDone?: (result: ControlResult) => void;
}

export function ControlDialog({ request, title, description, confirmLabel, tone = 'primary', children, submitBlocker = null, successMessage, onClose, onDone }: ControlDialogProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const reasonId = useId();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [reasonLocked, setReasonLocked] = useState(false);
  const maxLength = meta.data?.controls.reasonMaxLength ?? DEFAULT_REASON_MAX_LENGTH;

  const mutation = useMutation({
    mutationFn: () => api.control(request.channelId, request.action, {
      ...request.target,
      idempotencyKey,
      expectedVersion: request.expectedVersion,
      reason: reason.trim(),
    }),
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ops(request.channelId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.content });
      const message = successMessage?.(result) ?? `Đã thực hiện: ${CONTROL_ACTION_LABELS[request.action]}.`;
      toast.success(message, result.replayed ? 'Thao tác này đã được áp dụng trước đó (idempotency key trùng).' : undefined);
      onDone?.(result);
      onClose();
    },
    onError: error => {
      if (outcomeUnknown(error)) setReasonLocked(true);
    },
  });

  const trimmed = reason.trim();
  const reasonError = trimmed.length > maxLength
    ? `Tối đa ${maxLength} ký tự.`
    : touched && trimmed === '' ? 'Cần nhập lý do.' : null;
  const canSubmit = trimmed !== '' && trimmed.length <= maxLength && !mutation.isPending && !submitBlocker;
  const conflict = mutation.error instanceof ApiError && mutation.error.isVersionConflict;
  const extra = typeof children === 'function' ? children({ locked: reasonLocked, pending: mutation.isPending }) : children;

  const submit = () => {
    setTouched(true);
    if (canSubmit) mutation.mutate();
  };

  const reloadAndClose = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.ops(request.channelId) });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!mutation.isPending}
      title={title}
      description={description}
      footer={(
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>Huỷ</Button>
          {conflict ? (
            <Button variant="primary" onClick={reloadAndClose}>Tải lại trạng thái</Button>
          ) : (
            <Button variant={tone} loading={mutation.isPending} disabled={!canSubmit} title={submitBlocker ?? undefined} onClick={submit}>
              {confirmLabel ?? CONTROL_ACTION_LABELS[request.action]}
            </Button>
          )}
        </>
      )}
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        {extra}
        <Field
          id={reasonId}
          label="Lý do"
          required
          error={reasonError}
          hint={reasonLocked
            ? 'Lý do được giữ nguyên để lần thử lại dùng đúng idempotency key của lần gửi trước.'
            : 'Lý do được ghi vào audit log cùng danh tính của bạn.'}
        >
          <Textarea
            id={reasonId}
            value={reason}
            rows={3}
            maxLength={maxLength}
            required
            invalid={Boolean(reasonError)}
            aria-describedby={describedBy(reasonId, { error: reasonError, hint: true })}
            onChange={event => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            readOnly={reasonLocked}
            disabled={mutation.isPending}
          />
        </Field>
        {submitBlocker ? <p className="text-sm text-amber-800">{submitBlocker}</p> : null}
        {mutation.isError ? (
          <ErrorState error={mutation.error} />
        ) : null}
        {isCutoverRequiredError(mutation.error) ? (
          <p className="text-sm">
            <Link to={cutoverSectionPath(request.channelId)} onClick={onClose} className="font-medium text-indigo-700 hover:underline">
              Mở mục Cutover của kênh
            </Link>
          </p>
        ) : null}
        {conflict ? (
          <p className="text-sm text-slate-600">Trạng thái đã thay đổi ở nơi khác. Tải lại trạng thái rồi mở lại thao tác này.</p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** The request may or may not have been applied: retry it unchanged. */
function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.code === 'network_error' || error.status >= 500;
}
