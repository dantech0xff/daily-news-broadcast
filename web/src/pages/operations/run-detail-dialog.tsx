/**
 * One run (`GET /api/runs/:id`): timings, outcome, selection chain, AI usage,
 * output results, the articles of the run, and the health of every source it
 * fetched. Text fields are sanitized server-side and rendered as plain text.
 */

import type { ReactNode } from 'react';

import { useRun } from '../../api/queries';
import type { RunDetail, SourceHealthEntry } from '../../api/types';
import { Badge, type BadgeTone } from '../../components/badge';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ErrorState, LoadingState, Notice } from '../../components/states';
import { formatDateTime, formatDay, formatDuration, formatNumber } from '../../lib/format';
import {
  DELIVERY_STATE_LABELS,
  ERROR_CLASS_LABELS,
  MODE_LABELS,
  RUN_REASON_LABELS,
  RUN_STATUS_LABELS,
  SOURCE_HEALTH_LABELS,
  TRIGGER_LABELS,
  labelOf,
} from '../../lib/labels';
import { formatSelectionChain } from '../../lib/operations';
import { runStatusTone } from '../../lib/status-tones';

export function RunDetailDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const query = useRun(runId);
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title="Chi tiết run"
      description={<span className="font-mono text-xs break-all">{runId}</span>}
      footer={<Button variant="primary" onClick={onClose}>Đóng</Button>}
    >
      {query.data ? (
        <RunDetailView run={query.data} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <LoadingState />
      )}
    </Dialog>
  );
}

const HEALTH_TONES: Record<SourceHealthEntry['status'], BadgeTone> = { healthy: 'green', empty: 'amber', failed: 'red' };
const HEALTH_ORDER: Record<SourceHealthEntry['status'], number> = { failed: 0, empty: 1, healthy: 2 };
/** Outcome of one send as the output reported it. */
const SEND_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  success: 'Đã gửi',
  definitive_failure: 'Lỗi xác định (chưa gửi)',
  ambiguous: 'Không rõ đã gửi hay chưa',
};

export function RunDetailView({ run }: { run: RunDetail }) {
  const stats = run.stats ?? {};
  const selection = formatSelectionChain(stats.selection);
  const outputResults = stats.outputResults ?? [];
  const items = stats.items ?? [];
  const generation = stats.generation;
  const outputs = stats.outputs;
  const health = stats.sourceHealth;
  const sources = [...run.sourceHealth].sort((left, right) => (
    HEALTH_ORDER[left.status] - HEALTH_ORDER[right.status]
    || (left.sourceName ?? left.sourceId).localeCompare(right.sourceName ?? right.sourceId)
  ));

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={runStatusTone(run.status)}>{labelOf(RUN_STATUS_LABELS, run.status)}</Badge>
        <Badge tone="slate">{labelOf(TRIGGER_LABELS, run.triggerType)}</Badge>
        {stats.mode ? <span className="text-slate-500">{labelOf(MODE_LABELS, stats.mode)}</span> : null}
        {stats.reason ? <span className="text-slate-600">· Lý do: {labelOf(RUN_REASON_LABELS, stats.reason)}</span> : null}
      </div>
      {run.error ? (
        <Notice tone="danger" title="Lỗi">
          <p className="break-words whitespace-pre-wrap">{run.error}</p>
        </Notice>
      ) : null}
      {stats.scanError && stats.scanError !== run.error ? (
        <Notice tone="warning" title="Lỗi quét nguồn">
          <p className="break-words whitespace-pre-wrap">{stats.scanError}</p>
        </Notice>
      ) : null}
      {stats.detailTruncated ? (
        <Notice tone="info">Chi tiết từng bài và từng output đã được lược bớt vì quá lớn; các con số tổng vẫn đầy đủ.</Notice>
      ) : null}

      <Section title="Thời gian">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Bắt đầu" value={formatDateTime(run.startedAt)} />
          <Field label="Kết thúc" value={formatDateTime(run.finishedAt)} />
          <Field label="Thời lượng" value={formatDuration(run.durationMs)} />
          <Field label="Thời gian engine" value={formatDuration(stats.engineDurationMs)} />
          <Field label="Yêu cầu lúc" value={formatDateTime(stats.requestedAt)} />
          <Field label="Kích hoạt bởi" value={stats.triggeredBy ?? (run.triggerType === 'scheduled' ? 'Lịch chạy' : '—')} />
          <Field label="Ngày đăng" value={formatDay(stats.publishingDay)} />
          <Field label="Delivery" value={stats.deliveryId ?? '—'} mono />
        </dl>
      </Section>

      <Section title="Lựa chọn bài">
        <p className="text-slate-700">{selection ?? 'Lượt chạy này không quét nguồn.'}</p>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <Field label="Bài trong lượt" value={formatNumber(stats.articles)} />
          <Field label="Còn lại trong queue" value={formatNumber(stats.remaining)} />
          <Field label="Bị chặn" value={formatNumber(stats.blocked)} />
        </dl>
      </Section>

      <Section title="AI">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Lượt gọi AI thành công" value={generation ? `${formatNumber(generation.succeeded)}/${formatNumber(generation.attempted)}` : '—'} />
          <Field label="Lượt gọi AI lỗi" value={formatNumber(generation?.failed)} />
          <Field label="Token đầu vào" value={formatNumber(run.aiInputTokens)} />
          <Field label="Token đầu ra" value={formatNumber(run.aiOutputTokens)} />
        </dl>
      </Section>

      <Section title="Output">
        <p className="text-slate-700">
          {outputs
            ? `${formatNumber(outputs.succeeded)}/${formatNumber(outputs.total)} lần gửi thành công · ${formatNumber(outputs.failed)} lỗi`
            : `${formatNumber(run.outputsSucceeded)}/${formatNumber(run.outputsTotal)} lần gửi thành công`}
        </p>
        {outputResults.length > 0 ? (
          <Table label="Kết quả gửi" headers={['Delivery', 'Output', 'Kết quả', 'Trạng thái', 'Message ID', 'Lỗi']}>
            {outputResults.map((result, index) => (
              <tr key={`${result.deliveryId ?? ''}:${result.outputId ?? ''}:${index}`} className="align-top">
                <td className="max-w-40 truncate px-3 py-2 font-mono text-xs" title={result.deliveryId ?? undefined}>{result.deliveryId ?? '—'}</td>
                <td className="px-3 py-2">{result.outputId ?? '—'}</td>
                <td className="px-3 py-2"><Badge tone={result.success ? 'green' : 'red'}>{result.success ? 'Thành công' : 'Lỗi'}</Badge></td>
                <td className="px-3 py-2 text-xs">{labelOf(SEND_OUTCOME_LABELS, result.deliveryState)}</td>
                <td className="px-3 py-2 font-mono text-xs">{result.messageIds.length > 0 ? result.messageIds.join(', ') : '—'}</td>
                <td className="px-3 py-2 text-xs break-words text-rose-700">{result.error ?? ''}</td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>

      {items.length > 0 ? (
        <Section title={`Bài trong lượt chạy (${items.length})`}>
          <Table label="Bài trong lượt chạy" headers={['Bài', 'Kết quả', 'Trạng thái giao hàng', 'Lý do']}>
            {items.map((item, index) => (
              <tr key={`${item.deliveryId ?? ''}:${index}`} className="align-top">
                <td className="px-3 py-2">{item.title ?? 'Không có tiêu đề'}</td>
                <td className="px-3 py-2 text-xs">{item.status ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{labelOf(DELIVERY_STATE_LABELS, item.deliveryState)}</td>
                <td className="px-3 py-2 text-xs break-words">{item.reason ? labelOf(RUN_REASON_LABELS, item.reason) : '—'}</td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      <Section title="Sức khoẻ nguồn">
        {health ? (
          <p className="text-slate-700">
            {formatNumber(health.healthy)}/{formatNumber(health.total)} nguồn ổn
            {health.failed ? ` · ${formatNumber(health.failed)} nguồn lỗi` : ''}
            {health.unknown ? ` · ${formatNumber(health.unknown)} chưa xác minh` : ''}
            {health.degraded ? ' · đang suy giảm' : ''}
          </p>
        ) : null}
        {sources.length === 0 ? (
          <p className="text-slate-500">Lượt chạy này không ghi nhận nguồn nào.</p>
        ) : (
          <Table label="Sức khoẻ từng nguồn" headers={['Nguồn', 'Trạng thái', 'Số bài', 'Lớp lỗi']}>
            {sources.map(source => (
              <tr key={source.sourceId} className="align-top">
                <td className="px-3 py-2">
                  {source.sourceName ?? source.sourceId}
                  {source.sourceName ? <span className="block font-mono text-xs text-slate-500">{source.sourceId}</span> : null}
                </td>
                <td className="px-3 py-2"><Badge tone={HEALTH_TONES[source.status]}>{labelOf(SOURCE_HEALTH_LABELS, source.status)}</Badge></td>
                <td className="px-3 py-2">{formatNumber(source.articleCount)}</td>
                <td className="px-3 py-2 text-xs">
                  {source.errorClass ? <>{labelOf(ERROR_CLASS_LABELS, source.errorClass)} <code className="text-slate-500">({source.errorClass})</code></> : '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 font-semibold text-slate-800">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 p-2.5">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={mono ? 'mt-0.5 truncate font-mono text-xs text-slate-800' : 'mt-0.5 font-medium text-slate-900'} title={mono ? value : undefined}>{value}</dd>
    </div>
  );
}

function Table({ label, headers, children }: { label: string; headers: string[]; children: ReactNode }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
      <table aria-label={label} className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
          <tr>{headers.map(header => <th key={header} scope="col" className="px-3 py-2">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
