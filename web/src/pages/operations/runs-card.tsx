import { useState } from 'react';

import { useRuns } from '../../api/queries';
import type { RunRecord } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { Pagination } from '../../components/pagination';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { cn } from '../../lib/cn';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '../../lib/format';
import { RUN_REASON_LABELS, RUN_STATUS_LABELS, TRIGGER_LABELS, labelOf } from '../../lib/labels';
import { runStatusTone } from '../../lib/status-tones';

const RUN_PAGE_SIZE = 20;

/** Paginated run history of one channel, newest first; each run opens its detail. */
export function RunsCard({ channelId, onShowRun }: { channelId: string; onShowRun: (runId: string) => void }) {
  const [offset, setOffset] = useState(0);
  const query = useRuns(channelId, { limit: RUN_PAGE_SIZE, offset });
  const data = query.data;

  return (
    <Card>
      <CardHeader title="Lịch sử run" description="Các lượt chạy theo lịch và chạy tay của kênh, mới nhất trước. Lịch sử run được giữ 180 ngày." />
      {data && query.error ? (
        <CardBody><StaleDataNotice errors={[query.error]} onRetry={() => void query.refetch()} /></CardBody>
      ) : null}
      {data === undefined ? (
        query.isError
          ? <CardBody><ErrorState error={query.error} onRetry={() => void query.refetch()} /></CardBody>
          : <LoadingState />
      ) : data.runs.length === 0 ? (
        offset > 0
          ? <EmptyState title="Trang này không còn run nào" action={<Button size="sm" onClick={() => setOffset(0)}>Về trang đầu</Button>} />
          : <EmptyState title="Chưa có lượt chạy nào" description="Run xuất hiện sau lượt chạy theo lịch hoặc Chạy ngay đầu tiên." />
      ) : (
        <RunsTable runs={data.runs} onShowRun={onShowRun} dimmed={query.isPlaceholderData} />
      )}
      {data ? <Pagination page={data.page} label="Phân trang lịch sử run" onOffsetChange={setOffset} pending={query.isPlaceholderData} /> : null}
    </Card>
  );
}

function RunsTable({ runs, onShowRun, dimmed }: { runs: RunRecord[]; onShowRun: (runId: string) => void; dimmed: boolean }) {
  return (
    <div className={cn('overflow-x-auto', dimmed && 'opacity-60')} aria-busy={dimmed || undefined}>
      <table aria-label="Lịch sử run" className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th scope="col" className="px-5 py-3">Bắt đầu</th>
            <th scope="col" className="px-5 py-3">Kích hoạt</th>
            <th scope="col" className="px-5 py-3">Trạng thái</th>
            <th scope="col" className="px-5 py-3">Thời lượng</th>
            <th scope="col" className="px-5 py-3">Output</th>
            <th scope="col" className="px-5 py-3">Token AI</th>
            <th scope="col" className="px-5 py-3">Lỗi</th>
            <th scope="col" className="px-5 py-3"><span className="sr-only">Thao tác</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {runs.map(run => {
            const startedAt = formatDateTime(run.startedAt);
            const reason = run.stats?.reason ?? null;
            return (
              <tr key={run.id} className="align-top">
                <td className="px-5 py-3 whitespace-nowrap">
                  {startedAt}
                  <span className="block text-xs text-slate-500">{formatRelative(run.startedAt)}</span>
                </td>
                <td className="px-5 py-3">
                  {labelOf(TRIGGER_LABELS, run.triggerType)}
                  {run.stats?.triggeredBy ? <span className="block max-w-48 truncate text-xs text-slate-500" title={run.stats.triggeredBy}>{run.stats.triggeredBy}</span> : null}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={runStatusTone(run.status)}>{labelOf(RUN_STATUS_LABELS, run.status)}</Badge>
                  {reason ? <span className="mt-1 block text-xs text-slate-500">{labelOf(RUN_REASON_LABELS, reason)}</span> : null}
                </td>
                <td className="px-5 py-3 whitespace-nowrap">{formatDuration(run.durationMs)}</td>
                <td className="px-5 py-3 whitespace-nowrap">
                  {run.outputsTotal ? `${formatNumber(run.outputsSucceeded)}/${formatNumber(run.outputsTotal)} thành công` : '—'}
                </td>
                <td className="px-5 py-3 text-xs whitespace-nowrap">
                  {run.aiInputTokens !== null || run.aiOutputTokens !== null
                    ? `${formatNumber(run.aiInputTokens)} in · ${formatNumber(run.aiOutputTokens)} out`
                    : '—'}
                </td>
                <td className="max-w-xs px-5 py-3 text-xs text-rose-700">
                  {run.error ? <span className="line-clamp-2 break-words" title={run.error}>{run.error}</span> : null}
                </td>
                <td className="px-5 py-3 text-right">
                  <Button size="sm" aria-label={`Chi tiết run lúc ${startedAt}`} onClick={() => onShowRun(run.id)}>Chi tiết</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
