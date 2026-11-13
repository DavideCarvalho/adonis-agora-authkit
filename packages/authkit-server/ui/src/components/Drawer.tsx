import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../agora-kit/ui/sheet';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** The right-hand detail panel (shadcn `Sheet`): full width on phones, 520px from `sm`. */
export function Drawer({ open, onClose, title, children }: DrawerProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 border-border bg-panel shadow-(--agora-shadow) data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]"
      >
        <SheetHeader className="border-b border-border px-5 py-4 pr-14">
          <SheetTitle className="truncate text-sm font-semibold text-fg">{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
