/**
 * Queue & vận hành (`/operations?channel=<id>&day=YYYY-MM-DD`): one channel's
 * status (Run now, Pause/Resume), its unresolved items with the actions the
 * server allows, the queue of one publishing day, the run history with run
 * details, and a read-only preview. The channel and the day live in the URL
 * so the view can be linked and reloaded; without `channel` the first
 * channel is shown. Viewers see everything read-only.
 */

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useChannelStatus, useChannels } from '../../api/queries';
import type { ChannelRecord } from '../../api/types';
import { ButtonLink } from '../../components/button';
import { Card } from '../../components/card';
import { ChannelSelect } from '../../components/channel-select';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, Notice, StaleDataNotice } from '../../components/states';
import { useSession } from '../../app/session';
import { isDay } from '../../lib/days';
import { PreviewPanel } from './preview-panel';
import { QueueCard } from './queue-card';
import { RunDetailDialog } from './run-detail-dialog';
import { RunsCard } from './runs-card';
import { StatusPanel } from './status-panel';
import { UnresolvedCard } from './unresolved-card';

export function OperationsPage() {
  const { canOperate } = useSession();
  const [params, setParams] = useSearchParams();
  const channels = useChannels();
  const list = channels.data ?? [];
  const channelId = params.get('channel') || list[0]?.id || '';
  const dayParam = params.get('day');
  const day = isDay(dayParam) ? dayParam : null;
  const record = list.find(channel => channel.id === channelId);

  // Another channel starts again from today.
  const selectChannel = (next: string) => setParams(next ? { channel: next } : {});
  const selectDay = (next: string | null) => {
    setParams(current => {
      const updated = new URLSearchParams(current);
      if (channelId) updated.set('channel', channelId);
      if (next) updated.set('day', next);
      else updated.delete('day');
      return updated;
    });
  };

  let body: ReactNode;
  if (channels.data === undefined) {
    body = channels.isError
      ? <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      : <LoadingState />;
  } else if (list.length === 0) {
    body = (
      <Card>
        <EmptyState
          title="Chưa có kênh nào"
          description="Tạo kênh để bắt đầu quét và đăng bài."
          action={canOperate ? <ButtonLink to="/channels/new" variant="primary">Tạo kênh</ButtonLink> : null}
        />
      </Card>
    );
  } else if (!record) {
    body = (
      <Notice tone="warning" title="Không tìm thấy kênh">
        Kênh “{channelId}” không tồn tại hoặc đã bị xoá. Hãy chọn kênh khác.
      </Notice>
    );
  } else {
    body = <ChannelOperations key={record.id} record={record} day={day} onDayChange={selectDay} />;
  }

  return (
    <>
      <PageHeader
        title="Queue & vận hành"
        description="Trạng thái, mục kẹt, queue theo ngày, lịch sử run và preview của từng kênh."
        actions={list.length > 0 ? <ChannelSelect id="operations-channel" value={channelId} onChange={selectChannel} channels={list} /> : null}
      />
      {channels.data && channels.error ? (
        <StaleDataNotice className="mb-4" errors={[channels.error]} onRetry={() => void channels.refetch()} />
      ) : null}
      {dayParam !== null && day === null ? (
        <Notice tone="warning" className="mb-4">Ngày “{dayParam}” trong đường dẫn không hợp lệ; queue đang hiển thị hôm nay.</Notice>
      ) : null}
      {body}
    </>
  );
}

function ChannelOperations({ record, day, onDayChange }: {
  record: ChannelRecord;
  day: string | null;
  onDayChange: (day: string | null) => void;
}) {
  const status = useChannelStatus(record.id);
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <StatusPanel record={record} query={status} onShowRun={setRunId} />
      <UnresolvedCard channelId={record.id} status={status.data} />
      <QueueCard channelId={record.id} timezone={record.timezone} day={day} onDayChange={onDayChange} />
      <RunsCard channelId={record.id} onShowRun={setRunId} />
      <PreviewPanel channelId={record.id} />
      {runId ? <RunDetailDialog runId={runId} onClose={() => setRunId(null)} /> : null}
    </div>
  );
}
