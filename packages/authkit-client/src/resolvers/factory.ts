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
}

async function endpointsOf(rc: ResolverContext): Promise<OidcEndpoints> {
  return rc.endpoints ? rc.endpoints() : conventionEndpoints(rc.issuer);
}

/**
 * Builds the resolver on first use instead of when the factory runs, because the
 * endpoints it needs may come from discovery. While discovery fails, a request
 * resolves to no identity — the same outcome as an unreachable JWKS — instead of
 * failing every request (public pages included, via silent auth). The build is
 * retried on the next request. Any other error is a configuration error and throws.
 */
function lazily<R>(build: () => Promise<R>): () => Promise<R | null> {
  let pending: Promise<R> | undefined;
  return async () => {
    pending ??= build();
    try {
      return await pending;
    } catch (error) {
      pending = undefined;
      if (error instanceof OidcDiscoveryError) return null;
      throw error;
    }
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
        const inner = lazily(async () => {
          const endpoints = await endpointsOf(rc);
          return new JwtResolver({
            issuer: endpoints.issuer ?? rc.issuer,
            jwksUri: config.jwksUri ?? endpoints.jwksUri,
            audience: rc.clientId,
            globalRolesClaim: rc.globalRolesClaim,
            getToken: (httpCtx) => getTokenFromSource(httpCtx, tokenSource, rc.sessionKey),
          });
        });
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
        const inner = lazily(async () => {
          const introspectionUrl =
            config.introspectionUrl ?? (await endpointsOf(rc)).introspectionEndpoint;
          if (!introspectionUrl) {
            throw new Error(
              'resolvers.opaque: the IdP publishes no introspection_endpoint — set introspectionUrl',
            );
          }
          return new OpaqueResolver({
            introspectionUrl,
            clientId: rc.clientId,
            clientSecret,
            tokenSource,
            sessionKey: rc.sessionKey,
            globalRolesClaim: rc.globalRolesClaim,
            cacheTtlMs: config.cacheTtlMs,
          });
        });
        return {
          async resolve(ctx: HttpContext) {
            return (await inner())?.resolve(ctx) ?? null;
          },
        };
      },
    };
  },
};
