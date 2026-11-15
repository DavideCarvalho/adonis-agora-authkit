import { areaY } from '@tanstack/charts/area';
import { lineY } from '@tanstack/charts/line';
import { decorative } from '@tanstack/charts/mark/decorative';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { defineChart } from '@tanstack/charts/scene';
import { useMemo } from 'react';
import { cn } from '../lib/utils';
import {
  CHART_THEME,
  type ChartExtraRow,
  type ChartSeries,
  chartTooltip,
  toChartRows,
} from './chart-kit';

/**
 * A small line-over-area trend with no axes, on TanStack Charts. Hover or focus (Tab, then arrow
 * keys) shows the value at that point in the kit tooltip. An empty series draws a flat baseline.
 */
export function Sparkline<T>({
  data,
  x,
  value,
  label,
  ariaLabel,
  ariaDescription,
  formatValue,
  formatX,
  extraRows,
  color = 'var(--agora-accent-ink)',
  height = 40,
  className,
}: {
  data: readonly T[];
  /** The category of a row (bucket start, day). Unique per row. */
  x: (row: T) => string;
  value: (row: T) => number | null | undefined;
  /** The series name in the tooltip ("requests"). */
  label: string;
  ariaLabel: string;
  ariaDescription?: string;
  formatValue?: (value: number) => string;
  formatX?: (x: string) => string;
  extraRows?: (row: T) => readonly ChartExtraRow[];
  color?: string;
  height?: number;
  className?: string;
}) {
  const series = useMemo<ChartSeries<T>[]>(
    () => [{ key: 'value', label, value, color }],
    [label, value, color],
  );
  const rows = useMemo(() => toChartRows(data, x, series), [data, x, series]);
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          decorative(
            areaY(rows, { id: 'area', x: 'x', y2: 'value', y1: 0, fill: color, fillOpacity: 0.14 }),
          ),
          lineY(rows, {
            id: 'line',
            x: 'x',
            y: 'value',
            key: 'id',
            stroke: color,
            strokeWidth: 1.5,
          }),
        ],
        scales: {
          x: { scale: scalePoint<string> },
          // a flat-zero series sits on the baseline instead of mid-height
          y: {
            scale: () =>
              scaleLinear().domain([
                Math.min(0, ...rows.map((r) => r.value)),
                Math.max(1, ...rows.map((r) => r.value)),
              ]),
          },
        },
        guides: false,
        margin: 2,
        theme: CHART_THEME,
        focus: 'nearest-x',
        maxFocusDistance: Number.POSITIVE_INFINITY,
        tooltip: chartTooltip<T>({ formatValue, formatX, extraRows }),
      }),
    [rows, color, formatValue, formatX, extraRows],
  );

  if (rows.length === 0) {
    return (
      <div
        className={cn('flex items-end', className)}
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
      >
        <div className="h-px w-full bg-line-strong" />
      </div>
    );
  }
  return (
    <Chart
      definition={definition}
      height={height}
      ariaLabel={ariaLabel}
      {...(ariaDescription ? { ariaDescription } : {})}
      className={cn('agora-chart', className)}
    />
  );
}
