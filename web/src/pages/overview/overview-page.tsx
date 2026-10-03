import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useChannelStatuses, useChannels, useContentList, useUnresolvedLists } from '../../api/queries';
import type { ChannelRecord, ChannelStatus, ContentQuery, SourceHealthSummary, UnresolvedView } from '../../api/types';
import { Badge } from '../../components/badge';
import { ButtonLink } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { ExternalLink } from '../../components/external-link';
import { IconPlus } from '../../components/icons';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { CutoverNotice } from '../../features/channel-actions/cutover-notice';
import { PauseResumeButton } from '../../features/channel-actions/pause-resume-button';
import { PreviewButton } from '../../features/channel-actions/preview-dialog';
import { RunNowButton } from '../../features/channel-actions/run-now-button';
import { useSession } from '../../app/session';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { AI_PROVIDER_LABELS, RUN_REASON_LABELS, RUN_STATUS_LABELS, labelOf } from '../../lib/labels';
import { channelStateView, isCutoverPending, isStuckTarget } from '../../lib/operations';
import { runStatusTone } from '../../lib/status-tones';

const RECENT_POSTS_QUERY: ContentQuery = { status: ['delivered'], dateField: 'delivered', limit: 8 };

export function OverviewPage() {
  const { canOperate } = useSession();
  const channels = useChannels();
  const channelIds = channels.data?.map(channel => channel.id) ?? [];
  const statusQueries = useChannelStatuses(channelIds);
  const unresolvedQueries = useUnresolvedLists(channelIds);
  const statuses = statusQueries.map(query => query.data);
  const unresolved = unresolvedQueries.map(query => query.data);

  return (
    <>
      <PageHeader
        title="Tổng quan"
        description="Tình trạng các kênh hôm nay, các thao tác nhanh và những bài vừa đăng."
        actions={canOperate ? <ButtonLink to="/channels/new" variant="primary" icon={<IconPlus className="size-4" />}>Tạo kênh</ButtonLink> : null}
      />

      <MetricCards channels={channels.data ?? []} statuses={statuses} unresolved={unresolved} />

      <Card className="mt-6">
        <CardHeader title="Kênh" description="Trạng thái, lịch chạy và thao tác nhanh của từng kênh." />
        {channels.data && channels.error ? (
          <CardBody><StaleDataNotice errors={[channels.error]} onRetry={() => void channels.refetch()} /></CardBody>
        ) : null}
        {channels.data === undefined ? (
          channels.isError
            ? <CardBody><ErrorState error={channels.error} onRetry={() => void channels.refetch()} /></CardBody>
            : <LoadingState />
        ) : channels.data.length === 0 ? (
          <EmptyState
            title="Chưa có kênh nào"
            description="Tạo kênh Telegram đầu tiên để bắt đầu quét và đăng bài."
            action={canOperate ? <ButtonLink to="/channels/new" variant="primary">Tạo kênh</ButtonLink> : null}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {channels.data.map((channel, index) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                status={statuses[index]}
                statusError={statusQueries[index]?.error ?? null}
              />
            ))}
          </ul>
        )}
      </Card>

      <RecentPosts channels={channels.data ?? []} />
    </>
  );
}

function MetricCards({ channels, statuses, unresolved }: {
  channels: ChannelRecord[];
  statuses: (ChannelStatus | undefined)[];
  unresolved: (UnresolvedView | undefined)[];
}) {
  const loaded = statuses.filter((status): status is ChannelStatus => Boolean(status));
  const enabledLoaded = loaded.filter(status => status.enabled);
  const delivered = enabledLoaded.reduce((sum, status) => sum + status.queue.delivered, 0);
  const dailyLimit = enabledLoaded.reduce((sum, status) => sum + status.dailyLimit, 0);
  const remaining = loaded.reduce((sum, status) => sum + status.queue.remaining, 0);
  const stuckLists = unresolved.filter((view): view is UnresolvedView => Boolean(view));
  const stuck = stuckLists.reduce((sum, view) => sum + view.targets.filter(isStuckTarget).length, 0);
  const stuckTruncated = stuckLists.some(view => view.page.total > view.targets.length);
  const health = loaded
    .map(status => status.lastRun?.sourceHealth)
    .filter((summary): summary is SourceHealthSummary => summary !== null && summary !== undefined);
  const failedSources = health.reduce((sum, summary) => sum + (summary.failed ?? 0), 0);
  const totalSources = health.reduce((sum, summary) => sum + (summary.total ?? 0), 0);
  const ready = channels.length === 0 || loaded.length > 0;

  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Đã đăng hôm nay"
        value={ready ? `${formatNumber(delivered)} / ${formatNumber(dailyLimit)}` : '…'}
        hint="Số bài đã đăng / tổng daily limit của các kênh đang bật"
      />
      <MetricCard label="Queue còn lại" value={ready ? formatNumber(remaining) : '…'} hint="Mục trong ngày chưa đăng xong" />
      <MetricCard
        label="Mục kẹt"
        value={stuckLists.length > 0 || channels.length === 0 ? `${formatNumber(stuck)}${stuckTruncated ? '+' : ''}` : '…'}
        hint={<Link to="/operations" className="text-indigo-700 hover:underline">Cần operator xử lý — xem Queue & vận hành</Link>}
        tone={stuck > 0 ? 'danger' : 'default'}
      />
      <MetricCard
        label="Nguồn lỗi"
        value={health.length > 0 ? `${formatNumber(failedSources)} / ${formatNumber(totalSources)}` : '—'}
        hint="Theo lần chạy gần nhất của mỗi kênh"
        tone={failedSources > 0 ? 'warning' : 'default'}
      />
    </dl>
  );
}

function MetricCard({ label, value, hint, tone = 'default' }: { label: string; value: string; hint?: ReactNode; tone?: 'default' | 'warning' | 'danger' }) {
  const valueColor = tone === 'danger' ? 'text-rose-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <dt className="text-sm font-medium text-slate-500">{label}</dt>
      <dd className={`mt-2 text-3xl font-semibold tracking-tight ${valueColor}`}>{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}

function ChannelRow({ channel, status, statusError }: { channel: ChannelRecord; status: ChannelStatus | undefined; statusError: unknown }) {
  const state = channelStateView(channel, status);
  const lastRun = status?.lastRun ?? null;
  const model = channel.ai.model ? ` · ${channel.ai.model}` : '';
  return (
    <li className="flex flex-col gap-3 px-5 py-4 xl:flex-row xl:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/channels/${encodeURIComponent(channel.id)}/edit`} className="font-semibold text-slate-900 hover:text-indigo-700 hover:underline">
            {channel.name}
          </Link>
          <Badge tone={state.tone}>{state.label}</Badge>
          <Badge tone="slate">{channel.mode}</Badge>
          {status?.mutationState === 'blocked_ambiguous' ? <Badge tone="red">Bị chặn: lần gửi không rõ kết quả</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {channel.id} · AI: {labelOf(AI_PROVIDER_LABELS, channel.ai.provider)}{model} · Lịch <code className="font-mono">{channel.cron}</code> ({channel.timezone})
        </p>
        {statusError ? <p className="mt-1 text-xs text-rose-600">Không đọc được trạng thái kênh.</p> : null}
        {isCutoverPending(status ?? channel) ? <CutoverNotice channelId={channel.id} compact /> : null}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm xl:w-96">
        <div>
          <p className="text-xs text-slate-500">Lần chạy gần nhất</p>
          {lastRun ? (
            <p className="flex flex-wrap items-center gap-1.5" title={formatDateTime(lastRun.startedAt)}>
              <span>{formatRelative(lastRun.startedAt)}</span>
              <Badge tone={runStatusTone(lastRun.status)}>{labelOf(RUN_STATUS_LABELS, lastRun.status)}</Badge>
            </p>
          ) : (
            <p className="text-slate-400">{status ? 'Chưa chạy' : '…'}</p>
          )}
          {lastRun?.reason ? <p className="text-xs text-slate-500">{labelOf(RUN_REASON_LABELS, lastRun.reason)}</p> : null}
        </div>
        <div>
          <p className="text-xs text-slate-500">Hôm nay</p>
          <p>{status ? `${status.queue.delivered}/${status.dailyLimit} đã đăng` : '…'}</p>
          {status ? <p className="text-xs text-slate-500">{status.queue.remaining} trong queue</p> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 xl:justify-end">
        <PreviewButton channelId={channel.id} channelName={channel.name} />
        <RunNowButton channelId={channel.id} enabled={channel.enabled} status={status} />
        <PauseResumeButton channelId={channel.id} channelName={channel.name} status={status} />
      </div>
    </li>
  );
}

function RecentPosts({ channels }: { channels: ChannelRecord[] }) {
  const recent = useContentList(RECENT_POSTS_QUERY);
  const names = new Map(channels.map(channel => [channel.id, channel.name]));
  return (
    <Card className="mt-6">
      <CardHeader
        title="Bài vừa đăng"
        description="Những bài đăng thành công gần nhất trên mọi kênh."
        actions={<Link to="/library" className="text-sm font-medium text-indigo-700 hover:underline">Mở thư viện</Link>}
      />
      {recent.data === undefined ? (
        recent.isError
          ? <CardBody><ErrorState error={recent.error} onRetry={() => void recent.refetch()} /></CardBody>
          : <LoadingState />
      ) : recent.data.items.length === 0 ? (
        <EmptyState title="Chưa có bài nào được đăng" description="Bài đã đăng sẽ hiện ở đây sau lượt chạy đầu tiên." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {recent.data.items.map(item => (
            <li key={item.id} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <ExternalLink href={item.url} className="font-medium">{item.title ?? 'Không có tiêu đề'}</ExternalLink>
                <span className="text-xs text-slate-500" title={formatDateTime(item.deliveredAt)}>{formatRelative(item.deliveredAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {names.get(item.channelId) ?? item.channelId}
                {item.sourceName ? ` · ${item.sourceName}` : ''}
                {item.messageId ? ` · message ${item.messageId}` : ''}
              </p>
              {item.summaryPreview ? <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-slate-600">{item.summaryPreview}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
