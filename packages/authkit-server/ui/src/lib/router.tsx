import {
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
  useQueryStates,
} from 'nuqs';
import { useCallback } from 'react';

export const ROUTES = [
  'overview',
  'users',
  'sessions',
  'clients',
  'roles',
  'orgs',
  'audit',
  'keys',
  'agents',
  'settings',
] as const;

export type Route = (typeof ROUTES)[number];

/**
 * Roteamento e estado de rota do console via nuqs (query params na URL).
 *
 * - `view` controla a página atual (omitido quando `overview`, o default).
 * - Ao navegar, limpamos os filtros compartilhados (page/q/user/org/type) para
 *   que o estado de uma página não vaze para outra — todas as páginas montam no
 *   mesmo querystring, uma de cada vez.
 *
 * O adapter é o `NuqsAdapter` de `nuqs/adapters/react` (SPA sem framework),
 * montado em `main.tsx`.
 */
export function useRouter() {
  const [route, setView] = useQueryState(
    'view',
    parseAsStringLiteral(ROUTES).withDefault('overview'),
  );

  // Filtros compartilhados entre páginas — declarados aqui só para poder
  // limpá-los numa transição de rota. Cada página continua dona dos seus.
  const [, clearFilters] = useQueryStates({
    page: parseAsInteger,
    q: parseAsString,
    user: parseAsString,
    org: parseAsString,
    type: parseAsString,
  });

  const navigate = useCallback(
    (r: Route) => {
      void setView(r === 'overview' ? null : r);
      void clearFilters({ page: null, q: null, user: null, org: null, type: null });
    },
    [setView, clearFilters],
  );

  return { route, navigate };
}
