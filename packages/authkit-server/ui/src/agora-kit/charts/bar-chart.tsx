import { barY } from '@tanstack/charts/bar';
import { group } from '@tanstack/charts/group';
import { Chart } from '@tanstack/charts/react';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { defineChart } from '@tanstack/charts/scene';
import { stack } from '@tanstack/charts/stack';
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
 * Vertical bars per x, on TanStack Charts: one series, several series side by side (`grouped`), or
 * stacked (`stacked`, the first series at the bottom). Hover or focus (Tab, then arrow keys) shows
 * every series at that x in the kit tooltip; a stacked segment reports its own value.
 */
export function BarChart<T>({
  data,
  x,
  series,
  ariaLabel,
  ariaDescription,
  formatValue,
  formatX,
  extraRows,
  layout = 'stacked',
  height = 200,
  empty = 'No data in this window.',
  emptyWhenZero = false,
  integer,
  className,
}: ChartBaseProps<T> & { layout?: 'stacked' | 'grouped' }) {
  const rows = useMemo(() => toChartRows(data, x, series), [data, x, series]);
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(rows, {
            id: 'bars',
            x: 'x',
            y: 'value',
            z: 'series',
            key: 'id',
            fill: (r) => r.color,
            layout: layout === 'grouped' ? group() : stack(),
            radius: layout === 'grouped' || series.length === 1 ? { end: 2 } : 0,
            maxThickness: 28,
          }),
        ],
        scales: {
          x: {
            scale: () => scaleBand<string>().padding(0.2),
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
        // like the line charts: the pointer anywhere over the plot focuses the nearest x
        maxFocusDistance: Number.POSITIVE_INFINITY,
        tooltip: {
          ...chartTooltip<T>({ formatValue, formatX, extraRows }),
          anchor: 'group-center',
        },
      }),
    [rows, layout, integer, series.length, formatValue, formatX, extraRows],
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
