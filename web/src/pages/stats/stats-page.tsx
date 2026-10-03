/**
 * Thống kê (`/stats?range=7|30|90|custom&from&to&channel`): posts per day per
 * channel, source health over time, AI and output failure rates, and AI
 * token usage, over Vietnam days (see `stats-range.ts`). Read-only.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useChannels, useMeta, useStats } from '../../api/queries';
import type { Stats } from '../../api/types';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { ChannelSelect } from '../../components/channel-select';
import { Field, TextInput } from '../../components/form-controls';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, Notice, StaleDataNotice } from '../../components/states';
import { cn } from '../../lib/cn';
import { addDays, todayInVietnam } from '../../lib/days';
import { formatDay, formatNumber, formatPercent } from '../../lib/format';
import { ChartDataTable, LineChart, StackedBarChart, seriesColor, type ChartSeries } from './charts';
import { SourceHealthTable } from './source-health-table';
import {
  DEFAULT_MAX_RANGE_DAYS,
  RANGE_PRESETS,
  customRangeError,
  parseStatsParams,
  resolveStatsRange,
  statsParams,
  type StatsView,
} from './stats-range';

const RETENTION_NOTE = 'Lịch sử run và sức khoẻ nguồn được giữ 180 ngày; bài quét chưa đăng giữ 30 ngày; bài đã đăng giữ vĩnh viễn.';

export function StatsPage() {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => parseStatsParams(params), [params]);
  const meta = useMeta();
  const channels = useChannels();
  const maxRangeDays = meta.data?.stats.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;
  const today = todayInVietnam();
  const range = resolveStatsRange(view, { today, maxRangeDays });
  const stats = useStats(range.ok ? range.query : null);
  const channelList = channels.data ?? [];
  const channelName = (channelId: string) => channelList.find(channel => channel.id === channelId)?.name ?? channelId;
  const update = (next: StatsView) => setParams(statsParams(next));

  const startCustom = () => update({
    ...view,
    preset: 'custom',
    from: range.ok ? range.fromDay : addDays(today, -29),
    to: range.ok ? range.toDay : today,
  });

  let body: ReactNode;
  if (!range.ok) {
    body = <Notice tone="warning" title="Khoảng thời gian không hợp lệ">{range.error}</Notice>;
  } else if (stats.data === undefined) {
    body = stats.isError ? <ErrorState error={stats.error} onRetry={() => void stats.refetch()} /> : <LoadingState />;
  } else {
    body = (
      <>
        {stats.error ? <StaleDataNotice className="mb-6" errors={[stats.error]} onRetry={() => void stats.refetch()} /> : null}
        <StatsCharts stats={stats.data} days={range.days} channelName={channelName} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Thống kê" description="Bài đã đăng, sức khoẻ nguồn, tỉ lệ lỗi và token usage theo ngày (giờ Việt Nam, UTC+7)." />

      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div role="group" aria-label="Khoảng thời gian" className="flex flex-wrap gap-2">
              {RANGE_PRESETS.map(preset => (
                <Button
                  key={preset}
                  size="sm"
                  variant={view.preset === preset ? 'primary' : 'secondary'}
                  aria-pressed={view.preset === preset}
                  onClick={() => update({ ...view, preset, from: '', to: '' })}
                >
                  {preset} ngày
                </Button>
              ))}
              <Button size="sm" variant={view.preset === 'custom' ? 'primary' : 'secondary'} aria-pressed={view.preset === 'custom'} onClick={startCustom}>
                Tuỳ chọn
              </Button>
            </div>
            <ChannelSelect
              id="stats-channel"
              allowAll
              value={view.channelId}
              channels={channelList}
              onChange={channelId => update({ ...view, channelId })}
            />
          </div>
          {view.preset === 'custom' ? (
            <CustomRangeForm
              key={`${view.from}|${view.to}`}
              from={view.from}
              to={view.to}
              maxRangeDays={maxRangeDays}
              onApply={(from, to) => update({ ...view, preset: 'custom', from, to })}
            />
          ) : null}
          {range.ok ? (
            <p className="text-sm text-slate-600">
              Từ <span className="font-medium text-slate-900">{formatDay(range.fromDay)}</span> đến{' '}
              <span className="font-medium text-slate-900">{formatDay(range.toDay)}</span> ({range.days.length} ngày)
              {view.channelId ? ` · kênh ${channelName(view.channelId)}` : ' · mọi kênh'}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="mt-6">{body}</div>

      <p className="mt-6 text-xs text-slate-500">
        <span className="font-medium">Thời hạn lưu dữ liệu:</span> {RETENTION_NOTE} Với khoảng thời gian dài hơn 180 ngày, chỉ số bài đã
        đăng còn đầy đủ.
      </p>
    </>
  );
}

function CustomRangeForm({ from, to, maxRangeDays, onApply }: {
  from: string;
  to: string;
  maxRangeDays: number;
  onApply: (from: string, to: string) => void;
}) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = customRangeError(draftFrom, draftTo, maxRangeDays);
    setError(problem);
    if (!problem) onApply(draftFrom, draftTo);
  };

  return (
    <form aria-label="Khoảng thời gian tuỳ chọn" noValidate onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Field id="stats-from" label="Từ ngày" className="w-44">
        <TextInput id="stats-from" type="date" value={draftFrom} onChange={event => setDraftFrom(event.target.value)} />
      </Field>
      <Field id="stats-to" label="Đến ngày" className="w-44">
        <TextInput id="stats-to" type="date" value={draftTo} min={draftFrom || undefined} onChange={event => setDraftTo(event.target.value)} />
      </Field>
      <Button type="submit" variant="primary">Áp dụng</Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-rose-700">{error}</p>
      ) : (
        <p className="w-full text-xs text-slate-500">Tối đa {maxRangeDays} ngày, gồm cả ngày đầu và ngày cuối.</p>
      )}
    </form>
  );
}

function StatsCharts({ stats, days, channelName }: { stats: Stats; days: string[]; channelName: (channelId: string) => string }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <PostsCard rows={stats.postsPerDay} days={days} channelName={channelName} className="xl:col-span-2" />
      <SourceHealthCard rows={stats.sourceHealthPerDay} days={days} className="xl:col-span-2" />
      <FailureRatesCard rows={stats.failureRatesPerDay} days={days} />
      <TokenUsageCard rows={stats.tokenUsagePerDay} days={days} />
    </div>
  );
}

function ChartCard({ title, description, className, children }: { title: string; description?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader title={title} description={description} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function PostsCard({ rows, days, channelName, className }: {
  rows: Stats['postsPerDay'];
  days: string[];
  channelName: (channelId: string) => string;
  className?: string;
}) {
  const posts = new Map(rows.map(row => [`${row.day}|${row.channelId}`, row.posts]));
  const series: ChartSeries[] = [...new Set(rows.map(row => row.channelId))]
    .sort((left, right) => channelName(left).localeCompare(channelName(right)))
    .map((channelId, index) => ({ key: channelId, label: channelName(channelId), color: seriesColor(index) }));
  const value = (day: string, channelId: string) => posts.get(`${day}|${channelId}`) ?? 0;
  const dayTotal = (day: string) => series.reduce((sum, entry) => sum + value(day, entry.key), 0);
  const total = rows.reduce((sum, row) => sum + row.posts, 0);

  return (
    <ChartCard
      title="Bài đã đăng theo ngày"
      description={total > 0 ? `Tổng ${formatNumber(total)} bài trên ${formatNumber(series.length)} kênh.` : 'Số bài đăng thành công mỗi ngày, theo kênh.'}
      className={className}
    >
      {total === 0 ? (
        <EmptyState title="Chưa có bài nào được đăng trong khoảng này" />
      ) : (
        <>
          <StackedBarChart label="Biểu đồ bài đã đăng theo ngày" days={days} series={series} value={value} />
          <ChartDataTable
            label="Số bài đã đăng theo ngày"
            columns={['Ngày', ...series.map(entry => entry.label), 'Tổng']}
            rows={days.map(day => [formatDay(day), ...series.map(entry => formatNumber(value(day, entry.key))), formatNumber(dayTotal(day))])}
          />
        </>
      )}
    </ChartCard>
  );
}

function SourceHealthCard({ rows, days, className }: { rows: Stats['sourceHealthPerDay']; days: string[]; className?: string }) {
  return (
    <ChartCard
      title="Sức khoẻ nguồn theo thời gian"
      description="Kết quả quét từng nguồn qua các lượt chạy: số lần ổn, rỗng (không có bài) và lỗi; mỗi ô là một ngày, rê chuột để xem số liệu."
      className={className}
    >
      {rows.length === 0 ? (
        <EmptyState title="Chưa có dữ liệu sức khoẻ nguồn trong khoảng này" description="Dữ liệu xuất hiện sau các lượt chạy có quét nguồn." />
      ) : (
        <SourceHealthTable rows={rows} days={days} />
      )}
    </ChartCard>
  );
}

const FAILURE_SERIES: readonly ChartSeries[] = [
  { key: 'generation', label: 'AI (tạo nội dung)', color: seriesColor(0) },
  { key: 'output', label: 'Output (gửi Telegram)', color: seriesColor(4) },
];

function FailureRatesCard({ rows, days }: { rows: Stats['failureRatesPerDay']; days: string[] }) {
  const byDay = new Map(rows.map(row => [row.day, row]));
  const totals = rows.reduce((sum, row) => ({
    runs: sum.runs + row.runs,
    failedRuns: sum.failedRuns + row.failedRuns,
    generationAttempts: sum.generationAttempts + row.generationAttempts,
    generationFailures: sum.generationFailures + row.generationFailures,
    outputAttempts: sum.outputAttempts + row.outputAttempts,
    outputFailures: sum.outputFailures + row.outputFailures,
  }), { runs: 0, failedRuns: 0, generationAttempts: 0, generationFailures: 0, outputAttempts: 0, outputFailures: 0 });
  const rate = (day: string, key: string): number | null => {
    const row = byDay.get(day);
    if (!row) return null;
    return key === 'generation' ? row.generationFailureRate : row.outputFailureRate;
  };
  const describePoint = (day: string, key: string): string => {
    const row = byDay.get(day);
    if (!row) return formatDay(day);
    return key === 'generation'
      ? `${formatDay(day)} · AI: ${row.generationFailures}/${row.generationAttempts} lượt lỗi (${formatPercent(row.generationFailureRate)})`
      : `${formatDay(day)} · Output: ${row.outputFailures}/${row.outputAttempts} lần gửi lỗi (${formatPercent(row.outputFailureRate)})`;
  };
  const attempted = totals.generationAttempts + totals.outputAttempts > 0;

  return (
    <ChartCard
      title="Tỉ lệ lỗi AI / output theo ngày"
      description={rows.length > 0
        ? `${formatNumber(totals.runs)} run (${formatNumber(totals.failedRuns)} lỗi) · AI lỗi ${formatNumber(totals.generationFailures)}/${formatNumber(totals.generationAttempts)} · output lỗi ${formatNumber(totals.outputFailures)}/${formatNumber(totals.outputAttempts)}.`
        : 'Tỉ lệ lượt gọi AI và lần gửi Telegram bị lỗi mỗi ngày.'}
    >
      {!attempted ? (
        <EmptyState title="Chưa có lượt gọi AI hay lần gửi nào trong khoảng này" />
      ) : (
        <>
          <LineChart
            label="Biểu đồ tỉ lệ lỗi AI và output theo ngày"
            days={days}
            series={FAILURE_SERIES}
            value={rate}
            max={1}
            formatValue={value => formatPercent(value)}
            describePoint={describePoint}
          />
          <ChartDataTable
            label="Tỉ lệ lỗi theo ngày"
            columns={['Ngày', 'Run', 'Run lỗi', 'AI lỗi', 'Output lỗi']}
            rows={rows.map(row => [
              formatDay(row.day),
              formatNumber(row.runs),
              formatNumber(row.failedRuns),
              `${formatNumber(row.generationFailures)}/${formatNumber(row.generationAttempts)} (${formatPercent(row.generationFailureRate)})`,
              `${formatNumber(row.outputFailures)}/${formatNumber(row.outputAttempts)} (${formatPercent(row.outputFailureRate)})`,
            ])}
          />
        </>
      )}
    </ChartCard>
  );
}

const TOKEN_SERIES: readonly ChartSeries[] = [
  { key: 'input', label: 'Token đầu vào (input)', color: seriesColor(0) },
  { key: 'output', label: 'Token đầu ra (output)', color: seriesColor(1) },
];

function TokenUsageCard({ rows, days }: { rows: Stats['tokenUsagePerDay']; days: string[] }) {
  const byDay = new Map(rows.map(row => [row.day, row]));
  const inputTotal = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTotal = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const value = (day: string, key: string) => {
    const row = byDay.get(day);
    if (!row) return 0;
    return key === 'input' ? row.inputTokens : row.outputTokens;
  };

  return (
    <ChartCard
      title="Token usage theo ngày"
      description={inputTotal + outputTotal > 0
        ? `Tổng ${formatNumber(inputTotal)} token đầu vào và ${formatNumber(outputTotal)} token đầu ra.`
        : 'Token AI mà provider báo về, theo ngày.'}
    >
      {inputTotal + outputTotal === 0 ? (
        <EmptyState title="Chưa có token nào được ghi nhận trong khoảng này" />
      ) : (
        <>
          <StackedBarChart label="Biểu đồ token usage theo ngày" days={days} series={TOKEN_SERIES} value={value} />
          <ChartDataTable
            label="Token usage theo ngày"
            columns={['Ngày', 'Đầu vào', 'Đầu ra', 'Tổng']}
            rows={rows.map(row => [formatDay(row.day), formatNumber(row.inputTokens), formatNumber(row.outputTokens), formatNumber(row.totalTokens)])}
          />
        </>
      )}
    </ChartCard>
  );
}
