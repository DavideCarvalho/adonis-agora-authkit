import type { Identity, SessionResolver } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { getTokenFromSource, type TokenSource } from '../token_source.js';
import { buildIdentityFromClaims, introspectToken } from './identity.js';

type FetchImpl = (url: string, init: any) => Promise<{ ok: boolean; json: () => Promise<any> }>;

export interface OpaqueResolverConfig {
  /**
   * Endpoint de introspection do IdP (RFC 7662), lido a cada request. `null` (o IdP
   * não publica um, ou o discovery está falhando) resolve para nenhuma identidade.
   */
  introspectionUrl: () => Promise<string | null>;
  /** client_id usado para autenticar a introspection (client confidencial). */
  clientId: string;
  /** client_secret correspondente (Basic auth). */
  clientSecret: string;
  /** De onde tirar o access token: `session` (TokenSet) ou `bearer` (header). */
  tokenSource: TokenSource;
  /** Chave da sessão onde o TokenSet está guardado. */
  sessionKey: string;
  /** Claim que carrega os papéis globais no payload da introspection. */
  globalRolesClaim: string;
  /**
   * TTL (ms) do cache em memória de respostas `active:true`, para não introspectar
   * a cada request. Default 0 (sem cache → revogação propaga imediatamente). Suba
   * para trocar imediatismo por menos round-trips.
   */
  cacheTtlMs?: number;
  fetchImpl?: FetchImpl;
}

interface CacheEntry {
  identity: Identity;
  /** Instante (relógio de `#now()`) a partir do qual a entrada não vale mais. */
  expiresAt: number;
}

/** Teto de tokens no cache; o mais antigo sai primeiro. */
const MAX_CACHE_ENTRIES = 10_000;

/**
 * Resolver de access token OPACO via introspection padrão (RFC 7662) a cada request.
 *
 * Diferente do `jwt` (id_token stateless, sem checagem de revogação) e do `pat`
 * (token `pat_` com segredo compartilhado): aqui o access token opaco emitido pelo
 * fluxo OIDC é introspectado no IdP a cada request, então uma revogação no IdP
 * derruba a sessão do app imediatamente (no próximo request, ou após o `cacheTtlMs`).
 */
export class OpaqueResolver implements SessionResolver {
  #cache = new Map<string, CacheEntry>();

  constructor(private config: OpaqueResolverConfig) {}

  #getToken(ctx: HttpContext): string | null {
    if (this.config.tokenSource === 'bearer') {
      return getTokenFromSource(ctx, 'bearer', this.config.sessionKey);
    }
    // session: introspectamos o ACCESS token (não o id_token).
    const tokenSet = (ctx as any).session?.get(this.config.sessionKey) as
      | { accessToken?: string }
      | undefined;
    return tokenSet?.accessToken ?? null;
  }

  async resolve(ctx: HttpContext): Promise<Identity | null> {
    const token = this.#getToken(ctx);
    if (!token) return null;

    const ttl = this.config.cacheTtlMs ?? 0;
    if (ttl > 0) {
      const hit = this.#cache.get(token);
      if (hit && this.#now() < hit.expiresAt) return hit.identity;
      if (hit) this.#cache.delete(token);
    }

    const introspectionUrl = await this.config.introspectionUrl();
    if (!introspectionUrl) return null;

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    const data = await introspectToken(
      introspectionUrl,
      token,
      { type: 'basic', value: basic },
      { tokenTypeHint: 'access_token', fetchImpl: this.config.fetchImpl },
    );
    if (!data) {
      this.#cache.delete(token);
      return null;
    }

    const identity = buildIdentityFromClaims(data, this.config.globalRolesClaim);

    if (ttl > 0) this.#store(token, identity, ttl, data.exp);
    return identity;
  }

  /**
   * Guarda a identidade por `ttl`, nunca além do `exp` do token: um token que
   * expira antes do TTL deixa de resolver quando expira, não quando o cache vence.
   */
  #store(token: string, identity: Identity, ttl: number, exp: unknown): void {
    const lifetime = typeof exp === 'number' ? Math.min(ttl, exp * 1000 - Date.now()) : ttl;
    if (lifetime <= 0) return;
    const now = this.#now();
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      for (const [key, entry] of this.#cache) {
        if (entry.expiresAt <= now) this.#cache.delete(key);
      }
      for (const key of this.#cache.keys()) {
        if (this.#cache.size < MAX_CACHE_ENTRIES) break;
        this.#cache.delete(key);
      }
    }
    this.#cache.delete(token);
    this.#cache.set(token, { identity, expiresAt: now + lifetime });
  }

  /** Relógio monotônico de processo (evita Date.* direto; testável). */
  #now(): number {
    return Math.trunc(performance.now());
  }
}
