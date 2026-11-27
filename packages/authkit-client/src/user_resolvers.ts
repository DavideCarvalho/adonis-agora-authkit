import type { Identity } from '@adonis-agora/authkit-core';

/**
 * Contexto opcional passado como 2º argumento de `resolveUser`.
 * Extensão backward-compatible: callbacks `(identity) => ...` ignoram este arg.
 */
export interface ResolveUserContext {
  accessToken?: string;
}

/**
 * Usuário derivado puramente das claims do ID token (caminho claims-only).
 * Útil em topologia de bancos separados, onde o ID token é "gordo".
 */
export interface ClaimsUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  globalRoles: string[];
}

/**
 * Converte uma `Identity` (claims OIDC validadas) num objeto de usuário simples.
 * Use em `resolveUser: async (identity) => identityToUser(identity)` (`resolveUser` devolve uma promise).
 */
export function identityToUser(identity: Identity): ClaimsUser {
  return {
    id: identity.userId,
    email: identity.email,
    name: identity.profile?.name,
    avatarUrl: identity.profile?.avatarUrl,
    globalRoles: identity.globalRoles,
  };
}

export interface UserinfoResolverOptions {
  /** endpoint userinfo explícito; tem precedência sobre `issuer` */
  userinfoEndpoint?: string;
  /** issuer do IdP; default do endpoint = `${issuer}/me` (oidc-provider) */
  issuer?: string;
  /** implementação de fetch (default: global fetch) */
  fetchImpl?: typeof fetch;
}

/**
 * Fábrica de um `resolveUser` que busca o usuário no endpoint userinfo do IdP
 * usando o access token. Caminho recomendado quando o app precisa de dados
 * além do que o token carrega (topologia de bancos separados).
 *
 * Sem access token (ex.: tokenSource bearer só com ID token), faz fallback
 * para `identityToUser(identity)`.
 */
export function createUserinfoResolver(options: UserinfoResolverOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint =
    options.userinfoEndpoint ??
    (options.issuer ? `${options.issuer.replace(/\/$/, '')}/me` : undefined);

  return async function resolveUser(
    identity: Identity,
    context: ResolveUserContext = {},
  ): Promise<unknown> {
    const accessToken = context.accessToken;
    if (!accessToken || !endpoint) {
      return identityToUser(identity);
    }

    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`userinfo falhou: HTTP ${res.status}`);
    }

    const claims = (await res.json()) as Record<string, unknown>;
    // mescla identity (base) com o que veio do userinfo (sobrescreve)
    return { ...identityToUser(identity), ...claims };
  };
}
