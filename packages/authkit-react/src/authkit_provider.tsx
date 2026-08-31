import { createElement, type ReactNode } from 'react';
import { type AuthkitConfig, AuthkitConfigContext, resolveConfig } from './config.js';
import { AuthContext } from './provider.js';
import type { AuthSharedProps } from './types.js';

export interface AuthkitProviderProps {
  /** config de URLs/endpoints; defaults apontam para as rotas do host-kit */
  config?: AuthkitConfig;
  /**
   * valor de auth opcional. Se omitido, `useAuth()` lê da shared-prop
   * `authkit` do Inertia (`usePage().props.authkit`).
   */
  value?: AuthSharedProps['authkit'];
  children: ReactNode;
}

/**
 * Provider de nível superior do AuthKit React. Fornece a configuração
 * (URLs/endpoints) para os hooks e componentes prontos e, opcionalmente,
 * injeta o estado de auth (caso não use as shared props do Inertia).
 *
 * ```tsx
 * <AuthkitProvider config={{ loginUrl: '/login', endpoints: { apps: '/api/apps' } }}>
 *   <App />
 * </AuthkitProvider>
 * ```
 */
export function AuthkitProvider({ config, value, children }: AuthkitProviderProps) {
  const resolved = resolveConfig(config);
  const tree = createElement(AuthkitConfigContext.Provider, { value: resolved }, children);
  if (value !== undefined) {
    return createElement(AuthContext.Provider, { value }, tree);
  }
  return tree;
}
