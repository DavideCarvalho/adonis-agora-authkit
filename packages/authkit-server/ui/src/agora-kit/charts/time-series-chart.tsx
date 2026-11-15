import { areaY } from '@tanstack/charts/area';
import { lineY } from '@tanstack/charts/line';
import { decorative } from '@tanstack/charts/mark/decorative';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { defineChart } from '@tanstack/charts/scene';
import { useMemo } from 'react';
import { cn } from '../lib/utils';
import { ChartEmpty } from './chart-empty';
import {
  CHART_THEME,
  type ChartBaseProps,
  chartTooltip,
  isEmptyChart,
  toChartRows,
  valueTicks,
} from './chart-kit';

/**
 * A time series as a line (or a line over a soft area) per series, on TanStack Charts. Hover or
 * focus (Tab, then arrow keys) shows every series at that x in the kit tooltip.
 */
export function TimeSeriesChart<T>({
  data,
  x,
  series,
  ariaLabel,
  ariaDescription,
  formatValue,
  formatX,
  extraRows,
  variant = 'area',
  height = 200,
  empty = 'No data in this window.',
  emptyWhenZero = false,
  integer,
  className,
}: ChartBaseProps<T> & { variant?: 'area' | 'line' }) {
  const rows = useMemo(() => toChartRows(data, x, series), [data, x, series]);
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          ...(variant === 'area'
            ? [
                decorative(
                  areaY(rows, {
                    id: 'area',
                    x: 'x',
                    y2: 'value',
                    y1: 0,
                    z: 'series',
                    fill: (r) => r.color,
                    fillOpacity: 0.14,
                  }),
                ),
              ]
            : []),
          lineY(rows, {
            id: 'line',
            x: 'x',
            y: 'value',
            z: 'series',
            key: 'id',
            stroke: (r) => r.color,
            strokeWidth: 2,
            // dots only while each day stays distinguishable (per x, however many series)
            points: new Set(rows.map((r) => r.x)).size <= 62,
          }),
        ],
        scales: {
          x: {
            scale: () => scalePoint<string>().padding(0.5),
            axis: {
              line: false,
              ticks: { size: 0, ...(formatX ? { format: formatX } : {}) },
              tickLabels: { thin: { minGap: 16, priority: 'ends' } },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: {
              line: false,
              ticks: valueTicks(rows, integer, formatValue),
            },
          },
        },
        theme: CHART_THEME,
        focus: 'group-x',
        maxFocusDistance: Number.POSITIVE_INFINITY,
        // anchored on the focused x's group, so the box doesn't jump between series
        tooltip: {
          ...chartTooltip<T>({ formatValue, formatX, extraRows }),
          anchor: 'group-center',
        },
      }),
    [rows, variant, integer, formatValue, formatX, extraRows],
  );

  if (isEmptyChart(rows, emptyWhenZero)) return <ChartEmpty height={height}>{empty}</ChartEmpty>;
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
