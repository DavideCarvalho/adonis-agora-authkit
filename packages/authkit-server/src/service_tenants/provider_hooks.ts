import { errors } from 'oidc-provider';
import type { OidcAdapter } from '../adapters/adapter_contract.js';
import type { OidcAdapterClass } from '../adapters/factory.js';
import type { AuditSink } from '../audit/audit_sink.js';
import { type ServiceTenantInfo, serviceTenantOf } from './client_metadata.js';
import { findServiceTenantResource, type ResolvedServiceTenantsConfig } from './config.js';

export interface ServiceTenantHooksDeps {
  serviceTenants: ResolvedServiceTenantsConfig;
  /** Adapter class of the `Client` model (raw: sees authkit's own keys). */
  AdapterClass: OidcAdapterClass;
  audit?: AuditSink;
}

/** Resource server info for a service-tenant resource, in oidc-provider's shape. */
export interface ServiceTenantResourceServerInfo {
  scope: string;
  audience: string;
  accessTokenFormat: 'jwt';
  accessTokenTTL: number;
  jwt: { sign: { alg: string } };
}

/**
 * The provider hooks behind service tenants:
 *
 * - a service-tenant resource is granted only to a service-tenant client, only on the
 *   `client_credentials` grant, always as a JWT access token (RFC 9068);
 * - a service-tenant client can only get tokens for a service-tenant resource (when
 *   it sends no `resource` and exactly one is declared, that one is used);
 * - its tokens carry the `partition` (and `capabilities`) claims read from the client
 *   at issuance time, so an edit applies to the next token.
 */
export function createServiceTenantHooks(deps: ServiceTenantHooksDeps) {
  const { serviceTenants } = deps;
  const memo = new WeakMap<object, Map<string, Promise<ServiceTenantInfo | null>>>();
  let adapter: OidcAdapter | undefined;

  const read = async (clientId: string): Promise<ServiceTenantInfo | null> => {
    adapter ??= new (deps.AdapterClass as any)('Client') as OidcAdapter;
    return serviceTenantOf((await adapter.find(clientId)) as Record<string, unknown> | undefined);
  };

  /** Service-tenant info of the client, memoized per request. */
  const tenantOf = (ctx: any, clientId: string | undefined) => {
    if (!clientId) return Promise.resolve(null);
    const key = ctx && typeof ctx === 'object' ? ctx : null;
    if (!key) return read(clientId);
    let byClient = memo.get(key);
    if (!byClient) {
      byClient = new Map();
      memo.set(key, byClient);
    }
    let pending = byClient.get(clientId);
    if (!pending) {
      pending = read(clientId);
      byClient.set(clientId, pending);
    }
    return pending;
  };

  return {
    enabled: serviceTenants.enabled,

    /**
     * `defaultResource` for a service-tenant client: the only declared resource, or
     * `invalid_target` when several are declared. `undefined` for any other client.
     */
    async defaultResource(ctx: any, client: any): Promise<string | undefined> {
      if (!serviceTenants.enabled) return undefined;
      if (!(await tenantOf(ctx, client?.clientId))) return undefined;
      const keys = Object.keys(serviceTenants.resources);
      if (keys.length === 1) return keys[0];
      throw new errors.InvalidTarget('a service tenant must send the resource parameter');
    },

    /**
     * `getResourceServerInfo` for service tenants. Returns the info for a
     * service-tenant resource, `undefined` when neither the resource nor the client is
     * a service-tenant one (the caller handles it), and throws `invalid_target` for a
     * mismatch.
     */
    async resourceServerInfo(
      ctx: any,
      indicator: string,
      client: any,
      signAlg: string,
    ): Promise<ServiceTenantResourceServerInfo | undefined> {
      if (!serviceTenants.enabled) return undefined;
      const found = findServiceTenantResource(serviceTenants, indicator);
      const tenant = await tenantOf(ctx, client?.clientId);
      if (found) {
        const grantType = ctx?.oidc?.params?.grant_type;
        if (!tenant || grantType !== 'client_credentials') {
          throw new errors.InvalidTarget(`resource indicator not allowed: ${indicator}`);
        }
        return {
          scope: found.resource.scopes.join(' '),
          audience: found.resource.audience,
          accessTokenFormat: 'jwt',
          accessTokenTTL: found.resource.expiresIn,
          jwt: { sign: { alg: signAlg } },
        };
      }
      if (tenant) {
        throw new errors.InvalidTarget(
          `resource indicator not allowed for a service tenant: ${indicator}`,
        );
      }
      return undefined;
    },

    /** `extraTokenClaims` for a service-tenant token; audits the issuance. */
    async extraClaims(
      ctx: any,
      token: any,
    ): Promise<{ partition: string; capabilities?: string[] } | undefined> {
      if (!serviceTenants.enabled || token?.kind !== 'ClientCredentials') return undefined;
      const rs = token.resourceServer;
      const indicator: unknown = typeof rs?.identifier === 'function' ? rs.identifier() : undefined;
      if (typeof indicator !== 'string') return undefined;
      const found = findServiceTenantResource(serviceTenants, indicator);
      if (!found) return undefined;
      const tenant = await tenantOf(ctx, token.clientId);
      if (!tenant) return undefined;
      try {
        await deps.audit
          ?.record({
            type: 'service_tenant.token_issued',
            clientId: token.clientId,
            ip: typeof ctx?.ip === 'string' ? ctx.ip : null,
            metadata: {
              partition: tenant.partition,
              resource: found.key,
              jti: token.jti,
              expiresIn: found.resource.expiresIn,
            },
          })
          .catch(() => {});
      } catch {
        // Auditing is best-effort: it never fails an issuance.
      }
      return {
        partition: tenant.partition,
        ...(tenant.capabilities.length ? { capabilities: tenant.capabilities } : {}),
      };
    },
  };
}

export type ServiceTenantHooks = ReturnType<typeof createServiceTenantHooks>;
