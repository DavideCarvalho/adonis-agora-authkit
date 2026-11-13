import type { ReactNode } from 'react';
import { ActionDialog } from '../agora-kit/blocks/action-dialog';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  large?: boolean;
}

/** A titled dialog with an optional footer (the kit's `ActionDialog`, shadcn Dialog). */
export function Modal({ open, onClose, title, children, footer, large }: ModalProps) {
  return (
    <ActionDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      footer={footer}
      className={large ? 'sm:max-w-3xl' : 'sm:max-w-lg'}
    >
      {children}
    </ActionDialog>
  );
}
