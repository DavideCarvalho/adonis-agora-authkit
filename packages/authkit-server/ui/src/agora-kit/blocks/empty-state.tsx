import type { ReactNode } from 'react';
import { InboxIcon } from '../icons';
import { cn } from '../lib/utils';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';

/** A designed empty state (shadcn `Empty` composition): icon, title, one sentence, optional action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn('p-8', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="border border-border bg-panel-2 text-faint">
          {icon ?? <InboxIcon />}
        </EmptyMedia>
        <EmptyTitle className="text-[13px] font-semibold text-fg">{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="text-xs text-faint">{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
