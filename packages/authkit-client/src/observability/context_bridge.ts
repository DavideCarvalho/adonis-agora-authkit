import type { Identity } from '@adonis-agora/authkit-core';
import { deriveOrgId, deriveOrgRole, deriveOrgSlug } from '@adonis-agora/authkit-core';

/**
 * Ponte estrutural (best-effort) entre a sessão resolvida do authkit e o
 * contexto do Agora. Lê os slots globais `@agora/context:set` e
 * `@agora/context:accessor` de forma ESTRUTURAL — nunca importa
 * `@adonis-agora/context` — e degrada para no-op quando o context não está
 * instalado (ou é uma versão sem tenancy). Mesmo idioma da `diagnostics_bridge`.
 */
const SET_SLOT = Symbol.for('@agora/context:set');
const ACCESSOR_SLOT = Symbol.for('@agora/context:accessor');

/**
 * The tenant authkit publishes into `@agora/context` (structural copy of the
 * context's `TenantRef`). `chain` lists the active path from the outermost
 * tenant to this one (this one last) when tenants nest; absent for a flat tenant.
 */
export interface ContextTenant {
  id: string;
  kind: 'organization' | 'user' | (string & {});
  source: 'authkit' | 'app' | 'carrier' | 'legacy' | (string & {});
  slug?: string;
  role?: string;
  chain?: ContextTenantLink[];
}

/** One level of a nested tenant chain. */
export interface ContextTenantLink {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** What `tenancy.resolve` may return: one tenant, a chain (outermost first, active last), or none. */
export type TenantInput = Omit<ContextTenantLink, 'kind'> & { kind?: string };

/** Client-side tenancy options (`config/authkit_client.ts` → `tenancy`). */
export interface ClientTenancyOptions {
  /**
   * Resolve the session (and so publish the tenant) at the start of every request
   * that runs `authkit_context_middleware`, instead of on first use. Default: `true`
   * when `config/context.ts` enables tenancy AND the resolver is `resolvers.jwt()`
   * (local verify, cheap); `false` otherwise.
   */
  eager?: boolean;
  /**
   * With no active organization, publish the user as the tenant (`kind: 'user'`),
   * so personal workspaces are tenants too. Default: `false` (orgless requests
   * have no tenant).
   */
  personal?: boolean;
  /**
   * Map the session to your own tenant model (e.g. clinic → unit). Return one
   * tenant, a chain (outermost first, active last), or `null` for no tenant;
   * return `undefined` to keep authkit's default (the active organization).
   */
  resolve?: (identity: Identity) => TenantInput | TenantInput[] | null | undefined;
}

type SetFn = (patch: {
  userRef?: { type: string; id: string };
  tenantId?: string;
  tenant?: ContextTenant;
  globalRoles?: string[];
  [k: string]: unknown;
}) => void;

interface AccessorLike {
  get?: (key?: string) => unknown;
  tenancy?: () => { enabled?: boolean } | undefined;
}

function accessor(): AccessorLike | undefined {
  const value = (globalThis as Record<symbol, unknown>)[ACCESSOR_SLOT];
  return value && typeof value === 'object' ? (value as AccessorLike) : undefined;
}

/**
 * `true` when the installed `@adonis-agora/context` has tenancy enabled
 * (`config/context.ts` → `tenancy.enabled`). `false` without context, or with a
 * context version that predates tenancy.
 */
export function contextTenancyEnabled(): boolean {
  try {
    const tenancy = accessor()?.tenancy;
    return typeof tenancy === 'function' && tenancy()?.enabled === true;
  } catch {
    return false;
  }
}

/** The tenant an app set itself (`Context.setTenant`) on this request, if any. */
function appTenantAlreadySet(): boolean {
  try {
    const get = accessor()?.get;
    if (typeof get !== 'function') return false;
    const current = get('tenant') as { source?: unknown } | undefined;
    return !!current && current.source === 'app';
  } catch {
    return false;
  }
}

/**
 * Deriva o tenant ativo da identidade. Prefere o `orgId` já resolvido (o caminho
 * normal — `buildIdentityFromClaims` o preenche); cai para as claims cruas
 * quando a `Identity` veio de um `SessionResolver` customizado que não o
 * populou. A tabela de claims aceitas vive em `@adonis-agora/authkit-core`
 * (`ORG_ID_CLAIMS`) para não divergir entre a identidade e esta ponte.
 */
function organizationTenant(identity: Identity): ContextTenant | null {
  const id = identity.orgId ?? deriveOrgId(identity.raw);
  if (!id) return null;
  const slug = identity.orgSlug ?? deriveOrgSlug(identity.raw);
  const role = identity.orgRole ?? deriveOrgRole(identity.raw);
  return {
    id,
    kind: 'organization',
    source: 'authkit',
    ...(slug ? { slug } : {}),
    ...(role ? { role } : {}),
  };
}

function link(input: TenantInput, fallbackKind: string): ContextTenantLink | null {
  if (!input || typeof input.id !== 'string' || input.id === '') return null;
  return {
    id: input.id,
    kind: typeof input.kind === 'string' && input.kind !== '' ? input.kind : fallbackKind,
    ...(typeof input.slug === 'string' && input.slug ? { slug: input.slug } : {}),
    ...(typeof input.role === 'string' && input.role ? { role: input.role } : {}),
  };
}

function fromResolved(resolved: TenantInput | TenantInput[]): ContextTenant | null {
  const inputs = Array.isArray(resolved) ? resolved : [resolved];
  const links = inputs.map((input) => link(input, 'organization'));
  if (links.length === 0 || links.some((l) => l === null)) return null;
  const chain = links as ContextTenantLink[];
  const active = chain[chain.length - 1];
  return { ...active, source: 'authkit', ...(chain.length > 1 ? { chain } : {}) };
}

/** The tenant authkit would publish for `identity` under `options`. */
export function tenantFor(
  identity: Identity,
  options: ClientTenancyOptions = {},
): ContextTenant | null {
  if (options.resolve) {
    const resolved = options.resolve(identity);
    if (resolved === null) return null;
    if (resolved !== undefined) return fromResolved(resolved);
  }
  const org = organizationTenant(identity);
  if (org) return org;
  if (options.personal === true && identity.userId) {
    return { id: identity.userId, kind: 'user', source: 'authkit' };
  }
  return null;
}

/**
 * Popula o contexto do Agora a partir de uma identidade recém-resolvida:
 * `userRef` ({ type: 'user', id: userId }), os `globalRoles` da identidade e,
 * quando há um tenant, `tenant` (id, kind, slug, role, e `chain` quando aninhado)
 * mais `tenantId`. Um tenant que o próprio app já definiu nesta request
 * (`Context.setTenant`, `source: 'app'`) nunca é sobrescrito. Best-effort:
 * qualquer erro é engolido e nada acontece sem o slot.
 */
export function populateContext(identity: Identity, options: ClientTenancyOptions = {}): void {
  try {
    const set = (globalThis as Record<symbol, unknown>)[SET_SLOT] as SetFn | undefined;
    if (!set) return;
    let tenant: ContextTenant | null = null;
    try {
      tenant = appTenantAlreadySet() ? null : tenantFor(identity, options);
    } catch {
      tenant = null;
    }
    set({
      userRef: { type: 'user', id: identity.userId },
      globalRoles: identity.globalRoles,
      ...(tenant ? { tenantId: tenant.id, tenant } : {}),
    });
  } catch {
    // best-effort: a ponte de contexto nunca quebra o caminho da request.
  }
}
