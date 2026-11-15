import { useMemo } from 'react';
import { TimeSeriesChart } from '../agora-kit/charts/time-series-chart';

interface TrendPoint {
  date: string;
  count: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  color?: string;
  height?: number;
  /** Rótulo da série no tooltip (ex.: "sign-ins"). */
  label?: string;
}

const fmtDay = (date: string) => {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const fmtCount = (n: number) => n.toLocaleString();
const pointDate = (p: TrendPoint) => p.date;

/**
 * Gráfico de tendência diária (área do kit, TanStack Charts): hover ou foco de teclado num dia
 * mostra a contagem no tooltip do kit.
 */
export function TrendChart({
  data,
  color = 'var(--agora-accent)',
  height = 150,
  label = 'events',
}: TrendChartProps) {
  const series = useMemo(
    () => [{ key: 'count', label, value: (p: TrendPoint) => p.count, color }],
    [label, color],
  );
  return (
    <TimeSeriesChart
      data={data}
      x={pointDate}
      series={series}
      formatX={fmtDay}
      formatValue={fmtCount}
      integer
      ariaLabel={`${label} per day`}
      height={height}
    />
  );
}
