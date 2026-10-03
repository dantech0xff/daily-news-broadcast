/**
 * "AI & secret" (`/secrets`): write-only credentials. The API returns
 * metadata only; a value is typed into an uncontrolled password input (React
 * never mirrors it into a `value` attribute), read from the input inside the
 * request function (never passed as mutation variables, which TanStack keeps
 * in its mutation cache), and cleared after a successful save. Nothing is
 * prefilled, displayed, or stored in the browser.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';

import { useApi } from '../../api/api-context';
import { ApiError } from '../../api/client';
import { queryKeys } from '../../api/query-keys';
import { useCredentials, useMeta } from '../../api/queries';
import type { Credential, CredentialKind } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Card, CardBody } from '../../components/card';
import { Dialog } from '../../components/dialog';
import { describedBy, Field, Select, TextInput } from '../../components/form-controls';
import { IconKey, IconPlus, IconTrash } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, Notice, StaleDataNotice } from '../../components/states';
import { useToast } from '../../components/toast';
import { formatDateTime } from '../../lib/format';
import { CREDENTIAL_KIND_HINTS, CREDENTIAL_KIND_LABELS, labelOf } from '../../lib/labels';

const DEFAULT_VALUE_MAX_LENGTH = 4096;
const DEFAULT_LABEL_MAX_LENGTH = 100;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export function SecretsPage() {
  const credentials = useCredentials();
  const [createOpen, setCreateOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<Credential | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);

  return (
    <>
      <PageHeader
        title="AI & secret"
        description="Bot token, chat ID, khoá AI và token AI Gateway được mã hoá khi lưu và chỉ ghi: không bao giờ hiển thị lại. Chọn credential cho từng kênh trong trang Kênh."
        actions={<OperatorButton variant="primary" icon={<IconPlus className="size-4" />} onClick={() => setCreateOpen(true)}>Thêm credential</OperatorButton>}
      />
      <StaleDataNotice className="mb-4" errors={[credentials.data ? credentials.error : null]} onRetry={() => void credentials.refetch()} />
      <Card>
        {credentials.data === undefined ? (
          credentials.isError
            ? <CardBody><ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} /></CardBody>
            : <LoadingState />
        ) : credentials.data.length === 0 ? (
          <EmptyState title="Chưa có credential nào" description="Thêm bot token, chat ID và khoá AI để kênh có thể chạy." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3">Tên</th>
                  <th scope="col" className="px-5 py-3">Loại</th>
                  <th scope="col" className="px-5 py-3">Đã đặt</th>
                  <th scope="col" className="px-5 py-3">Cập nhật lúc</th>
                  <th scope="col" className="px-5 py-3">Người cập nhật</th>
                  <th scope="col" className="px-5 py-3">Dùng bởi</th>
                  <th scope="col" className="px-5 py-3"><span className="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {credentials.data.map(credential => (
                  <tr key={credential.id} className="align-top">
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-2 font-medium text-slate-900">
                        <IconKey className="size-4 text-slate-400" />
                        {credential.label}
                      </span>
                    </td>
                    <td className="px-5 py-3">{labelOf(CREDENTIAL_KIND_LABELS, credential.kind)}</td>
                    <td className="px-5 py-3">
                      {credential.isSet ? <Badge tone="green">Đã đặt</Badge> : <Badge tone="amber">Chưa đặt</Badge>}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{formatDateTime(credential.updatedAt)}</td>
                    <td className="px-5 py-3 text-slate-600">{credential.updatedBy ?? '—'}</td>
                    <td className="px-5 py-3">
                      {credential.usedBy.length === 0 ? (
                        <span className="text-slate-400">Chưa dùng</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1">
                          {credential.usedBy.map(channelId => (
                            <li key={channelId}>
                              <Link
                                to={`/channels/${encodeURIComponent(channelId)}/edit`}
                                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                              >
                                {channelId}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-2">
                        <OperatorButton size="sm" onClick={() => setReplaceTarget(credential)}>Thay giá trị</OperatorButton>
                        <OperatorButton
                          size="sm"
                          variant="ghost"
                          aria-label={`Xoá credential ${credential.label}`}
                          icon={<IconTrash className="size-4 text-rose-600" />}
                          disabledReason={credential.usedBy.length > 0 ? `Đang được dùng bởi: ${credential.usedBy.join(', ')}` : null}
                          onClick={() => setDeleteTarget(credential)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen ? <CreateSecretDialog onClose={() => setCreateOpen(false)} /> : null}
      {replaceTarget ? <ReplaceSecretDialog credential={replaceTarget} onClose={() => setReplaceTarget(null)} /> : null}
      {deleteTarget ? <DeleteSecretDialog credential={deleteTarget} onClose={() => setDeleteTarget(null)} /> : null}
    </>
  );
}

/** Uncontrolled password input for a secret value: never prefilled, never mirrored into the DOM. */
function SecretValueInput({ id, inputRef, error, hint, maxLength }: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  error: string | null;
  hint: string;
  maxLength: number;
}) {
  return (
    <Field id={id} label="Giá trị" required error={error} hint={hint}>
      <TextInput
        id={id}
        ref={inputRef}
        type="password"
        autoComplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        maxLength={maxLength}
        invalid={Boolean(error)}
        aria-describedby={describedBy(id, { error, hint })}
        className="font-mono"
      />
    </Field>
  );
}

function readSecret(inputRef: RefObject<HTMLInputElement | null>, maxLength: number): { value: string; error: string | null } {
  const value = (inputRef.current?.value ?? '').trim();
  if (value === '') return { value, error: 'Bắt buộc.' };
  if (value.length > maxLength) return { value, error: `Tối đa ${maxLength} ký tự.` };
  if (!VISIBLE_ASCII.test(value)) return { value, error: 'Chỉ dùng ký tự ASCII hiển thị, không có khoảng trắng.' };
  return { value, error: null };
}

function clearSecret(inputRef: RefObject<HTMLInputElement | null>) {
  if (inputRef.current) inputRef.current.value = '';
}

function issueMessage(error: unknown, field: string): string | null {
  return error instanceof ApiError ? error.issues.find(issue => issue.field === field)?.message ?? null : null;
}

function CreateSecretDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const labelId = useId();
  const kindId = useId();
  const valueId = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const kinds = meta.data?.credentials.kinds ?? (Object.keys(CREDENTIAL_KIND_LABELS) as CredentialKind[]);
  const valueMaxLength = meta.data?.credentials.valueMaxLength ?? DEFAULT_VALUE_MAX_LENGTH;
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<CredentialKind>(kinds[0] ?? 'telegram_bot_token');
  const [errors, setErrors] = useState<{ label: string | null; value: string | null }>({ label: null, value: null });

  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => api.createCredential({ label: label.trim(), kind, value: readSecret(valueRef, valueMaxLength).value }),
    onSuccess: created => {
      clearSecret(valueRef);
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
      toast.success(`Đã lưu credential ${created.label}`, 'Giá trị đã được mã hoá và sẽ không hiển thị lại.');
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    const labelError = trimmedLabel === '' ? 'Bắt buộc.' : null;
    const secret = readSecret(valueRef, valueMaxLength);
    setErrors({ label: labelError, value: secret.error });
    if (labelError || secret.error) return;
    mutation.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!mutation.isPending}
      title="Thêm credential"
      description="Giá trị chỉ được gửi lên máy chủ để mã hoá; sau đó không thể xem lại."
      footer={(
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>Huỷ</Button>
          <Button type="submit" form={`${valueId}-form`} variant="primary" loading={mutation.isPending}>Lưu credential</Button>
        </>
      )}
    >
      <form id={`${valueId}-form`} noValidate className="space-y-4" onSubmit={submit}>
        <Field id={labelId} label="Tên" required error={errors.label ?? issueMessage(mutation.error, 'label')} hint="Tên gợi nhớ, ví dụ Bot kênh chính.">
          <TextInput
            id={labelId}
            value={label}
            maxLength={meta.data?.credentials.labelMaxLength ?? DEFAULT_LABEL_MAX_LENGTH}
            invalid={Boolean(errors.label)}
            autoComplete="off"
            onChange={event => setLabel(event.target.value)}
          />
        </Field>
        <Field id={kindId} label="Loại" required error={issueMessage(mutation.error, 'kind')}>
          <Select id={kindId} value={kind} onChange={event => setKind(event.target.value as CredentialKind)}>
            {kinds.map(entry => <option key={entry} value={entry}>{labelOf(CREDENTIAL_KIND_LABELS, entry)}</option>)}
          </Select>
        </Field>
        <SecretValueInput
          id={valueId}
          inputRef={valueRef}
          error={errors.value ?? issueMessage(mutation.error, 'value')}
          hint={CREDENTIAL_KIND_HINTS[kind]}
          maxLength={valueMaxLength}
        />
        {mutation.isError ? <ErrorState error={mutation.error} /> : null}
      </form>
    </Dialog>
  );
}

function ReplaceSecretDialog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const valueId = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const valueMaxLength = meta.data?.credentials.valueMaxLength ?? DEFAULT_VALUE_MAX_LENGTH;
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => api.replaceCredential(credential.id, readSecret(valueRef, valueMaxLength).value),
    onSuccess: updated => {
      clearSecret(valueRef);
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
      toast.success(
        `Đã thay giá trị của ${updated.label}`,
        updated.usedBy.length > 0 ? 'Các kênh dùng credential này nhận giá trị mới từ lượt chạy kế tiếp.' : undefined,
      );
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const secret = readSecret(valueRef, valueMaxLength);
    setError(secret.error);
    if (!secret.error) mutation.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!mutation.isPending}
      title={`Thay giá trị: ${credential.label}`}
      description={`${labelOf(CREDENTIAL_KIND_LABELS, credential.kind)} · giá trị hiện tại không bao giờ hiển thị; nhập giá trị mới để thay thế.`}
      footer={(
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>Huỷ</Button>
          <Button type="submit" form={`${valueId}-form`} variant="primary" loading={mutation.isPending}>Thay giá trị</Button>
        </>
      )}
    >
      <form id={`${valueId}-form`} noValidate className="space-y-4" onSubmit={submit}>
        {credential.usedBy.length > 0 ? (
          <Notice tone="warning">
            Đang được dùng bởi: {credential.usedBy.join(', ')}. Giá trị mới áp dụng cho các kênh này từ lượt chạy kế tiếp.
          </Notice>
        ) : null}
        <SecretValueInput
          id={valueId}
          inputRef={valueRef}
          error={error ?? issueMessage(mutation.error, 'value')}
          hint={CREDENTIAL_KIND_HINTS[credential.kind]}
          maxLength={valueMaxLength}
        />
        {mutation.isError ? <ErrorState error={mutation.error} /> : null}
      </form>
    </Dialog>
  );
}

function DeleteSecretDialog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => api.deleteCredential(credential.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
      toast.success(`Đã xoá credential ${credential.label}`);
      onClose();
    },
    // A 409 credential_in_use means the list is stale: refresh its usage.
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!mutation.isPending}
      title={`Xoá credential ${credential.label}?`}
      description="Giá trị đã mã hoá bị xoá vĩnh viễn. Không xoá được khi còn kênh đang dùng."
      footer={(
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>Huỷ</Button>
          <Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>Xoá credential</Button>
        </>
      )}
    >
      {mutation.isError ? (
        <ErrorState error={mutation.error} />
      ) : (
        <p className="text-sm text-slate-600">{labelOf(CREDENTIAL_KIND_LABELS, credential.kind)} · cập nhật {formatDateTime(credential.updatedAt)}</p>
      )}
    </Dialog>
  );
}
