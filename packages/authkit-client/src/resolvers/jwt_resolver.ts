import type { Identity, SessionResolver } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { jwtVerify } from 'jose';
import type { OidcEndpoints } from '../discovery.js';
import { DEFAULT_ALGS, getJwks } from '../jwks.js';
import { DpopReplayCache, verifyDpopProof } from './dpop_proof.js';
import { buildIdentityFromClaims } from './identity.js';

export interface JwtResolverConfig {
  /**
   * Issuer and jwks_uri to verify against, read on every token so a rotated
   * `jwks_uri` / `issuer` takes effect without a restart. `null` (discovery is
   * failing) resolves to no identity.
   */
  endpoints: () => Promise<Pick<OidcEndpoints, 'issuer' | 'jwksUri'> | null>;
  audience: string;
  globalRolesClaim: string;
  /** algoritmos de assinatura aceitos (defesa contra alg-confusion). Default: asimétricos. */
  algorithms?: string[];
  /** de onde extrair o token cru no request; injetado pelo factory */
  getToken?: (ctx: HttpContext) => string | null;
  /**
   * Read the token from the `Authorization` header (API routes) instead of
   * `getToken`. `Bearer <token>` and `DPoP <token>` (with its `DPoP` proof header)
   * are accepted; a DPoP-bound token (`cnf.jkt`) sent as `Bearer` is refused.
   */
  authorizationHeader?: boolean;
  /** Acceptance window of DPoP proofs, in seconds. Default: 300. */
  dpopMaxAge?: number;
}

export class JwtResolver implements SessionResolver {
  #replay = new DpopReplayCache();

  constructor(private config: JwtResolverConfig) {}

  /** The verified claims of a raw JWT, or `null`. */
  async #verify(token: string): Promise<Record<string, unknown> | null> {
    const endpoints = await this.config.endpoints();
    if (!endpoints) return null;
    const keys = getJwks(endpoints.jwksUri);
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: endpoints.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms ?? DEFAULT_ALGS,
      });
      // uma identidade válida exige um subject (`sub`)
      if (!payload.sub) return null;
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  #identity(claims: Record<string, unknown> | null): Identity | null {
    return claims ? buildIdentityFromClaims(claims, this.config.globalRolesClaim) : null;
  }

  /** Valida um JWT cru e monta a Identity (ou null se inválido). */
  async resolveToken(token: string): Promise<Identity | null> {
    return this.#identity(await this.#verify(token));
  }

  async resolve(ctx: HttpContext): Promise<Identity | null> {
    if (this.config.authorizationHeader) return this.#resolveAuthorization(ctx);
    const token = this.config.getToken?.(ctx) ?? null;
    if (!token) return null;
    return this.resolveToken(token);
  }

  async #resolveAuthorization(ctx: HttpContext): Promise<Identity | null> {
    const header = ctx.request.header('authorization');
    if (!header) return null;
    const [scheme, token, ...rest] = header.trim().split(/\s+/);
    if (!token || rest.length > 0) return null;

    const claims = await this.#verify(token);
    if (!claims) return null;
    const jkt = (claims.cnf as { jkt?: unknown } | undefined)?.jkt;

    switch (scheme?.toLowerCase()) {
      case 'bearer':
        // RFC 9449 §7.1: a DPoP-bound token is not a bearer token.
        return typeof jkt === 'string' ? null : this.#identity(claims);
      case 'dpop': {
        if (typeof jkt !== 'string') return null;
        const valid = await verifyDpopProof({
          proof: ctx.request.header('dpop'),
          method: ctx.request.method(),
          url: ctx.request.completeUrl(false),
          accessToken: token,
          expectedJkt: jkt,
          maxAge: this.config.dpopMaxAge ?? 300,
          replay: this.#replay,
        });
        return valid ? this.#identity(claims) : null;
      }
      default:
        return null;
    }
  }
}
