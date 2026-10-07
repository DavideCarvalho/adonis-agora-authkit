import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import type { PersonalAgentRegistration, ResolvedPersonalAgentsConfig } from './config.js';

/** Quem está chamando: o agente e o usuário DELE (`sub`, opaco). */
export interface PersonalAgentIdentity {
  /** `iss` do JWT — identifica o agente; também é o `client_id` OAuth dele. */
  issuer: string;
  /** Usuário do agente. Opaco e estável; NÃO é a conta neste app. */
  sub: string;
  /** Nome de exibição do agente (registro ou host do issuer). */
  name: string;
  claims: JWTPayload;
}

/** Descoberta do modo `open`: quanto tempo um resultado vale, e quantos guardar. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHED_ISSUERS = 1000;

/** Map com teto: passando do limite, sai a entrada mais antiga (ordem de inserção). */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED_ISSUERS) map.delete(map.keys().next().value as K);
}

export interface PersonalAgentVerifierOptions {
  /** Fonte das chaves por `jwksUri`. Default: `createRemoteJWKSet` com cache. */
  getKey?: (jwksUri: string) => JWTVerifyGetKey;
  /** `fetch` da descoberta OIDC no modo `open`. Default: o global. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Extrai o token de um header `Authorization: Bearer <token>`. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function displayNameFor(registration: PersonalAgentRegistration): string {
  if (registration.name) return registration.name;
  try {
    return new URL(registration.issuer).host;
  } catch {
    return registration.issuer;
  }
}

/**
 * Verifica o JWT que um personal agent manda em `Authorization: Bearer`, com
 * as regras do protocolo configurado (PACT §3.2: ES256/RS256, vida ≤ 300 s,
 * 30 s de relógio). Devolve `null` para QUALQUER falha — o chamador responde
 * 401 sem detalhe.
 */
export class PersonalAgentVerifier {
  #cfg: ResolvedPersonalAgentsConfig;
  #getKey: (jwksUri: string) => JWTVerifyGetKey;
  #fetch: typeof fetch;
  #now: () => Date;
  #remoteSets = new Map<string, JWTVerifyGetKey>();
  #discovered = new Map<string, { result: Promise<string | null>; expiresAt: number }>();

  constructor(cfg: ResolvedPersonalAgentsConfig, options: PersonalAgentVerifierOptions = {}) {
    this.#cfg = cfg;
    this.#getKey = options.getKey ?? ((uri) => this.#remoteSet(uri));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(authorization: string | null | undefined): Promise<PersonalAgentIdentity | null> {
    const token = bearerToken(authorization);
    if (!token) return null;

    const rules = this.#cfg.protocol.identity;
    let issuer: unknown;
    try {
      if (!rules.algorithms.includes(decodeProtectedHeader(token).alg ?? '')) return null;
      issuer = decodeJwt(token).iss;
    } catch {
      return null;
    }
    if (typeof issuer !== 'string' || !issuer) return null;

    const registration = await this.#registrationFor(issuer);
    if (!registration || registration.enabled === false) return null;

    const now = this.#now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#getKey(registration.jwksUri), {
        algorithms: rules.algorithms,
        issuer: registration.issuer,
        audience: this.#cfg.audience,
        clockTolerance: rules.clockSkewSeconds,
        currentDate: now,
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch {
      return null;
    }

    // O que o `jwtVerify` não cobre: `aud` é UMA string, `iat` não está no
    // futuro além da tolerância, e a vida do token é curta.
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (typeof payload.aud !== 'string') return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (payload.iat! > nowSeconds + rules.clockSkewSeconds) return null;
    if (payload.exp! - payload.iat! > rules.maxLifetimeSeconds) return null;

    return {
      issuer: registration.issuer,
      sub: payload.sub,
      name: displayNameFor(registration),
      claims: payload,
    };
  }

  async #registrationFor(issuer: string): Promise<PersonalAgentRegistration | null> {
    const registered = await this.#cfg.resolveAgent(issuer);
    if (registered) return registered;
    if (!this.#cfg.open) return null;
    const jwksUri = await this.#discover(issuer);
    return jwksUri ? { issuer, jwksUri } : null;
  }

  /**
   * Modo `open`: `jwks_uri` via `{iss}/.well-known/openid-configuration`, só
   * HTTPS. O `iss` vem de um JWT ainda NÃO verificado, então tudo é limitado:
   * falhas também ficam em cache (um minuto — o mesmo `iss` não vira uma
   * requisição de saída por request), acertos expiram (o `jwks_uri` pode
   * mudar) e o cache tem teto de entradas.
   */
  #discover(issuer: string): Promise<string | null> {
    const now = this.#now().getTime();
    const cached = this.#discovered.get(issuer);
    if (cached && cached.expiresAt > now) return cached.result;

    const result = this.#fetchJwksUri(issuer);
    const entry = { result, expiresAt: now + DISCOVERY_TTL_MS };
    setBounded(this.#discovered, issuer, entry);
    result.then((uri) => {
      if (!uri) entry.expiresAt = now + DISCOVERY_FAILURE_TTL_MS;
    });
    return result;
  }

  async #fetchJwksUri(issuer: string): Promise<string | null> {
    try {
      const url = new URL(issuer);
      if (url.protocol !== 'https:') return null;
      const res = await this.#fetch(
        `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(5000), redirect: 'error' },
      );
      if (!res.ok) return null;
      const meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (meta.issuer !== issuer || typeof meta.jwks_uri !== 'string') return null;
      return new URL(meta.jwks_uri).protocol === 'https:' ? meta.jwks_uri : null;
    } catch {
      return null;
    }
  }

  #remoteSet(jwksUri: string): JWTVerifyGetKey {
    let set = this.#remoteSets.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri));
      setBounded(this.#remoteSets, jwksUri, set);
    }
    return set;
  }
}
