import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/**
 * A one-line tooltip (shadcn `Tooltip` composition) for the common case: a trigger element and a
 * plain-text label. `suppressed` keeps it closed (e.g. while the same trigger's popover is open).
 * Needs a `TooltipProvider` above it (AppShell provides one).
 */
export function Hint({
  label,
  children,
  side = 'bottom',
  align = 'center',
  suppressed,
}: {
  label: string;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  suppressed?: boolean;
}) {
  return (
    <Tooltip disabled={suppressed ?? false}>
      <TooltipTrigger render={children} />
      <TooltipContent
        side={side}
        align={align}
        className="max-w-[300px] whitespace-pre-line text-left"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
