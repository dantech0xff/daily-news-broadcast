import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { ChannelRecord, ChannelStatus } from '../../api/types';
import { Badge } from '../../components/badge';
import { Card, CardBody, CardHeader } from '../../components/card';
import { ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { CutoverNotice } from '../../features/channel-actions/cutover-notice';
import { PauseResumeButton } from '../../features/channel-actions/pause-resume-button';
import { RunNowButton } from '../../features/channel-actions/run-now-button';
import { describeCron } from '../../lib/cron';
import { formatDateTime, formatDay, formatDuration, formatNumber, formatRelative } from '../../lib/format';
import { CONTROL_ACTION_LABELS, RUN_REASON_LABELS, RUN_STATUS_LABELS, TRIGGER_LABELS, labelOf } from '../../lib/labels';
import { MUTATION_STATE_LABELS, channelStateView, isCutoverPending } from '../../lib/operations';
import { runStatusTone } from '../../lib/status-tones';

/** Delivery state, versions, schedule, cutover, today's queue, and the last run of one channel, with Run now and Pause/Resume. */
export function StatusPanel({ record, query, onShowRun }: {
  record: ChannelRecord;
  query: UseQueryResult<ChannelStatus>;
  onShowRun: (runId: string) => void;
}) {
  const status = query.data;
  return (
    <Card>
      <CardHeader
        title="Trạng thái kênh"
        description={<>{record.name} · <span className="font-mono text-xs">{record.id}</span></>}
        actions={(
          <>
            <RunNowButton channelId={record.id} enabled={status?.enabled ?? record.enabled} status={status} size="md" />
            <PauseResumeButton channelId={record.id} channelName={record.name} status={status} size="md" />
          </>
        )}
      />
      <CardBody className="space-y-4">
        {isCutoverPending(status ?? record) ? <CutoverNotice channelId={record.id} /> : null}
        {status && query.error ? <StaleDataNotice errors={[query.error]} onRetry={() => void query.refetch()} /> : null}
        {status ? (
          <StatusDetails status={status} onShowRun={onShowRun} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <LoadingState />
        )}
      </CardBody>
    </Card>
  );
}

function StatusDetails({ status, onShowRun }: { status: ChannelStatus; onShowRun: (runId: string) => void }) {
  const state = channelStateView({ enabled: status.enabled }, status);
  const { queue, lastRun } = status;
  const cron = describeCron(status.cron);
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
      <Item label="Trạng thái">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone}>{state.label}</Badge>
          {status.paused !== null ? <code className="font-mono text-xs text-slate-500">{status.paused ? 'paused' : 'active'}</code> : null}
        </span>
      </Item>
      <Item label="Mutation state">
        {status.mutationState ? (
          <>
            {labelOf(MUTATION_STATE_LABELS, status.mutationState)} <code className="font-mono text-xs text-slate-500">{status.mutationState}</code>
          </>
        ) : 'Chưa có trạng thái giao hàng'}
      </Item>
      <Item label="Phiên bản">
        Trạng thái giao hàng: {status.version ?? '—'} · Cấu hình: {status.configVersion}
      </Item>
      <Item label="Thao tác được phép">
        {status.allowedActions.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {status.allowedActions.map(action => <Badge key={action} tone="indigo">{CONTROL_ACTION_LABELS[action] ?? action}</Badge>)}
          </span>
        ) : 'Không có'}
      </Item>
      <Item label="Lịch">
        <code className="font-mono text-xs">{status.cron}</code> ({status.timezone})
        <span className="block text-xs text-slate-500">
          {cron ?? 'Cron không đọc được'} · {status.scheduled ? 'đang có lịch chạy' : 'không có lịch chạy'}
        </span>
      </Item>
      <Item label="Mốc cutover (notBefore)">
        {status.notBefore ? (
          <>
            {formatDateTime(status.notBefore)}
            <span className="block font-mono text-xs text-slate-500">{status.notBefore}</span>
          </>
        ) : (
          <span className={status.cutoverRequired ? 'font-medium text-rose-700' : undefined}>
            {status.cutoverRequired ? 'Chưa đặt — bắt buộc với kênh này' : 'Chưa đặt'}
          </span>
        )}
      </Item>
      <Item label={`Queue hôm nay (${formatDay(queue.date)})`}>
        {formatNumber(queue.delivered)}/{formatNumber(status.dailyLimit)} đã đăng
        <span className="block text-xs text-slate-500">
          {formatNumber(queue.remaining)} còn trong queue · {formatNumber(queue.blocked)} bị chặn · tổng {formatNumber(queue.total)}
        </span>
      </Item>
      <Item label="Mục chưa xử lý">
        <span className={status.unresolvedCount > 0 ? 'font-medium text-rose-700' : undefined}>{formatNumber(status.unresolvedCount)}</span>
        {status.running ? <span className="block text-xs text-sky-700">Kênh đang chạy</span> : null}
        {status.queued ? <span className="block text-xs text-sky-700">Kênh đang chờ chạy</span> : null}
      </Item>
      <Item label="Lần chạy gần nhất">
        {lastRun ? (
          <div className="space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span title={formatDateTime(lastRun.startedAt)}>{formatRelative(lastRun.startedAt)}</span>
              <Badge tone={runStatusTone(lastRun.status)}>{labelOf(RUN_STATUS_LABELS, lastRun.status)}</Badge>
              <span className="text-xs text-slate-500">{labelOf(TRIGGER_LABELS, lastRun.triggerType)} · {formatDuration(lastRun.durationMs)}</span>
            </span>
            {lastRun.reason ? <span className="block text-xs text-slate-500">{labelOf(RUN_REASON_LABELS, lastRun.reason)}</span> : null}
            {lastRun.error ? <span className="block text-xs break-words text-rose-700">{lastRun.error}</span> : null}
            <button type="button" onClick={() => onShowRun(lastRun.id)} className="text-xs font-medium text-indigo-700 hover:underline">
              Xem chi tiết lần chạy gần nhất
            </button>
          </div>
        ) : 'Chưa chạy'}
      </Item>
    </dl>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-800">{children}</dd>
    </div>
  );
}
