import React from 'react';
import type { TooltipContentProps } from 'recharts';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface TrendChartProps {
  data: Array<{ date: string; count: number }>;
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

/**
 * Gráfico de tendência diária (Recharts, estilo shadcn): área com gradiente,
 * grid pontilhado, tooltip com hover — substitui o SparkLine estático.
 */
export function TrendChart({
  data,
  color = 'var(--accent)',
  height = 150,
  label = 'events',
}: TrendChartProps) {
  if (!data || data.length === 0) return <div style={{ height }} />;
  const gid = `tc-${label.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={fmtDay}
          tick={{ fontSize: 10, fill: 'var(--faint)' }}
          axisLine={false}
          tickLine={false}
          minTickGap={42}
        />
        <YAxis hide domain={[0, 'auto']} allowDecimals={false} />
        <Tooltip
          cursor={{ stroke: 'var(--line)', strokeDasharray: '3 3' }}
          content={({ active, payload, label: tipLabel }: TooltipContentProps) =>
            active && payload?.length ? (
              <div className="chart-tip">
                <div className="chart-tip-label">{fmtDay(String(tipLabel))}</div>
                <div className="chart-tip-row">
                  <span className="chart-tip-dot" style={{ background: color }} />
                  {label} <b>{payload[0].value}</b>
                </div>
              </div>
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke={color}
          strokeWidth={1.8}
          fill={`url(#${gid})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
