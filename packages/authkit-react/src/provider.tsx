import { createContext, createElement, type ReactNode } from 'react';
import type { AuthSharedProps } from './types.js';

/**
 * Contexto opcional para fornecer o valor do authkit fora do Inertia
 * (ex.: testes, Storybook, ou apps que não usam shared props).
 *
 * Quando ausente (default), `useAuth()` lê de `usePage().props.authkit`.
 * Quando presente, o valor do provider tem precedência.
 */
export const AuthContext = createContext<AuthSharedProps['authkit'] | undefined>(undefined);

export interface AuthProviderProps {
  value: AuthSharedProps['authkit'];
  children: ReactNode;
}

/**
 * Provider opcional. Útil quando o host quer injetar o estado de auth
 * manualmente em vez de depender das shared props do Inertia.
 */
export function AuthProvider({ value, children }: AuthProviderProps) {
  return createElement(AuthContext.Provider, { value }, children);
}
