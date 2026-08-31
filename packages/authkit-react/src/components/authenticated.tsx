import { createElement, Fragment, type ReactNode } from 'react';
import { useAuth } from '../use_auth.js';

export interface AuthenticatedProps {
  children: ReactNode;
  /** renderizado quando o usuário NÃO está autenticado */
  fallback?: ReactNode;
}

/** Renderiza `children` apenas quando há usuário autenticado. */
export function Authenticated({ children, fallback = null }: AuthenticatedProps) {
  const { isAuthenticated } = useAuth();
  return createElement(Fragment, null, isAuthenticated ? children : fallback);
}

export interface GuestProps {
  children: ReactNode;
  /** renderizado quando o usuário ESTÁ autenticado */
  fallback?: ReactNode;
}

/** Renderiza `children` apenas quando NÃO há usuário autenticado. */
export function Guest({ children, fallback = null }: GuestProps) {
  const { isAuthenticated } = useAuth();
  return createElement(Fragment, null, isAuthenticated ? fallback : children);
}
