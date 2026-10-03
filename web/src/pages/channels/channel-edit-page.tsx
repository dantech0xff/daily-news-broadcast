/**
 * Create (`/channels/new`) and edit (`/channels/:channelId/edit`) pages.
 *
 * Optimistic concurrency: an edit is saved with the config `version` the form
 * was loaded from. When live events bring a newer version, a clean form
 * reloads silently; a form with unsaved changes keeps them and warns. A 409
 * `version_conflict` offers to reload the latest config.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useApi } from '../../api/api-context';
import { ApiError } from '../../api/client';
import { queryKeys } from '../../api/query-keys';
import { useChannel, useChannelStatus, useCredentials, useMeta } from '../../api/queries';
import type { ChannelRecord, ChannelStatus, Credential, Meta } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { Dialog } from '../../components/dialog';
import { Field, TextInput } from '../../components/form-controls';
import { IconTrash } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState, Notice, StaleDataNotice } from '../../components/states';
import { useToast } from '../../components/toast';
import { useSession } from '../../app/session';
import { PauseResumeButton } from '../../features/channel-actions/pause-resume-button';
import { PreviewButton } from '../../features/channel-actions/preview-dialog';
import { formatDateTime } from '../../lib/format';
import { channelStateView } from '../../lib/operations';
import { ChannelForm, DISCARD_CHANGES_STATE } from './channel-form';
import { createEmptyForm, recordToForm, toCreateInput, toUpdateInput } from './channel-form-model';

export function ChannelCreatePage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { canOperate } = useSession();
  const meta = useMeta();
  const credentials = useCredentials();
  const [initialValues] = useState(() => (meta.data ? createEmptyForm(meta.data) : null));

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof api.createChannel>[0]) => api.createChannel(input),
    onSuccess: record => {
      queryClient.setQueryData(queryKeys.channel(record.id), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
      toast.success(`Đã tạo kênh ${record.name}`, 'Kênh đang tạm dừng: nhập đủ credential rồi Resume để bắt đầu đăng.');
      void navigate(`/channels/${encodeURIComponent(record.id)}/edit`);
    },
    onError: error => {
      if (!(error instanceof ApiError) || error.issues.length === 0) toast.error(error);
    },
  });

  if (!canOperate) {
    return (
      <>
        <PageHeader title="Tạo kênh" />
        <Notice tone="warning" title="Cần quyền operator">Tài khoản viewer chỉ xem được cấu hình kênh.</Notice>
      </>
    );
  }
  // Data first: a failed background refresh keeps the form (and unsaved input) mounted.
  if (meta.data === undefined) {
    return meta.isError ? <ErrorState error={meta.error} onRetry={() => void meta.refetch()} /> : <LoadingState />;
  }
  if (credentials.data === undefined) {
    return credentials.isError ? <ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} /> : <LoadingState />;
  }

  return (
    <>
      <PageHeader title="Tạo kênh" description={<Link to="/channels" className="text-indigo-700 hover:underline">← Danh sách kênh</Link>} />
      <StaleDataNotice className="mb-6" errors={[credentials.error]} onRetry={() => void credentials.refetch()} />
      <Notice tone="info" title="Kênh mới luôn được tạo ở trạng thái tạm dừng (paused)" className="mb-6">
        Sau khi tạo, hãy nhập đủ credential (Telegram bot token, chat ID, khoá AI) rồi bấm Resume để kênh bắt đầu chạy theo lịch.
        Có thể dùng Preview để xem trước nội dung mà không gửi.
      </Notice>
      <ChannelForm
        meta={meta.data}
        credentials={credentials.data}
        initialValues={initialValues ?? createEmptyForm(meta.data)}
        isNew
        readOnly={false}
        submitLabel="Tạo kênh"
        cancelTo="/channels"
        onSubmit={values => mutation.mutateAsync(toCreateInput(values, meta.data))}
      />
    </>
  );
}

export function ChannelEditPage() {
  const { channelId = '' } = useParams();
  const channel = useChannel(channelId);
  const meta = useMeta();
  const credentials = useCredentials();
  const status = useChannelStatus(channelId);

  // Data first: a failed background refresh keeps the editor (and unsaved input)
  // mounted; only a deleted channel (404) or a failed first load replaces it.
  const deleted = channel.error instanceof ApiError && channel.error.status === 404;
  if (deleted || (channel.data === undefined && channel.isError)) {
    return (
      <>
        <PageHeader title={deleted ? 'Không tìm thấy kênh' : 'Kênh'} description={<Link to="/channels" className="text-indigo-700 hover:underline">← Danh sách kênh</Link>} />
        <ErrorState error={channel.error} onRetry={deleted ? undefined : () => void channel.refetch()} />
      </>
    );
  }
  if (meta.data === undefined && meta.isError) return <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />;
  if (credentials.data === undefined && credentials.isError) {
    return <ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} />;
  }
  if (channel.data === undefined || meta.data === undefined || credentials.data === undefined) return <LoadingState />;

  return (
    <>
      <StaleDataNotice
        className="mb-6"
        errors={[channel.error, credentials.error]}
        onRetry={() => {
          void channel.refetch();
          void credentials.refetch();
        }}
      />
      {/* Keyed by id: another channel's edit route must never reuse this editor's form state. */}
      <LoadedChannelEditor
        key={channel.data.id}
        record={channel.data}
        status={status.data}
        meta={meta.data}
        credentials={credentials.data}
        onReload={() => channel.refetch()}
      />
    </>
  );
}

function LoadedChannelEditor({ record, status, meta, credentials, onReload }: {
  record: ChannelRecord;
  status: ChannelStatus | undefined;
  meta: Meta;
  credentials: Credential[];
  onReload: () => Promise<unknown>;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canOperate } = useSession();
  // The record the form was initialized from; its version is what a save sends.
  const [base, setBase] = useState(record);
  const [dirty, setDirty] = useState(false);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  // Only move forward: a slow, stale read that lands after a save must not roll the form back.
  useEffect(() => {
    if (record.version > base.version && !dirty) {
      setBase(record);
      setConflictVersion(null);
    }
  }, [record, base.version, dirty]);

  const mutation = useMutation({
    mutationFn: (update: Parameters<typeof api.updateChannel>[1]) => api.updateChannel(record.id, update),
    onSuccess: saved => {
      queryClient.setQueryData(queryKeys.channel(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ops(saved.id) });
      setDirty(false);
      setBase(saved);
      setConflictVersion(null);
      toast.success('Đã lưu cấu hình kênh', 'Thay đổi có hiệu lực từ lượt chạy kế tiếp.');
    },
    onError: error => {
      if (error instanceof ApiError && error.isVersionConflict) {
        const current = error.details?.currentVersion;
        setConflictVersion(typeof current === 'number' ? current : record.version);
        return;
      }
      if (!(error instanceof ApiError) || error.issues.length === 0) toast.error(error);
    },
  });

  const reloadLatest = async () => {
    await onReload();
    const latest = queryClient.getQueryData<ChannelRecord>(queryKeys.channel(record.id)) ?? record;
    setDirty(false);
    setBase(latest);
    setConflictVersion(null);
  };

  const initialValues = useMemo(() => recordToForm(base, meta), [base, meta]);
  const state = channelStateView(record, status);
  const stale = record.version > base.version;

  return (
    <>
      <PageHeader
        title={record.name}
        description={(
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/channels" className="text-indigo-700 hover:underline">← Danh sách kênh</Link>
            <span className="font-mono text-xs">{record.id}</span>
            <Badge tone={state.tone}>{state.label}</Badge>
            <span className="text-xs">Phiên bản {base.version} · cập nhật {formatDateTime(base.updatedAt)}{base.updatedBy ? ` bởi ${base.updatedBy}` : ''}</span>
          </span>
        )}
        actions={(
          <>
            <PreviewButton channelId={record.id} channelName={record.name} size="md" />
            <PauseResumeButton channelId={record.id} channelName={record.name} status={status} size="md" />
          </>
        )}
      />

      {!canOperate ? (
        <Notice tone="info" className="mb-6">Bạn đang ở chế độ chỉ xem (viewer). Cần quyền operator để thay đổi cấu hình.</Notice>
      ) : null}
      {conflictVersion !== null ? (
        <Notice tone="danger" title="Không lưu được: cấu hình đã bị thay đổi ở nơi khác" className="mb-6">
          <p>
            Bạn đang sửa phiên bản {base.version}, trên máy chủ hiện là phiên bản {conflictVersion}. Tải lại để lấy cấu hình mới nhất
            (thay đổi chưa lưu trên trang này sẽ mất).
          </p>
          <Button size="sm" className="mt-2" onClick={() => void reloadLatest()}>Tải lại cấu hình</Button>
        </Notice>
      ) : stale ? (
        <Notice tone="warning" title="Kênh vừa được cập nhật ở nơi khác" className="mb-6">
          <p>Phiên bản mới nhất là {record.version}. Lưu bây giờ sẽ bị từ chối; tải lại để lấy cấu hình mới (thay đổi chưa lưu sẽ mất).</p>
          <Button size="sm" className="mt-2" onClick={() => void reloadLatest()}>Tải lại cấu hình</Button>
        </Notice>
      ) : null}

      <ChannelForm
        key={`${base.id}:${base.version}`}
        meta={meta}
        credentials={credentials}
        initialValues={initialValues}
        isNew={false}
        readOnly={!canOperate}
        submitLabel="Lưu thay đổi"
        cancelTo="/channels"
        onDirtyChange={onDirtyChange}
        onSubmit={values => mutation.mutateAsync(toUpdateInput(values, meta, base.version))}
      />

      <DeleteChannelCard record={record} status={status} />
    </>
  );
}

function DeleteChannelCard({ record, status }: { record: ChannelRecord; status: ChannelStatus | undefined }) {
  const [open, setOpen] = useState(false);
  const blocker = status?.paused === true ? null : 'Cần pause kênh trước khi xoá';
  return (
    <Card className="mt-6 border-rose-200">
      <CardHeader
        title="Xoá kênh"
        description="Xoá cấu hình kênh. Trạng thái giao hàng, lịch sử chạy và thư viện nội dung vẫn được giữ."
        actions={(
          <OperatorButton variant="danger" icon={<IconTrash className="size-4" />} disabledReason={blocker} onClick={() => setOpen(true)}>
            Xoá kênh
          </OperatorButton>
        )}
      />
      <CardBody>
        <p className="text-sm text-slate-500">Chỉ xoá được khi kênh đã pause, không đang chạy và không còn mục chưa xử lý.</p>
      </CardBody>
      {open ? <DeleteChannelDialog record={record} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

function DeleteChannelDialog({ record, onClose }: { record: ChannelRecord; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmation, setConfirmation] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.deleteChannel(record.id, record.version),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.channel(record.id) });
      queryClient.removeQueries({ queryKey: queryKeys.ops(record.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
      toast.success(`Đã xoá kênh ${record.name}`);
      void navigate('/channels', { state: DISCARD_CHANGES_STATE });
    },
  });
  const confirmed = confirmation.trim() === record.id;

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!mutation.isPending}
      title={`Xoá kênh ${record.name}?`}
      description="Cấu hình kênh bị xoá vĩnh viễn; trạng thái giao hàng, lịch sử chạy và thư viện nội dung vẫn được giữ."
      footer={(
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>Huỷ</Button>
          <Button variant="danger" loading={mutation.isPending} disabled={!confirmed} onClick={() => mutation.mutate()}>Xoá kênh</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Field id="delete-confirmation" label={<>Nhập <code className="font-mono">{record.id}</code> để xác nhận</>}>
          <TextInput id="delete-confirmation" value={confirmation} autoComplete="off" spellCheck={false} className="font-mono" onChange={event => setConfirmation(event.target.value)} />
        </Field>
        {mutation.isError ? <ErrorState error={mutation.error} /> : null}
      </div>
    </Dialog>
  );
}
