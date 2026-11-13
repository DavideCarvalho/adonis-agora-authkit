import type { CSSProperties } from 'react';
import { Panel } from '../agora-kit/blocks/panel';
import { cn } from '../agora-kit/lib/utils';
import { Card } from '../agora-kit/ui/card';
import { Skeleton as KitSkeleton } from '../agora-kit/ui/skeleton';

// Shaped loading placeholders, all on the kit's shadcn `Skeleton`.

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

/** A sized block. Prefer the shaped variants below. */
export function Skeleton({ width, height = 14, borderRadius, className }: SkeletonProps) {
  const style: CSSProperties = {
    width: width ?? '100%',
    height,
    ...(borderRadius !== undefined ? { borderRadius } : {}),
  };
  return <KitSkeleton className={cn('shrink-0', className)} style={style} />;
}

export function SkeletonLines({
  lines = 3,
  lastWidth = '60%',
}: {
  lines?: number;
  lastWidth?: string;
}) {
  return (
    <div className="flex flex-col gap-2 py-2" aria-hidden>
      {Array.from({ length: lines }, (_, i) => `line-${i}`).map((key, i) => (
        <Skeleton key={key} width={i === lines - 1 ? lastWidth : '100%'} height={13} />
      ))}
    </div>
  );
}

/** One metric card placeholder. */
export function SkeletonCard() {
  return (
    <Card
      aria-hidden
      className="agora-surface gap-2.5 rounded-lg border border-border px-[18px] pt-4 pb-3.5 shadow-none ring-0"
    >
      <Skeleton width={80} height={11} />
      <Skeleton width={60} height={26} />
      <Skeleton width={100} height={11} />
    </Card>
  );
}

/** A metric-card row placeholder. */
export function SkeletonCards({ count = 6 }: { count?: number; columns?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
      {Array.from({ length: count }, (_, i) => `card-${i}`).map((key) => (
        <SkeletonCard key={key} />
      ))}
    </div>
  );
}

/** Table rows placeholder (header + rows), for inside a panel. */
export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  const grid = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  return (
    <div className="pb-2" aria-hidden>
      <div className="grid gap-3 border-b border-border px-4 py-2.5" style={grid}>
        {Array.from({ length: cols }, (_, i) => `h-${i}`).map((key) => (
          <Skeleton key={key} height={10} width="50%" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => `r-${r}`).map((rowKey) => (
        <div
          key={rowKey}
          className="grid gap-3 border-b border-border px-4 py-3 last:border-0"
          style={grid}
        >
          {Array.from({ length: cols }, (_, c) => `${rowKey}-${c}`).map((key, c) => (
            <Skeleton
              key={key}
              height={12}
              width={c === 0 ? '80%' : c === cols - 1 ? '40%' : '65%'}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A titled panel with table rows, while a list loads. */
export function SkeletonPanelTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <Panel title={<Skeleton width={160} height={12} />} flush>
      <SkeletonTable rows={rows} cols={cols} />
    </Panel>
  );
}

/** A drawer's detail placeholder: identity row + two sections. */
export function SkeletonDrawerSection() {
  return (
    <div className="flex flex-col gap-5" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton width={44} height={44} borderRadius="50%" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton width="60%" height={14} />
          <Skeleton width="40%" height={11} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton width={80} height={10} />
        <Skeleton height={32} />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton width={80} height={10} />
        <SkeletonLines lines={3} lastWidth="50%" />
      </div>
    </div>
  );
}

/** The whole page while its code chunk loads. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-5 pb-16 md:px-6 md:pt-6" aria-hidden>
      <div className="flex flex-col gap-1.5">
        <Skeleton width={160} height={18} />
        <Skeleton width={240} height={11} />
      </div>
      <SkeletonPanelTable rows={6} cols={4} />
    </div>
  );
}
