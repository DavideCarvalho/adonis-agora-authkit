/**
 * OIDC Discovery (RFC 8414 / OpenID Connect Discovery 1.0).
 *
 * The flow helpers in this package historically assumed oidc-provider's routes
 * (`/auth`, `/token`, `/jwks`…) — the authkit-server convention. Third-party IdPs
 * (Keycloak, Auth0, Okta, Entra…) use their own paths, published at
 * `{issuer}/.well-known/openid-configuration`.
 *
 * `discoverEndpoints()` resolves the IdP's real endpoints (cached per issuer).
 *
 * ```ts
 * const endpoints = await discoverEndpoints(issuer, { onError: 'throw' })
 * const url = buildAuthorizeUrl({ issuer, authorizationEndpoint: endpoints.authorizationEndpoint, ... })
 * const tokens = await exchangeCode({ issuer, tokenEndpoint: endpoints.tokenEndpoint, ... })
 * ```
 */

import { type ResiliencePolicy, resilientFetch } from './http/resilient_fetch.js';

export interface OidcEndpoints {
  /**
   * Exact issuer identifier advertised by the discovery document. Token `iss`
   * claims are compared against this value, so an IdP whose issuer carries a
   * trailing slash (Auth0: `https://tenant.auth0.com/`) validates no matter how
   * the issuer was written in the config. Absent when the endpoints did not come
   * from a discovery document.
   */
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint?: string;
  userinfoEndpoint?: string;
  introspectionEndpoint?: string;
}

/**
 * The oidc-provider (authkit-server) convention — used when discovery is off, and
 * as the per-field fallback of `onError: 'fallback'`.
 */
export function conventionEndpoints(issuer: string): OidcEndpoints {
  const base = issuer.replace(/\/$/, '');
  return {
    authorizationEndpoint: `${base}/auth`,
    tokenEndpoint: `${base}/token`,
    jwksUri: `${base}/jwks`,
    endSessionEndpoint: `${base}/session/end`,
    userinfoEndpoint: `${base}/me`,
    introspectionEndpoint: `${base}/token/introspection`,
  };
}

/** Thrown by `discoverEndpoints(..., { onError: 'throw' })` when discovery fails. */
export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    readonly issuer: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OidcDiscoveryError';
  }
}

interface CacheEntry {
  doc: DiscoveryDocument;
  fetchedAt: number;
}

/** The subset of the discovery document this package uses, already type-checked. */
interface DiscoveryDocument {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  endSessionEndpoint?: string;
  userinfoEndpoint?: string;
  introspectionEndpoint?: string;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const cache = new Map<string, CacheEntry>();

export interface DiscoverOptions {
  /** Manual overrides — win over the discovery document, field by field. */
  overrides?: Partial<OidcEndpoints>;
  /** Per-issuer cache TTL. Default: 15 min. */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * OPTIONAL resilience policy for the discovery call. Without it, it is a plain
   * `fetch` (no behaviour change).
   */
  resilience?: ResiliencePolicy;
  /**
   * What to do when the document cannot be used (network error, non-2xx, invalid
   * JSON, `issuer` mismatch, missing required endpoint):
   *
   * - `'fallback'` (default, back-compat): fall back to the authkit-server
   *   convention. Fields missing from a valid document also fall back.
   * - `'throw'`: throw {@link OidcDiscoveryError}. Optional fields missing from
   *   the document stay `undefined` instead of being guessed.
   *
   * Either way a failure is never cached — the next call retries — and a
   * previously discovered document keeps being served while refetches fail.
   */
  onError?: 'fallback' | 'throw';
}

/**
 * Resolves the IdP endpoints via `/.well-known/openid-configuration`.
 *
 * - Successful documents are cached per issuer (TTL 15 min) — safe to call per request.
 * - The document's `issuer` must match the configured one (OIDC Discovery §4.3;
 *   a trailing-slash difference is tolerated and the document's exact value is
 *   returned in `issuer`).
 * - `overrides` always win, field by field.
 */
export async function discoverEndpoints(
  issuer: string,
  options: DiscoverOptions = {},
): Promise<OidcEndpoints> {
  const base = issuer.replace(/\/$/, '');
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  const onError = options.onError ?? 'fallback';

  const cached = cache.get(base);
  let doc: DiscoveryDocument | undefined;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    doc = cached.doc;
  } else {
    try {
      doc = await fetchDiscovery(base, options.fetchImpl ?? fetch, options.resilience);
      cache.set(base, { doc, fetchedAt: Date.now() });
    } catch (error) {
      // Stale-while-error: an IdP blip must not break a client that already knows
      // the endpoints. Nothing is written, so the next call retries.
      if (cached) doc = cached.doc;
      else if (onError === 'throw') throw error;
    }
  }

  const endpoints = applyOverrides(
    doc ? fromDocument(base, doc, onError) : conventionEndpoints(base),
    options.overrides,
  );
  if (onError === 'throw') assertRequired(base, endpoints);
  return endpoints;
}

function fromDocument(
  base: string,
  doc: DiscoveryDocument,
  onError: 'fallback' | 'throw',
): OidcEndpoints {
  if (onError === 'throw') {
    // No guessing: what the document does not publish stays undefined. The three
    // required endpoints are checked by assertRequired once overrides are applied.
    return {
      issuer: doc.issuer,
      authorizationEndpoint: doc.authorizationEndpoint as string,
      tokenEndpoint: doc.tokenEndpoint as string,
      jwksUri: doc.jwksUri as string,
      endSessionEndpoint: doc.endSessionEndpoint,
      userinfoEndpoint: doc.userinfoEndpoint,
      introspectionEndpoint: doc.introspectionEndpoint,
    };
  }
  const fallback = conventionEndpoints(base);
  return {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorizationEndpoint ?? fallback.authorizationEndpoint,
    tokenEndpoint: doc.tokenEndpoint ?? fallback.tokenEndpoint,
    jwksUri: doc.jwksUri ?? fallback.jwksUri,
    endSessionEndpoint: doc.endSessionEndpoint ?? fallback.endSessionEndpoint,
    userinfoEndpoint: doc.userinfoEndpoint ?? fallback.userinfoEndpoint,
    introspectionEndpoint: doc.introspectionEndpoint ?? fallback.introspectionEndpoint,
  };
}

function applyOverrides(
  endpoints: OidcEndpoints,
  overrides: Partial<OidcEndpoints> | undefined,
): OidcEndpoints {
  if (!overrides) return endpoints;
  const merged = { ...endpoints };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

async function fetchDiscovery(
  base: string,
  fetchImpl: typeof fetch,
  resilience?: ResiliencePolicy,
): Promise<DiscoveryDocument> {
  const url = `${base}/.well-known/openid-configuration`;
  const fail = (message: string, cause?: unknown): never => {
    throw new OidcDiscoveryError(`OIDC discovery failed for ${base}: ${message}`, base, url, {
      cause,
    });
  };

  let raw: Record<string, unknown>;
  try {
    const res = await resilientFetch(
      url,
      { headers: { accept: 'application/json' } },
      resilience,
      fetchImpl,
    );
    if (!res.ok) fail(`${url} returned ${res.status}`);
    raw = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OidcDiscoveryError) throw error;
    return fail(`could not fetch ${url} (${(error as Error)?.message ?? error})`, error);
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const docIssuer = str(raw?.issuer);
  // OIDC Discovery §4.3: the document must be about the issuer we asked for —
  // otherwise tokens from another issuer would validate against its keys.
  if (!docIssuer || docIssuer.replace(/\/$/, '') !== base) {
    fail(`document issuer ${JSON.stringify(docIssuer)} does not match the configured issuer`);
  }
  return {
    issuer: docIssuer as string,
    authorizationEndpoint: str(raw.authorization_endpoint),
    tokenEndpoint: str(raw.token_endpoint),
    jwksUri: str(raw.jwks_uri),
    endSessionEndpoint: str(raw.end_session_endpoint),
    userinfoEndpoint: str(raw.userinfo_endpoint),
    introspectionEndpoint: str(raw.introspection_endpoint),
  };
}

/**
 * Throws when neither the document nor the overrides provide an endpoint the
 * login flow cannot work without. Only enforced in `onError: 'throw'` mode — the
 * fallback mode fills the gap with the convention, as it always did.
 */
function assertRequired(base: string, endpoints: OidcEndpoints): void {
  const missing = (['authorizationEndpoint', 'tokenEndpoint', 'jwksUri'] as const).filter(
    (key) => !endpoints[key],
  );
  if (missing.length) {
    throw new OidcDiscoveryError(
      `OIDC discovery failed for ${base}: document is missing ${missing.join(', ')}`,
      base,
      `${base}/.well-known/openid-configuration`,
    );
  }
}

/** Clears the discovery cache (tests). */
export function __clearDiscoveryCacheForTests(): void {
  cache.clear();
}
