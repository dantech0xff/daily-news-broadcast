/**
 * Source health over time as a heat table: one row per source with its
 * totals and a strip of cells, one per day (or per group of days on long
 * ranges). A cell's color summarizes that period's fetch outcomes; its
 * tooltip has the exact counts, and each strip has a text summary.
 */

import type { Stats } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatDay, formatNumber } from '../../lib/format';

/** At most this many cells per strip; longer ranges group days into one cell. */
const MAX_CELLS = 60;

type SourceHealthRow = Stats['sourceHealthPerDay'][number];

interface Counts {
  healthy: number;
  empty: number;
  failed: number;
  articles: number;
}

interface SourceSummary extends Counts {
  sourceId: string;
  name: string;
  byDay: Map<string, Counts>;
}

type CellKind = 'none' | 'healthy' | 'empty' | 'partial' | 'failed';

const CELL_STYLES: Record<CellKind, { className: string; label: string }> = {
  healthy: { className: 'bg-emerald-500', label: 'Ổn' },
  empty: { className: 'bg-amber-300', label: 'Chỉ trả về rỗng' },
  partial: { className: 'bg-rose-300', label: 'Lỗi một phần' },
  failed: { className: 'bg-rose-600', label: 'Lỗi toàn bộ' },
  none: { className: 'bg-slate-100', label: 'Không có dữ liệu' },
};
const LEGEND_ORDER: readonly CellKind[] = ['healthy', 'empty', 'partial', 'failed', 'none'];

function emptyCounts(): Counts {
  return { healthy: 0, empty: 0, failed: 0, articles: 0 };
}

function add(target: Counts, source: Counts): void {
  target.healthy += source.healthy;
  target.empty += source.empty;
  target.failed += source.failed;
  target.articles += source.articles;
}

function cellKind(counts: Counts): CellKind {
  const runs = counts.healthy + counts.empty + counts.failed;
  if (runs === 0) return 'none';
  if (counts.failed === runs) return 'failed';
  if (counts.failed > 0) return 'partial';
  return counts.healthy === 0 ? 'empty' : 'healthy';
}

/** Sources with their totals, the ones with the most failures first. */
function summarizeSources(rows: readonly SourceHealthRow[]): SourceSummary[] {
  const sources = new Map<string, SourceSummary>();
  for (const row of rows) {
    let source = sources.get(row.sourceId);
    if (!source) {
      source = { sourceId: row.sourceId, name: row.sourceName ?? row.sourceId, byDay: new Map(), ...emptyCounts() };
      sources.set(row.sourceId, source);
    }
    if (row.sourceName) source.name = row.sourceName;
    const counts = { healthy: row.healthy, empty: row.empty, failed: row.failed, articles: row.articles };
    add(source, counts);
    const day = source.byDay.get(row.day) ?? emptyCounts();
    add(day, counts);
    source.byDay.set(row.day, day);
  }
  return [...sources.values()].sort((left, right) => (
    right.failed - left.failed || right.empty - left.empty || left.name.localeCompare(right.name)
  ));
}

export function SourceHealthTable({ rows, days }: { rows: readonly SourceHealthRow[]; days: readonly string[] }) {
  const sources = summarizeSources(rows);
  const groupSize = Math.max(1, Math.ceil(days.length / MAX_CELLS));
  const groups: string[][] = [];
  for (let index = 0; index < days.length; index += groupSize) groups.push(days.slice(index, index + groupSize));
  const first = days[0];
  const last = days[days.length - 1];

  return (
    <>
      <div className="overflow-x-auto">
        <table aria-label="Sức khoẻ từng nguồn theo thời gian" className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2">Nguồn</th>
              <th scope="col" className="px-3 py-2 text-right">Ổn</th>
              <th scope="col" className="px-3 py-2 text-right">Rỗng</th>
              <th scope="col" className="px-3 py-2 text-right">Lỗi</th>
              <th scope="col" className="px-3 py-2 text-right">Bài</th>
              <th scope="col" className="px-3 py-2">
                Theo thời gian ({formatDay(first)} → {formatDay(last)}{groupSize > 1 ? `, mỗi ô ${groupSize} ngày` : ''})
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sources.map(source => (
              <tr key={source.sourceId} className="align-middle">
                <th scope="row" className="max-w-56 px-3 py-2 text-left font-normal">
                  <span className="block truncate font-medium text-slate-800" title={source.name}>{source.name}</span>
                  {source.name !== source.sourceId ? <span className="block truncate font-mono text-xs text-slate-500">{source.sourceId}</span> : null}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(source.healthy)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(source.empty)}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', source.failed > 0 && 'font-semibold text-rose-700')}>{formatNumber(source.failed)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(source.articles)}</td>
                <td className="px-3 py-2">
                  <HealthStrip source={source} days={days} groups={groups} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label="Chú thích màu" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {LEGEND_ORDER.map(kind => (
          <li key={kind} className="flex items-center gap-1.5">
            <span className={cn('h-3 w-2 rounded-[1px]', CELL_STYLES[kind].className)} aria-hidden="true" />
            {CELL_STYLES[kind].label}
          </li>
        ))}
      </ul>
    </>
  );
}

function HealthStrip({ source, days, groups }: { source: SourceSummary; days: readonly string[]; groups: readonly string[][] }) {
  const perDay = days.map(day => cellKind(source.byDay.get(day) ?? emptyCounts()));
  const count = (kind: CellKind) => perDay.filter(entry => entry === kind).length;
  const summary = `${source.name}: ${count('failed') + count('partial')} ngày có lỗi, ${count('empty')} ngày chỉ rỗng, `
    + `${count('healthy')} ngày ổn, ${count('none')} ngày không có dữ liệu`;
  // Short ranges get wider cells; long ones stay within about 600 px.
  const cellWidth = groups.length <= 14 ? 'w-5' : groups.length <= 31 ? 'w-3' : 'w-2';
  return (
    <div role="img" aria-label={summary} className="flex gap-px">
      {groups.map(group => {
        const counts = emptyCounts();
        for (const day of group) {
          const entry = source.byDay.get(day);
          if (entry) add(counts, entry);
        }
        const style = CELL_STYLES[cellKind(counts)];
        const period = group.length > 1 ? `${formatDay(group[0])} – ${formatDay(group[group.length - 1])}` : formatDay(group[0]);
        const title = `${period}: ${style.label} — ${counts.healthy} lần ổn · ${counts.empty} lần rỗng · ${counts.failed} lần lỗi · ${counts.articles} bài`;
        return <span key={group[0]} title={title} className={cn('h-4 shrink-0 rounded-[1px]', cellWidth, style.className)} />;
      })}
    </div>
  );
}
