/**
 * The token a service tenant presents to its control plane (e.g. durable's
 * `tenant.token`): a `client_credentials` JWT access token for one resource (RFC 8707),
 * fetched from the authkit issuer, cached, and refreshed before it expires.
 */

import { discoverEndpoints } from './discovery.js';

export interface AuthkitTenantTokenOptions {
  /** Issuer URL of the authkit server (the `issuer` in its config/authkit.ts). */
  issuer: string;
  /** Client id of the service-tenant client. */
  clientId: string;
  /** Client secret of the service-tenant client. */
  clientSecret: string;
  /**
   * Resource indicator the token is for (one of `serviceTenants.resources` on the
   * server). Optional when the server declares exactly one.
   */
  resource?: string;
  /** Space-separated scopes to request. Default: none. */
  scope?: string;
  /** Refresh this many seconds before the token expires. Default: 60. */
  refreshSkewSec?: number;
  /** Token endpoint. Default: `token_endpoint` from the issuer's discovery document. */
  tokenEndpoint?: string;
  /** Custom `fetch` (proxy, tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Abort a token request after this many ms. Default: 10 000. */
  timeoutMs?: number;
}

/** Thrown when the token endpoint refuses the credentials or cannot be reached. */
export class TenantTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TenantTokenError';
  }
}

interface CachedToken {
  value: string;
  /** Epoch ms after which a new token is fetched. */
  refreshAt: number;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Fetches and caches a service-tenant token. One request at a time (concurrent callers
 * share it); after a failure, callers get the same error until a backoff (500 ms,
 * doubling, capped at 30 s) runs out, unless the cached token is still valid, which is
 * then served instead. Never logs or exposes the secret or the token in errors.
 *
 * Satisfies durable's `TenantCredentialsContract` (`token()`).
 */
export class AuthkitTenantToken {
  #options: AuthkitTenantTokenOptions;
  #cached: CachedToken | undefined;
  #inflight: Promise<string> | undefined;
  #failures = 0;
  #retryAt = 0;
  #lastError: unknown;
  /** Bumped by `reset()`: a fetch started before it does not touch the new state. */
  #generation = 0;

  constructor(options: AuthkitTenantTokenOptions) {
    if (!options?.issuer || !options.clientId || !options.clientSecret) {
      throw new TypeError('authkitTenantToken: issuer, clientId and clientSecret are required');
    }
    this.#options = options;
  }

  /** The current token: cached while fresh, fetched (single-flight) otherwise. */
  async token(): Promise<string> {
    const now = Date.now();
    const cached = this.#cached;
    if (cached && now < cached.refreshAt) return cached.value;
    let pending = this.#inflight;
    if (!pending) {
      if (now < this.#retryAt) {
        if (cached && now < cached.expiresAt) return cached.value;
        throw this.#lastError;
      }
      const started: Promise<string> = this.#fetch().finally(() => {
        if (this.#inflight === started) this.#inflight = undefined;
      });
      this.#inflight = started;
      pending = started;
    }
    // Still-valid token while refreshing early: a failed refresh breaks no caller,
    // whether it started the refresh or joined it.
    if (cached && now < cached.expiresAt) {
      return pending.catch(() => {
        if (Date.now() < cached.expiresAt) return cached.value;
        throw this.#lastError;
      });
    }
    return pending;
  }

  /** Drops the cached token: the next `token()` fetches a new one. */
  reset(): void {
    this.#generation += 1;
    this.#cached = undefined;
    this.#inflight = undefined;
    this.#failures = 0;
    this.#retryAt = 0;
    this.#lastError = undefined;
  }

  async #fetch(): Promise<string> {
    const generation = this.#generation;
    try {
      const { value, cached } = await this.#request();
      if (generation !== this.#generation) return value;
      this.#cached = cached;
      this.#failures = 0;
      this.#retryAt = 0;
      this.#lastError = undefined;
      return value;
    } catch (error) {
      if (generation !== this.#generation) throw error;
      this.#failures += 1;
      const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.#failures - 1));
      this.#retryAt = Date.now() + delay;
      this.#lastError = error;
      throw error;
    }
  }

  async #request(): Promise<{ value: string; cached: CachedToken }> {
    const o = this.#options;
    const doFetch = o.fetch ?? globalThis.fetch;
    let endpoint = o.tokenEndpoint;
    if (!endpoint) {
      try {
        endpoint = (
          await discoverEndpoints(o.issuer, {
            onError: 'fallback',
            ...(o.fetch ? { fetchImpl: o.fetch } : {}),
          })
        ).tokenEndpoint;
      } catch (cause) {
        throw new TenantTokenError('could not resolve the token endpoint', undefined, undefined, {
          cause,
        });
      }
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (o.resource) body.set('resource', o.resource);
    if (o.scope) body.set('scope', o.scope);
    // RFC 6749 §2.3.1: form-urlencode id and secret before Basic.
    const basic = Buffer.from(
      `${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`,
    ).toString('base64');

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
    } catch (cause) {
      throw new TenantTokenError(
        `token request to ${endpoint} failed: ${(cause as Error)?.name ?? 'Error'}`,
        undefined,
        undefined,
        { cause },
      );
    }

    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // A non-JSON body is reported by status below.
    }
    if (!res.ok) {
      const code = typeof json.error === 'string' ? json.error : undefined;
      const description =
        typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
      throw new TenantTokenError(
        `token endpoint answered ${res.status}${code ? ` ${code}` : ''}${description}`,
        res.status,
        code,
      );
    }
    const value = json.access_token;
    if (typeof value !== 'string' || !value) {
      throw new TenantTokenError('token endpoint answered without an access_token', res.status);
    }
    const expiresIn =
      typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 60;
    const expiresAt = startedAt + expiresIn * 1000;
    const skew = Math.min((o.refreshSkewSec ?? 60) * 1000, (expiresIn * 1000) / 2);
    return { value, cached: { value, expiresAt, refreshAt: expiresAt - skew } };
  }
}

/** A token provider usable both as a function and as an object with `token()`. */
export type AuthkitTenantTokenFn = (() => Promise<string>) & {
  token(): Promise<string>;
  reset(): void;
};

/**
 * The token function for a service-tenant process:
 *
 * ```ts
 * // config/durable.ts (tenant process)
 * tenant: {
 *   token: authkitTenantToken({
 *     issuer: env.get('AUTHKIT_ISSUER'),
 *     clientId: env.get('TENANT_CLIENT_ID'),
 *     clientSecret: env.get('TENANT_CLIENT_SECRET'),
 *     resource: 'urn:agora:durable',
 *   }),
 * }
 * ```
 *
 * The result is a function (`() => Promise<string>`) that also has `token()` (durable's
 * `TenantCredentialsContract`).
 */
export function authkitTenantToken(options: AuthkitTenantTokenOptions): AuthkitTenantTokenFn {
  const source = new AuthkitTenantToken(options);
  const token = () => source.token();
  return Object.assign(token, { token, reset: () => source.reset() });
}
