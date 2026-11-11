import { usePage } from '@inertiajs/react';
import { useContext, useEffect, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import { AuthContext } from '../provider.js';
import type { AuthSharedProps } from '../types.js';
import { jsonRequest } from './use_resource.js';

/** Resultado do hook `useCan`. */
export interface UseCanResult {
  /** `true` se a Authz autorizou a permissão sobre o recurso. */
  allowed: boolean;
  /** `true` enquanto a checagem está em voo. */
  loading: boolean;
  /**
   * Erro da última checagem, se a requisição falhou. Permanece `null` em
   * caso de negação legítima (`allowed:false`). A decisão continua *fail-closed*:
   * `allowed` é `false` quando há erro.
   */
  error?: Error;
}

/** Resposta do contrato fixo `POST <canPath>` -> `{ allowed }`. */
interface CanResponse {
  allowed: boolean;
}

/**
 * Sentinela usada como discriminador de principal quando não há usuário
 * autenticado (logout). Garante que respostas resolvidas para um usuário
 * não vazem para a sessão anônima e vice-versa.
 */
const ANON_PRINCIPAL = 'anon';

/**
 * Lê o id do principal atual sem lançar fora do Inertia.
 *
 * Espelha a precedência de `useAuth()` (contexto `<AuthProvider>` vence a
 * shared-prop do Inertia), mas — ao contrário de `useAuth()` — não propaga o
 * throw de `usePage()` quando não há contexto Inertia, mantendo `useCan`
 * testável via SSR puro com `<AuthProvider>`. Devolve {@link ANON_PRINCIPAL}
 * quando deslogado.
 */
function usePrincipalId(): string {
  const fromContext = useContext(AuthContext);
  let fromPage: AuthSharedProps['authkit'] | undefined;
  try {
    fromPage = usePage<AuthSharedProps>().props?.authkit;
  } catch {
    // Fora do contexto Inertia (testes SSR puros): cai no contexto/anon.
    fromPage = undefined;
  }
  return (fromContext ?? fromPage)?.user?.id ?? ANON_PRINCIPAL;
}

/**
 * Chave de cache estável por (principal, path, permission, resource).
 *
 * O `principal` (id do usuário atual ou {@link ANON_PRINCIPAL}) é dobrado na
 * chave de propósito: quando o principal muda (logout / troca de usuário /
 * troca de org reflete num novo `user.id`), a chave naturalmente difere e a
 * resposta antiga deixa de ser servida — sem nenhum `clear()` explícito
 * pendurado nos fluxos de sign-out/switch.
 */
function cacheKey(path: string, principal: string, permission: string, resource?: string): string {
  return [principal, path, permission, resource ?? ''].join('|');
}

/**
 * Cache/dedupe em memória, por processo, das checagens de permissão.
 * - `resolved`: respostas já obtidas (`allowed`), chaveadas por principal.
 * - `inflight`: promessas em voo para deduplicar requests concorrentes.
 *
 * A invalidação por mudança de principal é estrutural (sai da chave). O
 * `clear()` público continua disponível como escape hatch (ex.: testes ou
 * forçar refetch global).
 */
export const canCache = {
  resolved: new Map<string, boolean>(),
  inflight: new Map<string, Promise<boolean>>(),
  /** Limpa todas as respostas/promessas memoizadas. */
  clear() {
    this.resolved.clear();
    this.inflight.clear();
  },
};

/**
 * Invalida o cache de permissões. Útil para forçar refetch após uma mudança
 * de estado que o discriminador de principal não captura (ex.: alteração de
 * papéis do mesmo usuário sem novo `user.id`).
 */
export function invalidateCanCache(): void {
  canCache.clear();
}

/**
 * Consulta o endpoint da Authz `POST <path>` com `{ permission, resource? }`
 * (credenciais/cookies incluídos) e devolve `allowed`. Deduplica requests
 * concorrentes e memoiza o resultado por (principal, path, permission, resource).
 *
 * O `principal` (default {@link ANON_PRINCIPAL}) discrimina o cache por
 * usuário, evitando que uma decisão sobreviva à sessão que a autorizou.
 *
 * Pura quanto a React (sem hooks): testável diretamente com um `fetch` mockado.
 */
export async function checkCan(
  path: string,
  permission: string,
  resource?: string,
  csrfToken?: string,
  principal: string = ANON_PRINCIPAL,
): Promise<boolean> {
  const key = cacheKey(path, principal, permission, resource);
  const cached = canCache.resolved.get(key);
  if (cached !== undefined) return cached;
  const pending = canCache.inflight.get(key);
  if (pending) return pending;

  const promise = jsonRequest<CanResponse>(path, {
    method: 'POST',
    csrfToken,
    body: JSON.stringify({ permission, ...(resource ? { resource } : {}) }),
  })
    .then((res) => {
      const allowed = res?.allowed === true;
      canCache.resolved.set(key, allowed);
      return allowed;
    })
    .finally(() => {
      canCache.inflight.delete(key);
    });

  canCache.inflight.set(key, promise);
  return promise;
}

/**
 * Gateia em uma permissão de DB da Authz (não em papéis globais — para esses
 * use `hasGlobalRole`/`useAuth`, ou `<Can>` de `@adonis-agora/authz-react`).
 * Consulta `POST <canPath>` (default `/authz/can`,
 * configurável via `AuthkitProvider`) e devolve `{ allowed, loading, error? }`,
 * com cache/dedupe em memória por (principal, permission, resource).
 *
 * O cache é discriminado pelo usuário atual (`useAuth().user?.id`, ou
 * {@link ANON_PRINCIPAL} quando deslogado): após logout / troca de usuário /
 * troca de org, a chave muda e a permissão é re-buscada em vez de servir a
 * resposta da sessão anterior.
 */
export function useCan(permission: string, resource?: string): UseCanResult {
  const config = useAuthkitConfig();
  const principal = usePrincipalId();
  const path = config.endpoints.can;
  const key = cacheKey(path, principal, permission, resource);

  const [state, setState] = useState<UseCanResult>(() => {
    const cached = canCache.resolved.get(key);
    return cached !== undefined
      ? { allowed: cached, loading: false }
      : { allowed: false, loading: true };
  });

  useEffect(() => {
    let cancelled = false;
    const hit = canCache.resolved.get(key);
    if (hit !== undefined) {
      // Evita um segundo render redundante quando o initializer do
      // `useState` já casou com este mesmo cache quente.
      setState((s) =>
        !s.loading && s.allowed === hit && s.error === undefined
          ? s
          : { allowed: hit, loading: false },
      );
      return;
    }
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    checkCan(path, permission, resource, config.csrfToken, principal)
      .then((allowed) => {
        if (!cancelled) setState({ allowed, loading: false });
      })
      .catch((err) => {
        // Fail-closed: nega, mas expõe o erro no canal `error`.
        if (!cancelled) setState({ allowed: false, loading: false, error: err as Error });
      });
    return () => {
      cancelled = true;
    };
  }, [key, path, permission, resource, config.csrfToken, principal]);

  return state;
}
