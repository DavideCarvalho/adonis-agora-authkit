import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card } from '../ui/card';

/**
 * A titled card for a chart, a table or a list (shadcn `Card` composition, authkit `.panel` look):
 * title left, mono meta (`description`) and `action` right. `flush` drops the body padding so a
 * table or list can run edge to edge under the header rule.
 */
export function Panel({
  title,
  description,
  action,
  children,
  flush,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card
      className={cn(
        'agora-surface agora-rise rounded-lg border border-border shadow-none ring-0 gap-0 py-0',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h3 className="text-[12.5px] font-semibold tracking-[0.02em] text-fg">{title}</h3>
        {(description || action) && (
          <div className="flex min-w-0 items-center gap-3">
            {description && (
              <span className="mono truncate text-[10.5px] text-faint">{description}</span>
            )}
            {action}
          </div>
        )}
      </div>
      <div className={cn(flush ? '' : 'px-4 pt-3 pb-4', bodyClassName)}>{children}</div>
    </Card>
  );
}
