import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** The page's own title block: title, one-line subtitle, actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-lg font-bold tracking-[0.01em] text-fg">{title}</h1>
        {description && <p className="mt-1 text-xs text-faint">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A row of filters / chips / actions above a list. Wraps on narrow screens. */
export function Toolbar({
  children,
  className,
  label = 'toolbar',
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {children}
    </div>
  );
}
