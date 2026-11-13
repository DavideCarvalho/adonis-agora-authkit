import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/**
 * A titled modal with an optional footer of actions (shadcn `Dialog` composition) — the shape of
 * every confirm / edit-and-submit dialog in the consoles.
 */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('gap-4 sm:max-w-xl', className)}>
        <DialogHeader>
          <DialogTitle className="pr-8 text-[15px] font-semibold tracking-tight">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="mono break-all text-[11px]">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div>{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
