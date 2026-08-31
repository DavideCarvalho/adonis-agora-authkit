import { type ButtonHTMLAttributes, createElement, type ReactNode } from 'react';
import { type SignOutOptions, useSignOut } from '../hooks/use_sign_out.js';
import { useAuth } from '../use_auth.js';

export interface SignOutButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  children?: ReactNode;
  /** para onde ir após o logout */
  returnTo?: string;
}

/** Botão de logout. Renderiza nada quando não autenticado. */
export function SignOutButton({
  children = 'Sair',
  returnTo,
  className,
  ...rest
}: SignOutButtonProps) {
  const { signOut } = useSignOut();
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return null;
  const opts: SignOutOptions | undefined = returnTo ? { returnTo } : undefined;
  return createElement(
    'button',
    {
      type: 'button',
      className: ['authkit-button', 'authkit-button--ghost', className].filter(Boolean).join(' '),
      onClick: () => signOut(opts),
      ...rest,
    },
    children,
  );
}
