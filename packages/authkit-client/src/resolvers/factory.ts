import type { SessionResolver } from '@adonis-agora/authkit-core';
import { getTokenFromSource, type TokenSource } from '../token_source.js';
import { JwtResolver } from './jwt_resolver.js';
import { OpaqueResolver } from './opaque_resolver.js';
import { PatResolver } from './pat_resolver.js';

export interface JwtResolverFactoryConfig {
  tokenSource?: TokenSource;
  /** jwks_uri explícito; se omitido, é `${issuer}/jwks` (rota padrão do oidc-provider) */
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
  /** Endpoint de introspection; default `${issuer}/token/introspection` (oidc-provider). */
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
}

export interface ResolverFactory {
  resolver(ctx: ResolverContext): Promise<SessionResolver>;
}

export const resolvers = {
  jwt(config: JwtResolverFactoryConfig = {}): ResolverFactory {
    const tokenSource = config.tokenSource ?? 'session';
    return {
      async resolver(rc) {
        const jwksUri = config.jwksUri ?? `${rc.issuer}/jwks`;
        return new JwtResolver({
          issuer: rc.issuer,
          jwksUri,
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
        const introspectionUrl = config.introspectionUrl ?? `${rc.issuer}/token/introspection`;
        return new OpaqueResolver({
          introspectionUrl,
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
