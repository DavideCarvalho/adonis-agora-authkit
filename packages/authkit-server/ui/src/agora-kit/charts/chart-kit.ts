// Shared pieces of the kit's charts (TanStack Charts): the series model, the long rows the marks
// read, the token theme and the tooltip. No React here.
import type {
  ChartPoint,
  ChartTheme,
  ChartTooltipContent,
  ChartTooltipRow,
  ChartValue,
} from '@tanstack/charts';
import { tooltip } from '@tanstack/charts/tooltip';
import { portal } from '@tanstack/charts/tooltip/portal';

/** One plotted series: a stable key, the name shown in the tooltip, and how to read it from a row. */
export interface ChartSeries<T> {
  key: string;
  label: string;
  value: (row: T) => number | null | undefined;
  /** Any CSS colour (`var(--agora-bad)`); defaults to the kit palette by position. */
  color?: string;
}

/** An extra tooltip line under the series values (e.g. "calls 12"). */
export interface ChartExtraRow {
  label: string;
  value: string;
}

/** Props every kit chart shares. */
export interface ChartBaseProps<T> {
  data: readonly T[];
  /** The category of a row: a day (`2026-11-14`), a bucket start, a label. Unique per row. */
  x: (row: T) => string;
  series: readonly ChartSeries<T>[];
  /** Accessible name of the chart (also the SVG's `aria-label`). */
  ariaLabel: string;
  ariaDescription?: string;
  /** Formats a value on the y axis and in the tooltip (cost, count, duration). */
  formatValue?: (value: number) => string;
  /** Formats an x category on the axis and as the tooltip title. */
  formatX?: (x: string) => string;
  /** More tooltip lines for the focused row. */
  extraRows?: (row: T) => readonly ChartExtraRow[];
  height?: number;
  /** Shown instead of the chart when there is no row (or, with `emptyWhenZero`, every value is 0). */
  empty?: string;
  /** Treat an all-zero window as empty. Off by default: zero activity is data (a flat line). */
  emptyWhenZero?: boolean;
  /** Whole-number ticks on the value axis (counts), so it never labels 0.5. */
  integer?: boolean;
  className?: string;
}

/** A plotted value: one per (row, series). `id` is stable across refetches. */
export interface ChartRow<T> {
  id: string;
  x: string;
  series: string;
  value: number;
  color: string;
  row: T;
}

/** The kit palette: the console accent first, then the semantic hues (all token-driven). */
export const SERIES_COLORS = [
  'var(--agora-accent)',
  'var(--agora-info)',
  'var(--agora-good)',
  'var(--agora-warn)',
  'var(--agora-violet)',
  'var(--agora-teal)',
] as const;

export function seriesColor<T>(series: ChartSeries<T>, index: number): string {
  return series.color ?? SERIES_COLORS[index % SERIES_COLORS.length] ?? 'var(--agora-accent)';
}

const plain = (value: number) => value.toLocaleString();
const same = (x: string) => x;

/** Flattens rows × series into the long rows the marks read. A null/undefined value is skipped. */
export function toChartRows<T>(
  data: readonly T[],
  x: (row: T) => string,
  series: readonly ChartSeries<T>[],
): ChartRow<T>[] {
  const out: ChartRow<T>[] = [];
  for (const row of data) {
    const at = x(row);
    series.forEach((s, index) => {
      const value = s.value(row);
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      out.push({
        id: `${at}\u0000${s.key}`,
        x: at,
        series: s.label,
        value,
        color: seriesColor(s, index),
        row,
      });
    });
  }
  return out;
}

/** True when there is nothing to draw: no row, or (`whenZero`) every value is zero. */
export function isEmptyChart<T>(rows: readonly ChartRow<T>[], whenZero = false): boolean {
  return rows.length === 0 || (whenZero && rows.every((r) => r.value === 0));
}

/**
 * Value-axis tick options shared by the cartesian charts. With `integer`, the tick count never
 * exceeds the largest value, so a 0..2 count axis reads 0 · 1 · 2 instead of 0 · 0.5 · 1 · ….
 */
export function valueTicks<T>(
  rows: readonly ChartRow<T>[],
  integer: boolean | undefined,
  format: ((value: number) => string) | undefined,
) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const count = integer ? Math.max(1, Math.min(4, Math.ceil(max))) : 4;
  return { count, size: 0, ...(format ? { format } : {}) };
}

/** Axis/grid paint from the kit tokens, so light and dark follow the theme with no rebuild. */
export const CHART_THEME: Partial<ChartTheme> = {
  foreground: 'var(--agora-muted)',
  muted: 'var(--agora-faint)',
  grid: 'var(--agora-line)',
  background: 'transparent',
  palette: [...SERIES_COLORS],
};

/**
 * The kit tooltip: title = formatted x, one row per focused series (with its swatch), then the
 * caller's extra rows. Opens on hover and on keyboard focus (arrow keys move it); portalled so a
 * card's `overflow: hidden` can't clip it. Styled by `.agora-chart-tooltip` in tokens.css.
 */
export function chartTooltip<
  T,
  D extends ChartRow<T> = ChartRow<T>,
  X extends ChartValue = string,
  Y extends ChartValue = number,
>(opts: {
  formatValue?: ((value: number) => string) | undefined;
  formatX?: ((x: string) => string) | undefined;
  extraRows?: ((row: T) => readonly ChartExtraRow[]) | undefined;
}) {
  const formatValue = opts.formatValue ?? plain;
  const formatX = opts.formatX ?? same;
  return {
    use: tooltip,
    portal,
    className: 'agora-chart-tooltip',
    placement: ['top', 'right', 'left', 'bottom'] as const,
    content: (
      points: readonly ChartPoint<D, X, Y>[],
      context: { primaryPoint?: ChartPoint | undefined },
    ): ChartTooltipContent => {
      const first = points[0]?.datum;
      if (!first) return { rows: [] };
      const many = points.length > 1;
      const rows: ChartTooltipRow[] = points.map((p) => ({
        label: p.datum.series,
        value: formatValue(p.datum.value),
        color: p.datum.color,
        ...(many ? { active: p === context.primaryPoint } : {}),
      }));
      for (const extra of opts.extraRows?.(first.row) ?? []) rows.push({ ...extra });
      return { title: formatX(first.x), rows };
    },
  };
}
