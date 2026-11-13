// Vendored from shadcn/ui, registry style "base-vega" (Base UI flavour), item "skeleton".
// Fetched 2026-11-13 from https://ui.shadcn.com/r/styles/base-vega/skeleton.json. Local edits are marked "agora:".
import { cn } from '../lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
