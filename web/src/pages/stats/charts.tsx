/**
 * Small hand-drawn SVG charts. No chart library: nothing injects `<style>`
 * elements or evaluates code at run time (the server CSP allows same-origin
 * scripts and stylesheets only). Colors are Tailwind classes, sizes are SVG
 * presentation attributes. Each chart measures its container so one SVG
 * unit is one CSS pixel (labels keep their size at any width). Every chart is
 * an `img` with a text label, and a data table offers the exact numbers.
 */

import { useCallback, useState, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { formatDay, formatNumber, formatShortDay } from '../../lib/format';

const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 280;
const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 56 } as const;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
/** Horizontal room one x-axis label needs. */
const X_LABEL_SPACING = 64;
const MAX_BAR_WIDTH = 28;
const FONT_SIZE = 11;

export interface SeriesColor {
  fill: string;
  stroke: string;
  swatch: string;
}

const SERIES_COLORS: readonly SeriesColor[] = [
  { fill: 'fill-indigo-500', stroke: 'stroke-indigo-500', swatch: 'bg-indigo-500' },
  { fill: 'fill-sky-400', stroke: 'stroke-sky-400', swatch: 'bg-sky-400' },
  { fill: 'fill-emerald-500', stroke: 'stroke-emerald-500', swatch: 'bg-emerald-500' },
  { fill: 'fill-amber-500', stroke: 'stroke-amber-500', swatch: 'bg-amber-500' },
  { fill: 'fill-rose-500', stroke: 'stroke-rose-500', swatch: 'bg-rose-500' },
  { fill: 'fill-violet-500', stroke: 'stroke-violet-500', swatch: 'bg-violet-500' },
  { fill: 'fill-teal-500', stroke: 'stroke-teal-500', swatch: 'bg-teal-500' },
  { fill: 'fill-orange-500', stroke: 'stroke-orange-500', swatch: 'bg-orange-500' },
];
const FALLBACK_COLOR: SeriesColor = { fill: 'fill-slate-500', stroke: 'stroke-slate-500', swatch: 'bg-slate-500' };

/** Color of the `index`-th series (the palette repeats). */
export function seriesColor(index: number): SeriesColor {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? FALLBACK_COLOR;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: SeriesColor;
}

export interface Scale {
  max: number;
  ticks: number[];
}

/** A y-axis of counts from 0 with about four round integer steps covering `maxValue`. */
export function niceScale(maxValue: number): Scale {
  if (!(maxValue > 0)) return { max: 1, ticks: [0, 1] };
  const rough = maxValue / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = Math.max(1, Math.ceil((residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude));
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index * step <= max + step / 1000; index += 1) ticks.push(index * step);
  return { max, ticks };
}

/** Plot geometry for a chart `width` pixels wide over `dayCount` days. */
interface Frame {
  width: number;
  /** Width of one day's column. */
  slot: number;
  /** Left edge of day `index`'s column. */
  x: (index: number) => number;
  /** Y of `value` on `scale`. */
  y: (value: number, scale: Scale) => number;
}

function makeFrame(width: number, dayCount: number): Frame {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const slot = plotWidth / Math.max(1, dayCount);
  return {
    width,
    slot,
    x: index => MARGIN.left + index * slot,
    y: (value, scale) => MARGIN.top + PLOT_HEIGHT - (Math.min(value, scale.max) / scale.max) * PLOT_HEIGHT,
  };
}

/** Width of the element the ref is attached to, kept current with a ResizeObserver. */
function useMeasuredWidth(): [(node: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    const apply = (value: number) => {
      // Zero while detached or hidden (and always in jsdom): keep the last width.
      if (value > 0) setWidth(Math.max(MIN_WIDTH, Math.floor(value)));
    };
    apply(node.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(entries => apply(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function ChartSvg({ label, dayCount, children }: { label: string; dayCount: number; children: (frame: Frame) => ReactNode }) {
  const [ref, width] = useMeasuredWidth();
  const frame = makeFrame(width, dayCount);
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} className="block h-auto max-w-full">
        {children(frame)}
      </svg>
    </div>
  );
}

function Axes({ days, frame, scale, formatTick }: { days: readonly string[]; frame: Frame; scale: Scale; formatTick: (value: number) => string }) {
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((frame.width - MARGIN.left) / X_LABEL_SPACING))));
  return (
    <g aria-hidden="true">
      {scale.ticks.map(tick => (
        <g key={tick}>
          <line x1={MARGIN.left} x2={frame.width - MARGIN.right} y1={frame.y(tick, scale)} y2={frame.y(tick, scale)} className="stroke-slate-200" strokeWidth={1} />
          <text x={MARGIN.left - 8} y={frame.y(tick, scale)} dy="0.32em" textAnchor="end" fontSize={FONT_SIZE} className="fill-slate-500">
            {formatTick(tick)}
          </text>
        </g>
      ))}
      {days.map((day, index) => (index % every === 0 ? (
        <text key={day} x={frame.x(index) + frame.slot / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={FONT_SIZE} className="fill-slate-500">
          {formatShortDay(day)}
        </text>
      ) : null))}
    </g>
  );
}

/** Stacked bars per day; `value(day, key)` must be ≥ 0. */
export function StackedBarChart({ label, days, series, value, formatValue = formatNumber }: {
  label: string;
  days: readonly string[];
  series: readonly ChartSeries[];
  value: (day: string, seriesKey: string) => number;
  formatValue?: (value: number) => string;
}) {
  const totals = days.map(day => series.reduce((sum, entry) => sum + Math.max(0, value(day, entry.key)), 0));
  const scale = niceScale(Math.max(0, ...totals));

  return (
    <figure>
      <ChartSvg label={label} dayCount={days.length}>
        {frame => {
          const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, frame.slot * 0.7));
          return (
            <>
              <Axes days={days} frame={frame} scale={scale} formatTick={formatValue} />
              {days.map((day, index) => {
                const x = frame.x(index);
                let stacked = 0;
                const tooltip = [
                  `${formatDay(day)} — tổng ${formatValue(totals[index] ?? 0)}`,
                  ...series.map(entry => `${entry.label}: ${formatValue(Math.max(0, value(day, entry.key)))}`),
                ].join('\n');
                return (
                  <g key={day}>
                    <title>{tooltip}</title>
                    <rect x={x} y={MARGIN.top} width={frame.slot} height={PLOT_HEIGHT} className="fill-transparent" />
                    {series.map(entry => {
                      const amount = Math.max(0, value(day, entry.key));
                      if (amount === 0) return null;
                      const bottom = frame.y(stacked, scale);
                      stacked += amount;
                      const top = frame.y(stacked, scale);
                      return (
                        <rect
                          key={entry.key}
                          x={x + (frame.slot - barWidth) / 2}
                          y={top}
                          width={barWidth}
                          height={Math.max(0.5, bottom - top)}
                          className={entry.color.fill}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </>
          );
        }}
      </ChartSvg>
      <ChartLegend series={series} />
    </figure>
  );
}

/** Lines per series over days; `null` values leave a gap. `max` fixes the y-axis (e.g. 1 for ratios). */
export function LineChart({ label, days, series, value, max, formatValue, describePoint }: {
  label: string;
  days: readonly string[];
  series: readonly ChartSeries[];
  value: (day: string, seriesKey: string) => number | null;
  max: number;
  formatValue: (value: number) => string;
  describePoint: (day: string, seriesKey: string) => string;
}) {
  const scale: Scale = { max, ticks: [0, 0.25, 0.5, 0.75, 1].map(fraction => fraction * max) };

  return (
    <figure>
      <ChartSvg label={label} dayCount={days.length}>
        {frame => (
          <>
            <Axes days={days} frame={frame} scale={scale} formatTick={formatValue} />
            {series.map(entry => {
              let path = '';
              let drawing = false;
              const points: ReactNode[] = [];
              days.forEach((day, index) => {
                const amount = value(day, entry.key);
                if (amount === null) {
                  drawing = false;
                  return;
                }
                const x = frame.x(index) + frame.slot / 2;
                const y = frame.y(amount, scale);
                path += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
                drawing = true;
                points.push(
                  <circle key={day} cx={x} cy={y} r={3.5} className={cn(entry.color.fill, 'stroke-white')} strokeWidth={1}>
                    <title>{describePoint(day, entry.key)}</title>
                  </circle>,
                );
              });
              return (
                <g key={entry.key}>
                  {path ? <path d={path} className={cn(entry.color.stroke, 'fill-none')} strokeWidth={2} strokeLinejoin="round" /> : null}
                  {points}
                </g>
              );
            })}
          </>
        )}
      </ChartSvg>
      <ChartLegend series={series} />
    </figure>
  );
}

export function ChartLegend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul aria-label="Chú thích" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {series.map(entry => (
        <li key={entry.key} className="flex items-center gap-1.5">
          <span className={cn('size-2.5 shrink-0 rounded-sm', entry.color.swatch)} aria-hidden="true" />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/** The exact numbers behind a chart, collapsed by default. */
export function ChartDataTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly (readonly string[])[] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-medium text-indigo-700">Xem dạng bảng</summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200">
        <table aria-label={label} className="min-w-full divide-y divide-slate-200">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold text-slate-500">
            <tr>{columns.map(column => <th key={column} scope="col" className="px-3 py-2">{column}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(row => (
              <tr key={row[0]}>
                {row.map((cell, index) => (index === 0
                  ? <th key={columns[index]} scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap">{cell}</th>
                  : <td key={columns[index]} className="px-3 py-1.5 whitespace-nowrap">{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
