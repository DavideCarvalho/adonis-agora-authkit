import type { HttpContext } from '@adonisjs/core/http';

/**
 * Identidade resolvida por request a partir das claims OIDC validadas.
 * Fronteira: só identidade (claims globais) — nada de domínio do app.
 */
export interface Identity {
  /** claim `sub` */
  userId: string;
  email: string;
  /** papéis globais, de uma claim custom (ex.: `roles`) */
  globalRoles: string[];
  /** claims OIDC padrão de perfil */
  profile?: { name?: string; avatarUrl?: string };
  /** `sid` quando presente */
  sessionId?: string;
  /**
   * Organização (tenant) ATIVA da sessão, derivada das claims — `null` quando o
   * usuário não tem org ativa. Campo de primeira classe (e não só
   * `raw.org_id`) porque é o eixo de multi-tenancy: é o que o app usa para
   * escopar queries e o que a ponte de contexto publica como `tenantId` para o
   * `@adonis-agora/authz`. Ver {@link ORG_ID_CLAIMS} para os aliases aceitos.
   */
  orgId?: string | null;
  /** Slug da org ativa (claim `org_slug`), quando presente. */
  orgSlug?: string | null;
  /** Papel do usuário DENTRO da org ativa (claim `org_role`), quando presente. */
  orgRole?: string | null;
  /** `iat` em epoch ms */
  issuedAt: number;
  /** `exp` em epoch ms */
  expiresAt: number;
  /** claims completas (escape hatch) */
  raw: Record<string, unknown>;
}

/**
 * Contrato do driver de resolução de sessão (estratégia por request).
 * v1 do client implementa `resolvers.jwt()`.
 */
export interface SessionResolver {
  resolve(ctx: HttpContext): Promise<Identity | null>;
}

/**
 * Claims OIDC candidatas a "organização/tenant ativo", em ordem de precedência.
 * A primeira presente (string não vazia) vence.
 *
 * A lista existe porque o authkit é apenas UM dos IdPs possíveis: quando o app
 * está atrás de um IdP de terceiro (ver `byo-idp`), o tenant chega com outro
 * nome (`tid` no Entra ID, `organization_id` em vários). Derivar em UM lugar só
 * evita que cada app — e cada lib do Agora — reescreva essa tabela.
 */
export const ORG_ID_CLAIMS = [
  'active_organization_id',
  'org_id',
  'organization_id',
  'tenant_id',
  'tid',
] as const;

/** Lê a primeira claim string não-vazia de `names`, ou `null`. */
function firstStringClaim(
  claims: Record<string, unknown> | undefined,
  names: readonly string[],
): string | null {
  if (!claims) return null;
  for (const name of names) {
    const value = claims[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Deriva a org/tenant ativo das claims cruas. `null` quando ausente. */
export function deriveOrgId(claims: Record<string, unknown> | undefined): string | null {
  return firstStringClaim(claims, ORG_ID_CLAIMS);
}

/** Deriva o slug da org ativa das claims cruas. `null` quando ausente. */
export function deriveOrgSlug(claims: Record<string, unknown> | undefined): string | null {
  return firstStringClaim(claims, ['org_slug', 'organization_slug']);
}

/** Deriva o papel do usuário na org ativa. `null` quando ausente. */
export function deriveOrgRole(claims: Record<string, unknown> | undefined): string | null {
  return firstStringClaim(claims, ['org_role', 'organization_role']);
}
