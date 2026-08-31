import { type ButtonHTMLAttributes, createElement, type ReactNode } from 'react';
import { type SignInOptions, useSignIn } from '../hooks/use_sign_in.js';
import { useAuth } from '../use_auth.js';

export interface SignInButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  children?: ReactNode;
  /** para onde voltar após o login */
  returnTo?: string;
  /** renderiza mesmo se já autenticado (default: esconde quando autenticado) */
  showWhenAuthenticated?: boolean;
}

/** Botão que inicia o fluxo de login (redirect OIDC). */
export function SignInButton({
  children = 'Entrar',
  returnTo,
  showWhenAuthenticated = false,
  className,
  ...rest
}: SignInButtonProps) {
  const { signIn } = useSignIn();
  const { isAuthenticated } = useAuth();
  if (isAuthenticated && !showWhenAuthenticated) return null;
  const opts: SignInOptions | undefined = returnTo ? { returnTo } : undefined;
  return createElement(
    'button',
    {
      type: 'button',
      className: ['authkit-button', 'authkit-button--primary', className].filter(Boolean).join(' '),
      onClick: () => signIn(opts),
      ...rest,
    },
    children,
  );
}
