/**
 * Service tenants: confidential `client_credentials` clients that act as a partition
 * (`partition` claim) of a resource server (e.g. a durable control plane). Their tokens
 * are JWT access tokens (RFC 9068) whose `aud` is the resource (RFC 8707).
 */

/** One resource that issues service-tenant tokens. */
export interface ServiceTenantResourceInput {
  /** `aud` of the token. Default: the resource indicator itself. */
  audience?: string;
  /** Token lifetime in seconds. Default: 600 (10 minutes). */
  expiresIn?: number;
  /** Scopes a service tenant may request for this resource. Default: none. */
  scopes?: string[];
}

export interface ServiceTenantsConfigInput {
  /**
   * Resource indicators (RFC 8707) that issue service-tenant tokens, e.g.
   * `{ 'urn:agora:durable': {} }`. Only service-tenant clients can get tokens for them.
   */
  resources: Record<string, ServiceTenantResourceInput>;
}

export interface ResolvedServiceTenantResource {
  audience: string;
  expiresIn: number;
  scopes: string[];
}

export interface ResolvedServiceTenantsConfig {
  /** `true` when at least one resource is declared. */
  enabled: boolean;
  resources: Record<string, ResolvedServiceTenantResource>;
}

/** Default token lifetime: 10 minutes. */
export const DEFAULT_SERVICE_TENANT_TTL = 600;

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Resolves `serviceTenants`. Throws on an invalid resource indicator, a non-positive
 * `expiresIn`, or a resource also declared in `accessTokens.resources` (a resource is
 * either for users or for service tenants, never both).
 */
export function resolveServiceTenants(
  input: ServiceTenantsConfigInput | undefined,
  accessTokenResources: Record<string, unknown> = {},
): ResolvedServiceTenantsConfig {
  const resources: Record<string, ResolvedServiceTenantResource> = {};
  const userResources = new Set(Object.keys(accessTokenResources).map(trimSlash));
  for (const [indicator, rc] of Object.entries(input?.resources ?? {})) {
    const parsed = URL.parse(indicator);
    if (!parsed || indicator.includes('#')) {
      throw new Error(
        `authkit: serviceTenants.resources["${indicator}"] must be an absolute URI without a fragment (e.g. "urn:agora:durable").`,
      );
    }
    if (userResources.has(trimSlash(indicator))) {
      throw new Error(
        `authkit: "${indicator}" is declared in both accessTokens.resources and serviceTenants.resources. Pick one.`,
      );
    }
    const expiresIn = rc?.expiresIn ?? DEFAULT_SERVICE_TENANT_TTL;
    if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new Error(
        `authkit: serviceTenants.resources["${indicator}"].expiresIn must be a positive integer (seconds).`,
      );
    }
    resources[indicator] = {
      audience: rc?.audience ?? indicator,
      expiresIn,
      scopes: [...(rc?.scopes ?? [])],
    };
  }
  return { enabled: Object.keys(resources).length > 0, resources };
}

/** Finds a declared service-tenant resource, tolerating a trailing slash. */
export function findServiceTenantResource(
  config: ResolvedServiceTenantsConfig,
  indicator: string,
): { key: string; resource: ResolvedServiceTenantResource } | null {
  if (config.resources[indicator]) return { key: indicator, resource: config.resources[indicator] };
  const trimmed = trimSlash(indicator);
  const key = Object.keys(config.resources).find((k) => trimSlash(k) === trimmed);
  return key ? { key, resource: config.resources[key] } : null;
}
