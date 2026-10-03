/**
 * Read-only preview (`POST /api/channels/:id/preview`): the server fetches
 * the sources and calls the AI exactly like a run, but never sends anything
 * and never writes delivery state, runs, or library rows. Generated text is
 * untrusted and rendered as plain text only.
 */

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useApi } from '../../api/api-context';
import type { PreviewResult, SourceHealthEntry } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { IconEye, IconRefresh } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { ErrorState, LoadingState, Notice } from '../../components/states';
import { formatDay, formatDuration, formatNumber } from '../../lib/format';
import { MODE_LABELS, RUN_REASON_LABELS, labelOf } from '../../lib/labels';

export function PreviewButton({ channelId, channelName, size = 'sm' }: { channelId: string; channelName: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <OperatorButton size={size} icon={<IconEye className="size-3.5" />} onClick={() => setOpen(true)}>
        Preview
      </OperatorButton>
      {open ? <PreviewDialog channelId={channelId} channelName={channelName} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function PreviewDialog({ channelId, channelName, onClose }: { channelId: string; channelName: string; onClose: () => void }) {
  const api = useApi();
  const mutation = useMutation({ mutationFn: () => api.preview(channelId) });
  const started = useRef(false);
  const { mutate } = mutation;

  useEffect(() => {
    // Guarded so a remounted effect (React StrictMode) never starts a second AI call.
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`Preview — ${channelName}`}
      description="Chỉ xem trước: lấy bài từ nguồn và gọi AI, không gửi gì lên Telegram và không ghi trạng thái."
      footer={(
        <>
          <Button icon={<IconRefresh className="size-4" />} onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            Chạy lại preview
          </Button>
          <Button variant="primary" onClick={onClose}>Đóng</Button>
        </>
      )}
    >
      {mutation.isPending || mutation.isIdle ? (
        <LoadingState label="Đang lấy bài từ nguồn và gọi AI… việc này có thể mất khoảng một phút." />
      ) : mutation.isError ? (
        <ErrorState error={mutation.error} onRetry={() => mutation.mutate()} />
      ) : (
        <PreviewResultView result={mutation.data} />
      )}
    </Dialog>
  );
}

export function PreviewResultView({ result }: { result: PreviewResult }) {
  const failedSources = result.sources.filter(source => source.status === 'failed');
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="indigo">Không gửi — chỉ xem trước</Badge>
        <Badge tone={result.status === 'dry_run' ? 'green' : result.status === 'failed' ? 'red' : 'slate'}>
          {labelOf(PREVIEW_STATUS_LABELS, result.status)}
        </Badge>
        <span className="text-slate-500">{labelOf(MODE_LABELS, result.mode)}</span>
        {result.publishingDay ? <span className="text-slate-500">· Ngày đăng {formatDay(result.publishingDay)}</span> : null}
      </div>
      {result.reason ? <Notice tone="info">Lý do: {labelOf(RUN_REASON_LABELS, result.reason)}</Notice> : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bài được chọn" value={formatNumber(result.stats.articles)} />
        <Stat label="Nguồn" value={formatNumber(result.stats.sources)} />
        <Stat label="Thời gian" value={formatDuration(result.stats.durationMs)} />
        <Stat
          label="Lượt gọi AI"
          value={`${result.aiUsage.succeeded}/${result.aiUsage.attempted}`}
          hint={result.aiUsage.inputTokens !== null ? `${formatNumber(result.aiUsage.inputTokens)} in · ${formatNumber(result.aiUsage.outputTokens)} out token` : undefined}
        />
      </dl>

      {result.stats.selection ? (
        <div>
          <h3 className="mb-1 font-medium text-slate-700">Chuỗi lọc bài</h3>
          <p className="text-slate-600">
            {SELECTION_STEPS.filter(([key]) => result.stats.selection?.[key] !== undefined)
              .map(([key, label]) => `${label}: ${formatNumber(result.stats.selection?.[key])}`)
              .join(' → ')}
          </p>
        </div>
      ) : null}

      {result.content ? (
        <div>
          <h3 className="mb-1 font-medium text-slate-700">Nội dung sẽ được tạo</h3>
          <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-sans text-sm whitespace-pre-wrap break-words text-slate-800">{result.content}</pre>
        </div>
      ) : null}

      {result.items.length > 0 ? (
        <div>
          <h3 className="mb-2 font-medium text-slate-700">Bài sẽ được đăng ({result.items.length})</h3>
          <ol className="space-y-3">
            {result.items.map((item, index) => (
              <li key={`${index}-${item.title ?? ''}`} className="rounded-lg border border-slate-200 p-3">
                <p className="font-medium text-slate-900">{item.title ?? 'Không có tiêu đề'}</p>
                {item.hook ? <pre className="mt-2 max-h-64 overflow-auto font-sans whitespace-pre-wrap break-words text-slate-700">{item.hook}</pre> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {!result.content && result.items.length === 0 ? (
        <Notice tone="info">Không có nội dung nào được tạo trong lần preview này.</Notice>
      ) : null}

      {result.sourceHealth ? (
        <div>
          <h3 className="mb-1 font-medium text-slate-700">Sức khoẻ nguồn</h3>
          <p className="text-slate-600">
            {formatNumber(result.sourceHealth.healthy)}/{formatNumber(result.sourceHealth.total)} nguồn hoạt động
            {result.sourceHealth.failed ? ` · ${formatNumber(result.sourceHealth.failed)} nguồn lỗi` : ''}
            {result.sourceHealth.degraded ? ' · đang suy giảm' : ''}
          </p>
          {failedSources.length > 0 ? <FailedSources sources={failedSources} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const PREVIEW_STATUS_LABELS: Readonly<Record<string, string>> = {
  dry_run: 'Preview hoàn tất',
  failed: 'Preview thất bại',
};

const SELECTION_STEPS = [
  ['fetched', 'Lấy về'],
  ['fresh', 'Mới'],
  ['uncovered', 'Chưa đưa tin'],
  ['relevant', 'Đúng chủ đề'],
  ['ranked', 'Sau chấm điểm'],
  ['enqueued', 'Xếp hàng'],
] as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-slate-900">{value}</dd>
      {hint ? <dd className="text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}

function FailedSources({ sources }: { sources: SourceHealthEntry[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {sources.map(source => (
        <li key={source.sourceId} className="flex flex-wrap items-center gap-2 text-slate-600">
          <Badge tone="red">Lỗi</Badge>
          <span>{source.sourceName ?? source.sourceId}</span>
          {source.errorClass ? <span className="text-xs text-slate-400">({source.errorClass})</span> : null}
        </li>
      ))}
    </ul>
  );
}
