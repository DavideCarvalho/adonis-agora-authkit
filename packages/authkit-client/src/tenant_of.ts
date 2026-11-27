/**
 * Everything an Agora library needs to run as a tenant of one control plane
 * (`topology: 'tenant'`), derived from this app's `service` in `config/authkit_client.ts`:
 * the control plane's URL (issuer discovery), a service token for it (client credentials,
 * audience = the resource) and this app's partition. Libraries read it through the
 * `authkit.client` binding (`tenantOf(resource)`), so `defineConfig({ topology: 'tenant' })`
 * is enough in an app that has authkit-client's `service` configured.
 */

import type { ResolvedAppCalls } from './app_calls/config.js';
import {
  type ControlPlaneUrl,
  controlPlaneUrl,
  type DiscoverControlPlaneOptions,
} from './control_planes.js';
import { type AuthkitTenantTokenFn, authkitTenantToken } from './tenant_token.js';

/** What `tenantOf(resource)` returns: the `tenant` block of a library in `topology: 'tenant'`. */
export interface AuthkitTenant {
  /**
   * Control-plane URL for the resource, discovered from the issuer (`controlPlaneUrl`):
   * call it where the URL is needed; `refresh()` refetches the discovery document.
   */
  url: ControlPlaneUrl;
  /**
   * Service token for the resource (`authkitTenantToken`: client credentials of `service`,
   * audience = the resource), cached until near expiry; `reset()` drops it (after a 401).
   */
  token: AuthkitTenantTokenFn;
  /** This app's partition: `service.partition`, else `service.name`. */
  partition: string;
}

/** Thrown by `tenantOf()` when `service` (with its credentials) is not configured. */
export class TenantOfConfigError extends Error {
  readonly code = 'E_AUTHKIT_SERVICE_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'TenantOfConfigError';
  }
}

const SERVICE_LINE =
  "service: { name: '<this app>', clientId: env.get('AUTHKIT_SERVICE_CLIENT_ID'), clientSecret: env.get('AUTHKIT_SERVICE_CLIENT_SECRET') }";

export interface CreateTenantOfOptions {
  issuer: string;
  calls: ResolvedAppCalls | undefined;
  /** Token endpoint override (`endpoints.tokenEndpoint`, or the convention with `discovery: false`). */
  tokenEndpoint?: string;
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  resilience?: DiscoverControlPlaneOptions['resilience'];
}

/** Builds the tenant of one resource. Throws {@link TenantOfConfigError} without `service`. */
export function createTenantOf(resource: string, options: CreateTenantOfOptions): AuthkitTenant {
  if (typeof resource !== 'string' || !resource) {
    throw new TypeError('tenantOf: resource is required (e.g. "urn:agora:telescope")');
  }
  const calls = options.calls;
  if (!calls) {
    throw new TenantOfConfigError(
      `authkit_client: tenantOf("${resource}") needs this app as a service. Add to config/authkit_client.ts: ${SERVICE_LINE}`,
    );
  }
  if (!calls.clientId || !calls.clientSecret) {
    throw new TenantOfConfigError(
      `authkit_client: tenantOf("${resource}") needs service.clientId and service.clientSecret (a service-tenant client). Set in config/authkit_client.ts: ${SERVICE_LINE}`,
    );
  }
  const url = controlPlaneUrl({
    issuer: options.issuer,
    resource,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.resilience ? { resilience: options.resilience } : {}),
  });
  const token = authkitTenantToken({
    issuer: options.issuer,
    clientId: calls.clientId,
    clientSecret: calls.clientSecret,
    resource,
    ...(options.tokenEndpoint ? { tokenEndpoint: options.tokenEndpoint } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { url, token, partition: calls.partition };
}
