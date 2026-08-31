import { createElement, Fragment, type ReactNode } from 'react';
import { useCan } from '../hooks/use_can.js';

export interface CanPermissionProps {
  children: ReactNode;
  /** permissão da Authz a verificar (ex.: `posts.update`) */
  permission: string;
  /** recurso opcional sobre o qual a permissão é avaliada */
  resource?: string;
  /** renderizado enquanto a checagem está em voo. Default: `null` */
  loadingFallback?: ReactNode;
  /** renderizado quando a permissão é negada. Default: `null` */
  fallback?: ReactNode;
}

/**
 * Renderiza `children` somente se a Authz autorizar `permission` sobre
 * `resource`. Diferente de `<Can>` de `@adonis-agora/authz-react` (que gateia
 * em papéis/permissões via o serviço Authz), este gateia em permissões de DB
 * da Authz via `POST <canPath>`.
 *
 * Enquanto carrega, renderiza `loadingFallback` (default `null`).
 */
export function CanPermission({
  children,
  permission,
  resource,
  loadingFallback = null,
  fallback = null,
}: CanPermissionProps) {
  const { allowed, loading } = useCan(permission, resource);
  const out = loading ? loadingFallback : allowed ? children : fallback;
  return createElement(Fragment, null, out);
}
