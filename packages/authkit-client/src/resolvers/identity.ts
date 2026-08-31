import type { Identity } from '@adonis-agora/authkit-core';
import { deriveOrgId, deriveOrgRole, deriveOrgSlug } from '@adonis-agora/authkit-core';

type FetchImpl = (url: string, init: any) => Promise<{ ok: boolean; json: () => Promise<any> }>;

/**
 * Mapeamento canônico de claims OIDC validadas → Identity, compartilhado pelos
 * resolvers `jwt`, `pat` e `opaque`. Espelha exatamente o que o `JwtResolver`
 * produzia (a referência canônica): `sub`→userId, `email`, papéis na
 * `globalRolesClaim`, `name`/`picture`→profile, `sid`→sessionId, `iat`/`exp`
 * (segundos→ms, fallback 0), a org/tenant ativo (`orgId`/`orgSlug`/`orgRole`,
 * ver `deriveOrgId` — vale para o authkit E para IdPs de terceiros) e as claims
 * cruas em `raw`.
 */
export function buildIdentityFromClaims(
  claims: Record<string, unknown>,
  globalRolesClaim: string,
): Identity {
  const roles = claims[globalRolesClaim];
  return {
    userId: String(claims.sub ?? ''),
    email: typeof claims.email === 'string' ? claims.email : '',
    globalRoles: Array.isArray(roles) ? (roles as string[]) : [],
    profile: {
      name: typeof claims.name === 'string' ? claims.name : undefined,
      avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
    },
    sessionId: typeof claims.sid === 'string' ? claims.sid : undefined,
    orgId: deriveOrgId(claims),
    orgSlug: deriveOrgSlug(claims),
    orgRole: deriveOrgRole(claims),
    issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : 0,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : 0,
    raw: claims,
  };
}

export interface IntrospectAuth {
  /** `bearer` envia `Authorization: Bearer <value>`; `basic` envia `Authorization: Basic <value>`. */
  type: 'bearer' | 'basic';
  value: string;
}

export interface IntrospectOptions {
  /** `token_type_hint` enviado no corpo (RFC 7662). */
  tokenTypeHint?: string;
  fetchImpl?: FetchImpl;
}

/**
 * Introspecção de token padrão (RFC 7662): POST form-urlencoded com `token`
 * (+ `token_type_hint` opcional) e autenticação Bearer ou Basic. Retorna o
 * payload parseado quando `active:true`; caso contrário (ou em !res.ok) `null`.
 */
export async function introspectToken(
  url: string,
  token: string,
  auth: IntrospectAuth,
  opts: IntrospectOptions = {},
): Promise<Record<string, any> | null> {
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
  const params = new URLSearchParams({ token });
  if (opts.tokenTypeHint) params.set('token_type_hint', opts.tokenTypeHint);

  const authValue = auth.type === 'bearer' ? `Bearer ${auth.value}` : `Basic ${auth.value}`;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: authValue,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.active) return null;
  return data;
}
