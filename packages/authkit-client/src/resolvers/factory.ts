import type { SessionResolver } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { conventionEndpoints, OidcDiscoveryError, type OidcEndpoints } from '../discovery.js';
import { getTokenFromSource, type TokenSource } from '../token_source.js';
import { JwtResolver } from './jwt_resolver.js';
import { OpaqueResolver } from './opaque_resolver.js';
import { PatResolver } from './pat_resolver.js';

export interface JwtResolverFactoryConfig {
  tokenSource?: TokenSource;
  /** Explicit jwks_uri. Default: the discovered `jwks_uri` (`${issuer}/jwks` with discovery off). */
  jwksUri?: string;
}

export interface PatResolverFactoryConfig {
  introspectionUrl: string;
  introspectionSecret: string;
}

export interface OpaqueResolverFactoryConfig {
  /**
   * De onde tirar o access token. `session` (default) introspecta o access token
   * guardado no TokenSet; `bearer` introspecta o token do header Authorization (APIs).
   */
  tokenSource?: TokenSource;
  /** Introspection endpoint. Default: the discovered one (`${issuer}/token/introspection` with discovery off). */
  introspectionUrl?: string;
  /**
   * TTL (ms) do cache de respostas `active:true`. Default 0 (revogação imediata).
   * Suba para reduzir round-trips ao custo de imediatismo.
   */
  cacheTtlMs?: number;
}

/** Contexto que o provider passa ao resolver na resolução. */
export interface ResolverContext {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  sessionKey: string;
  globalRolesClaim: string;
  /**
   * Resolved IdP endpoints (discovery + overrides). Optional so hand-built
   * contexts keep compiling; without it, the authkit-server convention is used.
   */
  endpoints?: () => Promise<OidcEndpoints>;
  /** Where a resolver reports that the IdP cannot serve it (e.g. no introspection). */
  logger?: { warn(obj: object, msg: string): void };
}

async function endpointsOf(rc: ResolverContext): Promise<OidcEndpoints> {
  return rc.endpoints ? rc.endpoints() : conventionEndpoints(rc.issuer);
}

/**
 * Builds the resolver from the CURRENT endpoints, on each request: discovery is
 * cached (15 min), so this is cheap, and a rotated `jwks_uri` / `issuer` reaches a
 * live process on the next refetch instead of sticking until restart. The resolver
 * itself is rebuilt only when `select` yields a different key, so its JWKS cache
 * survives between requests.
 *
 * While discovery fails (and nothing was ever discovered), a request resolves to
 * no identity — the same outcome as an unreachable JWKS — instead of failing every
 * request, public pages included via silent auth. `select` returning `null` means
 * "this IdP cannot serve this resolver"; that also resolves to no identity, after
 * a one-time warning. Any other error is a configuration error and throws.
 */
function endpointBound<R>(
  rc: ResolverContext,
  select: (endpoints: OidcEndpoints) => string | null,
  build: (endpoints: OidcEndpoints) => R,
  unavailable: string,
): () => Promise<R | null> {
  let current: { key: string; resolver: R } | undefined;
  let warned = false;
  return async () => {
    let endpoints: OidcEndpoints;
    try {
      endpoints = await endpointsOf(rc);
    } catch (error) {
      if (error instanceof OidcDiscoveryError) return current?.resolver ?? null;
      throw error;
    }
    const key = select(endpoints);
    if (key === null) {
      if (!warned) rc.logger?.warn({ issuer: rc.issuer }, unavailable);
      warned = true;
      return null;
    }
    if (current?.key !== key) current = { key, resolver: build(endpoints) };
    return current.resolver;
  };
}

export interface ResolverFactory {
  resolver(ctx: ResolverContext): Promise<SessionResolver>;
}

export const resolvers = {
  jwt(config: JwtResolverFactoryConfig = {}): ResolverFactory {
    const tokenSource = config.tokenSource ?? 'session';
    return {
      async resolver(rc) {
        const inner = endpointBound(
          rc,
          (e) => `${e.issuer ?? rc.issuer} ${config.jwksUri ?? e.jwksUri}`,
          (e) =>
            new JwtResolver({
              issuer: e.issuer ?? rc.issuer,
              jwksUri: config.jwksUri ?? e.jwksUri,
              audience: rc.clientId,
              globalRolesClaim: rc.globalRolesClaim,
              getToken: (httpCtx) => getTokenFromSource(httpCtx, tokenSource, rc.sessionKey),
            }),
          'authkit-client: resolvers.jwt has no jwks_uri',
        );
        return {
          async resolve(ctx: HttpContext) {
            return (await inner())?.resolve(ctx) ?? null;
          },
          /** Validates a raw JWT (same contract as `JwtResolver.resolveToken`). */
          async resolveToken(token: string) {
            return (await inner())?.resolveToken(token) ?? null;
          },
        };
      },
    };
  },

  pat(config: PatResolverFactoryConfig): ResolverFactory {
    return {
      async resolver(_rc) {
        return new PatResolver({
          introspectionUrl: config.introspectionUrl,
          introspectionSecret: config.introspectionSecret,
        });
      },
    };
  },

  opaque(config: OpaqueResolverFactoryConfig = {}): ResolverFactory {
    const tokenSource = config.tokenSource ?? 'session';
    return {
      async resolver(rc) {
        if (!rc.clientSecret) {
          throw new Error(
            'resolvers.opaque requer um client confidencial (clientSecret) para introspection',
          );
        }
        const clientSecret = rc.clientSecret;
        const inner = endpointBound(
          rc,
          (e) => config.introspectionUrl ?? e.introspectionEndpoint ?? null,
          (e) =>
            new OpaqueResolver({
              introspectionUrl: (config.introspectionUrl ?? e.introspectionEndpoint) as string,
              clientId: rc.clientId,
              clientSecret,
              tokenSource,
              sessionKey: rc.sessionKey,
              globalRolesClaim: rc.globalRolesClaim,
              cacheTtlMs: config.cacheTtlMs,
            }),
          'authkit-client: the IdP publishes no introspection_endpoint, so resolvers.opaque ' +
            'resolves every request to no identity — set introspectionUrl',
        );
        return {
          async resolve(ctx: HttpContext) {
            return (await inner())?.resolve(ctx) ?? null;
          },
        };
      },
    };
  },
};
