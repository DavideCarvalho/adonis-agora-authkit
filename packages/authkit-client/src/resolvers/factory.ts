import type { SessionResolver } from '@adonis-agora/authkit-core';
import { OidcDiscoveryError, type OidcEndpoints } from '../discovery.js';
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
  /** The IdP endpoints (discovery + overrides), cached by the caller — call it per request. */
  endpoints: () => Promise<OidcEndpoints>;
  /** Where a resolver reports that the IdP cannot serve it (e.g. no introspection). */
  logger: { warn(obj: object, msg: string): void };
}

/**
 * The current endpoints, or `null` while discovery fails (and nothing was ever
 * discovered): a request then resolves to no identity — the same outcome as an
 * unreachable JWKS — instead of failing every request, public pages included via
 * silent auth. Any other error is a configuration error and throws.
 */
async function currentEndpoints(rc: ResolverContext): Promise<OidcEndpoints | null> {
  try {
    return await rc.endpoints();
  } catch (error) {
    if (error instanceof OidcDiscoveryError) return null;
    throw error;
  }
}

export interface ResolverFactory {
  resolver(ctx: ResolverContext): Promise<SessionResolver>;
}

export const resolvers = {
  jwt(config: JwtResolverFactoryConfig = {}): ResolverFactory {
    const tokenSource = config.tokenSource ?? 'session';
    return {
      async resolver(rc) {
        return new JwtResolver({
          endpoints: async () => {
            const endpoints = await currentEndpoints(rc);
            if (!endpoints) return null;
            return { issuer: endpoints.issuer, jwksUri: config.jwksUri ?? endpoints.jwksUri };
          },
          audience: rc.clientId,
          globalRolesClaim: rc.globalRolesClaim,
          getToken: (httpCtx) => getTokenFromSource(httpCtx, tokenSource, rc.sessionKey),
        });
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
        let warned = false;
        return new OpaqueResolver({
          introspectionUrl: async () => {
            if (config.introspectionUrl) return config.introspectionUrl;
            const endpoints = await currentEndpoints(rc);
            if (!endpoints) return null;
            if (!endpoints.introspectionEndpoint && !warned) {
              warned = true;
              rc.logger.warn(
                { issuer: rc.issuer },
                'authkit-client: the IdP publishes no introspection_endpoint, so resolvers.opaque ' +
                  'resolves every request to no identity — set introspectionUrl',
              );
            }
            return endpoints.introspectionEndpoint ?? null;
          },
          clientId: rc.clientId,
          clientSecret: rc.clientSecret,
          tokenSource,
          sessionKey: rc.sessionKey,
          globalRolesClaim: rc.globalRolesClaim,
          cacheTtlMs: config.cacheTtlMs,
        });
      },
    };
  },
};
