import { pie, polar, radialArc } from '@tanstack/charts/polar';
import { Chart } from '@tanstack/charts/react';
import { defineChart } from '@tanstack/charts/scene';
import { type ReactNode, useMemo } from 'react';
import { cn } from '../lib/utils';
import { ChartEmpty } from './chart-empty';
import {
  CHART_THEME,
  type ChartExtraRow,
  type ChartRow,
  chartTooltip,
  SERIES_COLORS,
} from './chart-kit';

const percent = (fraction: number) => `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;

/**
 * A donut (pie with a hole) on TanStack Charts, one slice per row in row order, starting at 12
 * o'clock. Hover or focus a slice (Tab, then arrow keys) for its name, formatted value and share in
 * the kit tooltip. `centerLabel` / `centerSub` sit in the hole. Pair it with a legend that lists the
 * exact values: the tooltip is supplemental. No row, or a zero total, renders the empty state.
 */
export function DonutChart<T>({
  data,
  label,
  rowKey,
  value,
  color,
  valueLabel = 'value',
  formatValue,
  extraRows,
  ariaLabel,
  ariaDescription,
  centerLabel,
  centerSub,
  size = 168,
  thickness = 20,
  empty = 'No data in this window.',
  className,
}: {
  data: readonly T[];
  /** The slice name (tooltip title). */
  label: (row: T) => string;
  /** Stable slice identity when names can repeat (e.g. a model id); defaults to `label`. */
  rowKey?: (row: T) => string;
  /** The slice size; negative and missing values count as zero. */
  value: (row: T) => number | null | undefined;
  /**
   * Any CSS colour; defaults to the kit palette by row position. `index` is the row's position in
   * `data` (dropped zero rows included), so a legend coloured over the same `data` matches.
   */
  color?: (row: T, index: number) => string;
  /** What the value is, as the tooltip row label ("cost", "runs"). */
  valueLabel?: string;
  formatValue?: (value: number) => string;
  /** More tooltip lines for the focused slice (after the value and its share). */
  extraRows?: (row: T) => readonly ChartExtraRow[];
  ariaLabel: string;
  ariaDescription?: string;
  centerLabel?: ReactNode;
  centerSub?: ReactNode;
  size?: number;
  /** Ring thickness in pixels. */
  thickness?: number;
  empty?: string;
  className?: string;
}) {
  const rows = useMemo(() => {
    const out: ChartRow<T>[] = [];
    data.forEach((row, index) => {
      const v = value(row);
      if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return;
      const name = label(row);
      out.push({
        // unique even when two rows share a name (the arc joins on this key)
        id: rowKey?.(row) ?? `${name}\u0000${index}`,
        x: name,
        series: valueLabel,
        value: v,
        color: color?.(row, index) ?? SERIES_COLORS[index % SERIES_COLORS.length] ?? '',
        row,
      });
    });
    return out;
  }, [data, label, rowKey, value, color, valueLabel]);
  const total = rows.reduce((sum, r) => sum + r.value, 0);

  const definition = useMemo(() => {
    const slices = pie(rows, { value: 'value' });
    const shareOf = new Map(rows.map((r) => [r.row, total > 0 ? r.value / total : 0]));
    const withShare = (row: T): ChartExtraRow[] => [
      { label: 'share', value: percent(shareOf.get(row) ?? 0) },
      ...(extraRows?.(row) ?? []),
    ];
    return defineChart({
      marks: [
        polar({
          inset: 2,
          marks: [
            radialArc(slices, {
              key: 'id',
              innerRadius: ({ radius }) => Math.max(0, radius - thickness),
              fill: (s) => s.color,
              stroke: 'var(--agora-panel)',
              strokeWidth: 1,
            }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      guides: false,
      margin: 0,
      theme: CHART_THEME,
      tooltip: chartTooltip<T, (typeof slices)[number], number, number>({
        formatValue,
        extraRows: withShare,
      }),
    });
  }, [rows, total, thickness, formatValue, extraRows]);

  if (rows.length === 0 || total <= 0) return <ChartEmpty height={size}>{empty}</ChartEmpty>;
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <Chart
        definition={definition}
        width={size}
        height={size}
        ariaLabel={ariaLabel}
        {...(ariaDescription ? { ariaDescription } : {})}
        className="agora-chart"
      />
      {(centerLabel || centerSub) && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 grid place-content-center text-center"
        >
          {centerLabel && (
            <span className="mono tnum text-[18px] font-semibold leading-tight text-fg">
              {centerLabel}
            </span>
          )}
          {centerSub && <span className="mono text-[10px] text-muted-foreground">{centerSub}</span>}
        </div>
      )}
    </div>
  );
}
