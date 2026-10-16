import type { Identity, SessionResolver } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { jwtVerify } from 'jose';
import type { OidcEndpoints } from '../discovery.js';
import { DEFAULT_ALGS, getJwks } from '../jwks.js';
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
}

export class JwtResolver implements SessionResolver {
  constructor(private config: JwtResolverConfig) {}

  /** Valida um JWT cru e monta a Identity (ou null se inválido). */
  async resolveToken(token: string): Promise<Identity | null> {
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
      return buildIdentityFromClaims(
        payload as Record<string, unknown>,
        this.config.globalRolesClaim,
      );
    } catch {
      return null;
    }
  }

  async resolve(ctx: HttpContext): Promise<Identity | null> {
    const token = this.config.getToken?.(ctx) ?? null;
    if (!token) return null;
    return this.resolveToken(token);
  }
}
