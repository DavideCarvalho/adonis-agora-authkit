// Vendored from shadcn/ui, registry style "base-vega" (Base UI flavour), item "separator".
// Fetched 2026-11-13 from https://ui.shadcn.com/r/styles/base-vega/separator.json. Local edits are marked "agora:".
'use client';

import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';
import { cn } from '../lib/utils';

function Separator({ className, orientation = 'horizontal', ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
