import type { ReactNode } from 'react';

/** The chart-sized empty state: same height as the chart, so the card doesn't jump. */
export function ChartEmpty({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div
      data-slot="chart-empty"
      className="grid place-items-center rounded-md border border-dashed border-border text-xs text-faint"
      style={{ height }}
    >
      {children}
    </div>
  );
}
