import { useId } from 'react';

import { useQueue } from '../../api/queries';
import type { QueueView } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { ExternalLink } from '../../components/external-link';
import { TextInput } from '../../components/form-controls';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { addDays, isDay } from '../../lib/days';
import { formatDateTime, formatDay, formatNumber } from '../../lib/format';
import { CONTENT_STATUS_LABELS, DELIVERY_STATE_LABELS, labelOf } from '../../lib/labels';
import { contentStatusTone } from '../../lib/status-tones';

/**
 * Deliveries of one publishing day in queue order. `day` is `null` for
 * today in the channel timezone (the server decides which day that is).
 */
export function QueueCard({ channelId, timezone, day, onDayChange }: {
  channelId: string;
  timezone: string;
  day: string | null;
  onDayChange: (day: string | null) => void;
}) {
  const query = useQueue(channelId, day);
  const data = query.data;
  const shown = data?.date ?? day;
  const dateInputId = useId();

  return (
    <Card>
      <CardHeader
        title="Queue theo ngày"
        description={`Các mục của một ngày đăng theo timezone của kênh (${timezone}), theo thứ tự trong queue. Mặc định là hôm nay.`}
        actions={(
          <>
            <Button size="sm" disabled={!shown} onClick={() => shown && onDayChange(addDays(shown, -1))}>Ngày trước</Button>
            <div className="flex items-center gap-2">
              <label htmlFor={dateInputId} className="text-sm font-medium text-slate-700">Ngày</label>
              <div className="w-40">
                <TextInput
                  id={dateInputId}
                  type="date"
                  value={shown ?? ''}
                  onChange={event => {
                    if (isDay(event.target.value)) onDayChange(event.target.value);
                  }}
                />
              </div>
            </div>
            <Button size="sm" disabled={!shown} onClick={() => shown && onDayChange(addDays(shown, 1))}>Ngày sau</Button>
            <Button size="sm" disabled={day === null} onClick={() => onDayChange(null)}>Hôm nay</Button>
          </>
        )}
      />
      {data && query.error ? (
        <CardBody><StaleDataNotice errors={[query.error]} onRetry={() => void query.refetch()} /></CardBody>
      ) : null}
      {data === undefined ? (
        query.isError
          ? <CardBody><ErrorState error={query.error} onRetry={() => void query.refetch()} /></CardBody>
          : <LoadingState />
      ) : (
        <QueueContent queue={data} />
      )}
    </Card>
  );
}

function QueueContent({ queue }: { queue: QueueView }) {
  return (
    <>
      <p className="border-b border-slate-100 px-5 py-3 text-sm text-slate-600">
        Ngày <span className="font-medium text-slate-900">{formatDay(queue.date)}</span>
        {' · '}{formatNumber(queue.total)} mục · {formatNumber(queue.remaining)} còn lại · {formatNumber(queue.blocked)} bị chặn
        {' · '}{formatNumber(queue.delivered)} đã đăng
      </p>
      {queue.items.length === 0 ? (
        <EmptyState title={`Không có mục nào trong queue ngày ${formatDay(queue.date)}`} />
      ) : (
        <div className="overflow-x-auto">
          <table aria-label={`Queue ngày ${formatDay(queue.date)}`} className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-5 py-3">#</th>
                <th scope="col" className="px-5 py-3">Bài</th>
                <th scope="col" className="px-5 py-3">Nguồn</th>
                <th scope="col" className="px-5 py-3">Trạng thái</th>
                <th scope="col" className="px-5 py-3">Tạo lúc</th>
                <th scope="col" className="px-5 py-3">Cập nhật</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {queue.items.map(item => (
                <tr key={item.deliveryId} className="align-top">
                  <td className="px-5 py-3 text-slate-500">{item.position + 1}</td>
                  <td className="max-w-md min-w-64 px-5 py-3">
                    <ExternalLink href={item.url} className="font-medium">{item.title ?? 'Không có tiêu đề'}</ExternalLink>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {item.articleCount > 1 ? <Badge tone="slate">{item.articleCount} bài</Badge> : null}
                      {item.forced ? <Badge tone="amber" title="Tạo bởi lượt chạy force, không theo lịch">Force</Badge> : null}
                    </span>
                  </td>
                  <td className="px-5 py-3">{item.source ?? '—'}</td>
                  <td className="px-5 py-3">
                    <Badge tone={contentStatusTone(item.status)}>{labelOf(CONTENT_STATUS_LABELS, item.status)}</Badge>
                    <p className="mt-1 text-xs text-slate-500" title={item.deliveryState}>{labelOf(DELIVERY_STATE_LABELS, item.deliveryState)}</p>
                  </td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap text-slate-500">{formatDateTime(item.createdAt)}</td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap text-slate-500">{formatDateTime(item.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
