import { Link } from 'react-router';

import { useChannelStatuses, useChannels } from '../../api/queries';
import { Badge } from '../../components/badge';
import { ButtonLink } from '../../components/button';
import { Card, CardBody } from '../../components/card';
import { IconPlus } from '../../components/icons';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { useSession } from '../../app/session';
import { describeCron } from '../../lib/cron';
import { formatDateTime } from '../../lib/format';
import { AI_PROVIDER_LABELS, labelOf } from '../../lib/labels';
import { channelStateView } from '../../lib/operations';

export function ChannelsPage() {
  const { canOperate } = useSession();
  const channels = useChannels();
  const statuses = useChannelStatuses(channels.data?.map(channel => channel.id) ?? []);

  return (
    <>
      <PageHeader
        title="Kênh"
        description="Cấu hình các kênh Telegram: nguồn, lịch, AI, prompt, credential và giới hạn. Thay đổi có hiệu lực ở lượt chạy kế tiếp, không cần deploy lại."
        actions={canOperate ? <ButtonLink to="/channels/new" variant="primary" icon={<IconPlus className="size-4" />}>Tạo kênh</ButtonLink> : null}
      />
      <StaleDataNotice className="mb-4" errors={[channels.data ? channels.error : null]} onRetry={() => void channels.refetch()} />
      <Card>
        {channels.data === undefined ? (
          channels.isError
            ? <CardBody><ErrorState error={channels.error} onRetry={() => void channels.refetch()} /></CardBody>
            : <LoadingState />
        ) : channels.data.length === 0 ? (
          <EmptyState
            title="Chưa có kênh nào"
            description="Kênh mới luôn được tạo ở trạng thái tạm dừng."
            action={canOperate ? <ButtonLink to="/channels/new" variant="primary">Tạo kênh</ButtonLink> : null}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3">Kênh</th>
                  <th scope="col" className="px-5 py-3">Trạng thái</th>
                  <th scope="col" className="px-5 py-3">Mode</th>
                  <th scope="col" className="px-5 py-3">Lịch</th>
                  <th scope="col" className="px-5 py-3">AI</th>
                  <th scope="col" className="px-5 py-3">Nguồn</th>
                  <th scope="col" className="px-5 py-3">Cập nhật</th>
                  <th scope="col" className="px-5 py-3"><span className="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {channels.data.map((channel, index) => {
                  const state = channelStateView(channel, statuses[index]?.data);
                  const enabledSources = channel.sources.filter(source => source.enabled).length;
                  return (
                    <tr key={channel.id} className="align-top">
                      <td className="px-5 py-3">
                        <Link to={`/channels/${encodeURIComponent(channel.id)}/edit`} className="font-medium text-slate-900 hover:text-indigo-700 hover:underline">
                          {channel.name}
                        </Link>
                        <p className="font-mono text-xs text-slate-500">{channel.id}</p>
                      </td>
                      <td className="px-5 py-3"><Badge tone={state.tone}>{state.label}</Badge></td>
                      <td className="px-5 py-3">{channel.mode}</td>
                      <td className="px-5 py-3">
                        <code className="font-mono text-xs">{channel.cron}</code>
                        <p className="text-xs text-slate-500">{describeCron(channel.cron) ?? '—'} · {channel.timezone}</p>
                      </td>
                      <td className="px-5 py-3">
                        {labelOf(AI_PROVIDER_LABELS, channel.ai.provider)}
                        <p className="font-mono text-xs text-slate-500">{channel.ai.model ?? 'model mặc định'}</p>
                      </td>
                      <td className="px-5 py-3">{enabledSources}/{channel.sources.length} đang bật</td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {formatDateTime(channel.updatedAt)}
                        {channel.updatedBy ? <p>{channel.updatedBy}</p> : null}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <ButtonLink to={`/channels/${encodeURIComponent(channel.id)}/edit`} size="sm">
                          {canOperate ? 'Sửa' : 'Xem'}
                        </ButtonLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
