/**
 * Identidade do personal agent no Poppy (§4.1): o `client_id` é uma URL HTTPS
 * que devolve o documento de metadata do agente (OAuth Client ID Metadata
 * Document). Buscamos (à prova de SSRF), validamos, guardamos em cache e
 * importamos as chaves públicas do `jwks_uri`.
 */
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import type { ResolvedPoppyConfig } from './config.js';
import { PoppyError } from './errors.js';
import { type JsonFetcher, SafeFetchError, safeFetchJson } from './safe_fetch.js';

export interface PoppyClient {
  clientId: string;
  /** `client_name`, ou o host do `client_id`. */
  name: string;
  logoUri: string | null;
  jwksUri: string;
  redirectUris: string[];
  extensions: Record<string, unknown>;
  /** Chaves públicas do `jwks_uri`. */
  keys: JWTVerifyGetKey;
}

const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_TTL_MS = 3600 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHED = 1000;
/** Releitura do JWKS quando o `kid` não está no conjunto em cache — no máximo a cada 30 s. */
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function ttlFrom(maxAge: number | null): number {
  if (maxAge === null) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, maxAge * 1000));
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED) map.delete(map.keys().next().value as K);
}

/** Valida um documento de metadata e devolve os campos usados. Lança `invalid_client`. */
export function validateClientMetadata(
  fetchedFrom: string,
  doc: unknown,
): Omit<PoppyClient, 'keys'> {
  const bad = (why: string) => new PoppyError('invalid_client', `client metadata: ${why}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== fetchedFrom) throw bad('client_id must equal the URL it was fetched from');
  const host = hostOf(fetchedFrom);
  if (!isHttpsUrl(d.jwks_uri) || hostOf(d.jwks_uri) !== host) {
    throw bad('jwks_uri must be an HTTPS URL on the same domain as client_id');
  }
  const redirects = d.redirect_uris ?? [];
  if (!Array.isArray(redirects)) throw bad('redirect_uris must be an array');
  for (const uri of redirects) {
    if (!isHttpsUrl(uri) || hostOf(uri) !== host) {
      throw bad('every redirect_uri must be an HTTPS URL on the same domain as client_id');
    }
  }
  if (d.token_endpoint_auth_method !== 'private_key_jwt') {
    throw bad('token_endpoint_auth_method must be private_key_jwt');
  }
  if (d.jwks !== undefined) throw bad('keys are published at jwks_uri only');
  const name = typeof d.client_name === 'string' && d.client_name.trim() ? d.client_name : host!;
  const extensions =
    d.extensions && typeof d.extensions === 'object' && !Array.isArray(d.extensions)
      ? (d.extensions as Record<string, unknown>)
      : {};
  return {
    clientId: fetchedFrom,
    name: name.slice(0, 200),
    logoUri: isHttpsUrl(d.logo_uri) ? d.logo_uri : null,
    jwksUri: d.jwks_uri,
    redirectUris: redirects as string[],
    extensions,
  };
}

/** Só chaves públicas (§4.1) e pelo menos uma. */
function validateJwks(doc: unknown): JSONWebKeySet {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new PoppyError('invalid_client', 'jwks_uri must serve a non-empty JWK set');
  }
  for (const key of keys) {
    if (!key || typeof key !== 'object') throw new PoppyError('invalid_client', 'invalid JWK');
    const k = key as Record<string, unknown>;
    if ('d' in k || 'p' in k || 'q' in k || k.kty === 'oct') {
      throw new PoppyError('invalid_client', 'jwks_uri must contain only public keys');
    }
  }
  return { keys: keys as JSONWebKeySet['keys'] };
}

export interface PoppyClientRegistryOptions {
  /** Busca de JSON. Default: {@link safeFetchJson}. */
  fetchJson?: JsonFetcher;
  now?: () => number;
}

interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

/**
 * Resolve e valida agentes pelo `client_id`, com cache (respeita `max-age`,
 * entre 1 min e 24 h; falhas ficam 1 min em cache para que o mesmo `client_id`
 * não vire uma busca de saída por request).
 */
export class PoppyClientRegistry {
  #cfg: ResolvedPoppyConfig;
  #fetch: JsonFetcher;
  #now: () => number;
  #clients = new Map<string, CacheEntry<Omit<PoppyClient, 'keys'>>>();
  #jwks = new Map<string, CacheEntry<JSONWebKeySet> & { fetchedAt: number }>();

  constructor(cfg: ResolvedPoppyConfig, options: PoppyClientRegistryOptions = {}) {
    this.#cfg = cfg;
    this.#fetch = options.fetchJson ?? ((url) => safeFetchJson(url));
    this.#now = options.now ?? Date.now;
  }

  /**
   * O agente, ou `invalid_client`: `client_id` não é HTTPS, bloqueado, não
   * registrado (quando o app exige registro), metadata inválida/inalcançável.
   */
  async resolve(clientId: unknown): Promise<PoppyClient> {
    if (!isHttpsUrl(clientId)) {
      throw new PoppyError('invalid_client', 'client_id must be an HTTPS URL');
    }
    if (await this.#cfg.clients.isBlocked(clientId)) {
      throw new PoppyError('invalid_client', 'client_id is blocked');
    }
    if (
      this.#cfg.clients.requireRegistration &&
      !(await this.#cfg.clients.isRegistered(clientId))
    ) {
      throw new PoppyError('invalid_client', 'client_id is not registered');
    }
    const meta = await this.#metadata(clientId);
    return { ...meta, keys: this.#keySet(meta.jwksUri) };
  }

  /** Nome de exibição sem falhar (console de conta): metadata em cache/buscada, ou o host. */
  async displayName(clientId: string): Promise<string> {
    try {
      return (await this.#metadata(clientId)).name;
    } catch {
      return hostOf(clientId) ?? clientId;
    }
  }

  #metadata(clientId: string): Promise<Omit<PoppyClient, 'keys'>> {
    const now = this.#now();
    const cached = this.#clients.get(clientId);
    if (cached && cached.expiresAt > now) return cached.value;
    const entry: CacheEntry<Omit<PoppyClient, 'keys'>> = {
      value: Promise.resolve(null as any),
      expiresAt: now + FAILURE_TTL_MS,
    };
    entry.value = (async () => {
      let fetched: Awaited<ReturnType<JsonFetcher>>;
      try {
        fetched = await this.#fetch(clientId);
      } catch (error) {
        const why = error instanceof SafeFetchError ? error.message : 'unreachable';
        throw new PoppyError('invalid_client', `client metadata: ${why}`);
      }
      const meta = validateClientMetadata(clientId, fetched.body);
      entry.expiresAt = this.#now() + ttlFrom(fetched.maxAge);
      return meta;
    })();
    entry.value.catch(() => {
      entry.expiresAt = this.#now() + FAILURE_TTL_MS;
    });
    setBounded(this.#clients, clientId, entry);
    return entry.value;
  }

  #fetchJwks(jwksUri: string, force: boolean): Promise<JSONWebKeySet> {
    const now = this.#now();
    const cached = this.#jwks.get(jwksUri);
    if (cached && cached.expiresAt > now && !force) return cached.value;
    if (cached && force && now - cached.fetchedAt < JWKS_REFRESH_COOLDOWN_MS) return cached.value;
    const entry = {
      value: Promise.resolve({ keys: [] } as JSONWebKeySet),
      expiresAt: now + FAILURE_TTL_MS,
      fetchedAt: now,
    };
    entry.value = (async () => {
      let fetched: Awaited<ReturnType<JsonFetcher>>;
      try {
        fetched = await this.#fetch(jwksUri);
      } catch (error) {
        const why = error instanceof SafeFetchError ? error.message : 'unreachable';
        throw new PoppyError('invalid_client', `jwks_uri: ${why}`);
      }
      const jwks = validateJwks(fetched.body);
      entry.expiresAt = this.#now() + ttlFrom(fetched.maxAge);
      return jwks;
    })();
    entry.value.catch(() => {
      entry.expiresAt = this.#now() + FAILURE_TTL_MS;
    });
    setBounded(this.#jwks, jwksUri, entry);
    return entry.value;
  }

  /** `JWTVerifyGetKey` que relê o JWKS uma vez quando o `kid` é desconhecido (rotação). */
  #keySet(jwksUri: string): JWTVerifyGetKey {
    return async (header, token) => {
      const jwks = await this.#fetchJwks(jwksUri, false);
      try {
        return await createLocalJWKSet(jwks)(header, token);
      } catch (error) {
        const refreshed = await this.#fetchJwks(jwksUri, true);
        if (refreshed === jwks) throw error;
        return createLocalJWKSet(refreshed)(header, token);
      }
    };
  }
}
