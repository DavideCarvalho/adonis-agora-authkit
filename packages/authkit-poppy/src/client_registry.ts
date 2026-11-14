/**
 * Identidade do personal agent no Poppy (§4.1): o `client_id` é uma URL HTTPS
 * que devolve o documento de metadata do agente (OAuth Client ID Metadata
 * Document). Buscamos (à prova de SSRF), validamos, guardamos em cache e
 * importamos as chaves públicas do `jwks_uri`.
 */
import {
  insecureDevFetchJson,
  isHttpsUrl,
  type JsonFetcher,
  MetadataDocumentCache,
  safeFetchJson,
} from '@adonis-agora/authkit-server';
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import type { ResolvedPoppyConfig } from './config.js';
import { PoppyError } from './errors.js';

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

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Loopback redirect URI (RFC 8252 §7.3): `http`, IP de loopback literal, sem fragmento. */
function isLoopbackRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * `redirect_uri` igual a uma entrada de `redirect_uris`; numa loopback redirect URI a porta não
 * conta (§4.2, RFC 8252 §7.3).
 */
export function redirectUriAllowed(registered: string[], redirectUri: string): boolean {
  if (registered.includes(redirectUri)) return true;
  if (!isLoopbackRedirect(redirectUri)) return false;
  const withoutPort = (value: string) => {
    const url = new URL(value);
    url.port = '';
    return url.toString();
  };
  return registered.some(
    (r) => isLoopbackRedirect(r) && withoutPort(r) === withoutPort(redirectUri),
  );
}

/** Valida um documento de metadata e devolve os campos usados. Lança `invalid_client`. */
export function validateClientMetadata(
  fetchedFrom: string,
  doc: unknown,
  options: { allowHttp?: boolean } = {},
): Omit<PoppyClient, 'keys'> {
  const allowHttp = options.allowHttp === true;
  const bad = (why: string) => new PoppyError('invalid_client', `client metadata: ${why}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== fetchedFrom) throw bad('client_id must equal the URL it was fetched from');
  const host = hostOf(fetchedFrom);
  if (!isHttpsUrl(d.jwks_uri, allowHttp) || hostOf(d.jwks_uri) !== host) {
    throw bad('jwks_uri must be an HTTPS URL on the same domain as client_id');
  }
  const redirects = d.redirect_uris ?? [];
  if (!Array.isArray(redirects)) throw bad('redirect_uris must be an array');
  for (const uri of redirects) {
    if (isLoopbackRedirect(uri)) continue;
    if (!isHttpsUrl(uri, allowHttp) || hostOf(uri) !== host) {
      throw bad(
        'every redirect_uri must be an HTTPS URL on the same domain as client_id, or a loopback URI',
      );
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
    logoUri: isHttpsUrl(d.logo_uri, allowHttp) ? d.logo_uri : null,
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
  /** Busca de JSON. Default: `safeFetchJson` do `@adonis-agora/authkit-server`. */
  fetchJson?: JsonFetcher;
  now?: () => number;
}

/**
 * Resolve e valida agentes pelo `client_id`, com cache (respeita `max-age`,
 * entre 1 min e 24 h; falhas ficam 1 min em cache para que o mesmo `client_id`
 * não vire uma busca de saída por request). A busca à prova de SSRF e o cache de
 * documentos são os do `@adonis-agora/authkit-server` (Client ID Metadata Documents).
 */
export class PoppyClientRegistry {
  #cfg: ResolvedPoppyConfig;
  #clients: MetadataDocumentCache<Omit<PoppyClient, 'keys'>>;
  #jwks: MetadataDocumentCache<JSONWebKeySet>;

  constructor(cfg: ResolvedPoppyConfig, options: PoppyClientRegistryOptions = {}) {
    this.#cfg = cfg;
    const fetchJson: JsonFetcher =
      options.fetchJson ??
      (cfg.allowInsecureClientIds
        ? (url) => insecureDevFetchJson(url, { userAgent: 'authkit-poppy/0.3' })
        : (url) => safeFetchJson(url, { userAgent: 'authkit-poppy/0.3' }));
    const common = { fetchJson, now: options.now, ttl: { min: 60, max: 86_400, fallback: 3600 } };
    this.#clients = new MetadataDocumentCache({
      ...common,
      validate: (url, body) =>
        validateClientMetadata(url, body, { allowHttp: this.#cfg.allowInsecureClientIds }),
      fetchError: (_url, why) => new PoppyError('invalid_client', `client metadata: ${why}`),
    });
    this.#jwks = new MetadataDocumentCache({
      ...common,
      validate: (_url, body) => validateJwks(body),
      fetchError: (_url, why) => new PoppyError('invalid_client', `jwks_uri: ${why}`),
      // Releitura do JWKS quando o `kid` não está no conjunto em cache — no máximo a cada 30 s.
      refreshCooldown: 30,
    });
  }

  /**
   * O agente, ou `invalid_client`: `client_id` não é HTTPS, bloqueado, não
   * registrado (quando o app exige registro), metadata inválida/inalcançável.
   */
  async resolve(clientId: unknown): Promise<PoppyClient> {
    if (!isHttpsUrl(clientId, this.#cfg.allowInsecureClientIds)) {
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
    const meta = await this.#clients.get(clientId);
    return { ...meta, keys: this.#keySet(meta.jwksUri) };
  }

  /** Nome de exibição sem falhar (console de conta): metadata em cache/buscada, ou o host. */
  async displayName(clientId: string): Promise<string> {
    try {
      return (await this.#clients.get(clientId)).name;
    } catch {
      return hostOf(clientId) ?? clientId;
    }
  }

  /** `JWTVerifyGetKey` que relê o JWKS uma vez quando o `kid` é desconhecido (rotação). */
  #keySet(jwksUri: string): JWTVerifyGetKey {
    return async (header, token) => {
      const jwks = await this.#jwks.get(jwksUri);
      try {
        return await createLocalJWKSet(jwks)(header, token);
      } catch (error) {
        const refreshed = await this.#jwks.get(jwksUri, { force: true });
        if (refreshed === jwks) throw error;
        return createLocalJWKSet(refreshed)(header, token);
      }
    };
  }
}
