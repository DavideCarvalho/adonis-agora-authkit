import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

export type MetricTone = 'default' | 'brand' | 'good' | 'warn' | 'bad' | 'info' | 'violet';

const TONE: Record<MetricTone, string> = {
  default: 'text-fg',
  brand: 'text-brand',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  violet: 'text-violet',
};

/** One metric: CAPS label, big coloured number, mono caption (shadcn `Card` composition). */
export function MetricCard({
  label,
  value,
  caption,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  caption?: ReactNode;
  tone?: MetricTone;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        'agora-surface agora-rise rounded-lg border border-border shadow-none ring-0 gap-0 px-[18px] pt-4 pb-3.5',
        className,
      )}
    >
      <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      <div
        className={cn(
          'mono tnum text-[26px] font-semibold leading-none tracking-[-0.02em]',
          TONE[tone],
        )}
      >
        {value}
      </div>
      {caption && <div className="mono mt-2 truncate text-[10.5px] text-faint">{caption}</div>}
    </Card>
  );
}

/** A responsive row of metric cards. */
export function MetricGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Stand-in for a {@link MetricGrid} while its data loads. */
export function MetricGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <MetricGrid>
      {Array.from({ length: count }, (_, i) => `metric-skeleton-${i}`).map((key) => (
        <Card
          key={key}
          className="agora-surface agora-rise rounded-lg border border-border shadow-none ring-0 gap-2.5 px-[18px] pt-4 pb-3.5"
          aria-hidden
        >
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-12" />
          <Skeleton className="h-2.5 w-28" />
        </Card>
      ))}
    </MetricGrid>
  );
}
