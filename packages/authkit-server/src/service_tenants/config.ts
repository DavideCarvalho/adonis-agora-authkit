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
  /**
   * Where this control plane lives, e.g. `'https://telescope.acme.com'`. Published in the
   * discovery document (`agora_control_planes`) so apps find it from the issuer instead of
   * an env var each. Absolute `https` URL; `http` only for localhost. Default: not published.
   */
  url?: string;
}

export interface ServiceTenantsConfigInput {
  /**
   * Resource indicators (RFC 8707) that issue service-tenant tokens, e.g.
   * `{ 'urn:agora:durable': {} }`. Only service-tenant clients can get tokens for them.
   */
  resources?: Record<string, ServiceTenantResourceInput>;
  /**
   * Calls between apps: a service tenant granted another app (`apps` on the client) gets
   * tokens for `urn:agora:app:<name>`. On by default; `false` turns it off.
   * `expiresIn` is the token lifetime in seconds (default 300).
   */
  apps?: false | { expiresIn?: number };
}

/** Resource indicator prefix of an app (calls between apps): `urn:agora:app:<name>`. */
export const APP_RESOURCE_PREFIX = 'urn:agora:app:';

/** Default lifetime of an app-to-app token: 5 minutes. */
export const DEFAULT_APP_TOKEN_TTL = 300;

/** Letters, digits, `.`, `_` and `-`; starts with a letter or digit; up to 64 chars. */
export const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The app name of a `urn:agora:app:<name>` indicator, or `null`. */
export function appResourceName(indicator: string): string | null {
  if (typeof indicator !== 'string' || !indicator.startsWith(APP_RESOURCE_PREFIX)) return null;
  const name = indicator.slice(APP_RESOURCE_PREFIX.length);
  return APP_NAME_PATTERN.test(name) ? name : null;
}

export interface ResolvedServiceTenantResource {
  audience: string;
  expiresIn: number;
  scopes: string[];
  /** Where the control plane lives (published as `agora_control_planes`). */
  url?: string;
}

export interface ResolvedServiceTenantsConfig {
  /** `true` when at least one resource is declared or calls between apps are on. */
  enabled: boolean;
  resources: Record<string, ResolvedServiceTenantResource>;
  /** Calls between apps (`urn:agora:app:<name>`). Absent = off. */
  apps?: { expiresIn: number };
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
  for (const declared of userResources) {
    if (input && input.apps !== false && declared.startsWith(APP_RESOURCE_PREFIX)) {
      throw new Error(
        `authkit: "${declared}" is an app resource (calls between apps): grant the app to a service tenant instead of declaring it in accessTokens.resources.`,
      );
    }
  }
  for (const [indicator, rc] of Object.entries(input?.resources ?? {})) {
    const parsed = URL.parse(indicator);
    if (!parsed || indicator.includes('#')) {
      throw new Error(
        `authkit: serviceTenants.resources["${indicator}"] must be an absolute URI without a fragment (e.g. "urn:agora:durable").`,
      );
    }
    if (indicator.startsWith(APP_RESOURCE_PREFIX)) {
      throw new Error(
        `authkit: serviceTenants.resources["${indicator}"]: app resources are not declared, they are granted per client (\`apps\` on the service tenant).`,
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
    if (rc?.url !== undefined) assertControlPlaneUrl(indicator, rc.url);
    resources[indicator] = {
      audience: rc?.audience ?? indicator,
      expiresIn,
      scopes: [...(rc?.scopes ?? [])],
      ...(rc?.url !== undefined ? { url: rc.url } : {}),
    };
  }
  let apps: { expiresIn: number } | undefined;
  if (input && input.apps !== false) {
    const expiresIn = input.apps?.expiresIn ?? DEFAULT_APP_TOKEN_TTL;
    if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new Error(
        'authkit: serviceTenants.apps.expiresIn must be a positive integer (seconds).',
      );
    }
    apps = { expiresIn };
  }
  return {
    enabled: Object.keys(resources).length > 0 || apps !== undefined,
    resources,
    ...(apps ? { apps } : {}),
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `http` is only for a control plane on this machine (local development). */
function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Throws unless `url` is an absolute `https` URL (`http` on localhost) without
 * credentials or a fragment: it is published in the public discovery document.
 */
function assertControlPlaneUrl(indicator: string, url: unknown): void {
  const where = `authkit: serviceTenants.resources["${indicator}"].url`;
  // `URL.parse` trims; the raw value is what gets published, so refuse padding.
  const parsed = typeof url === 'string' && url === url.trim() ? URL.parse(url) : null;
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error(`${where} must be an absolute https URL (e.g. "https://telescope.acme.com").`);
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error(`${where} must use https (http is only allowed for localhost).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${where} must not carry credentials: it is published in the discovery document.`,
    );
  }
  if (parsed.hash || (url as string).includes('#')) {
    throw new Error(`${where} must not have a fragment.`);
  }
}

/**
 * The `agora_control_planes` discovery field: resource indicator → URL, for every
 * service-tenant resource that declares a `url`. Empty when none does.
 */
export function controlPlaneLocations(
  config: ResolvedServiceTenantsConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [indicator, resource] of Object.entries(config.resources)) {
    if (resource.url) out[indicator] = resource.url;
  }
  return out;
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
