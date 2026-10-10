import type { DpopKey } from './dpop.js';
import { PoppyError } from './errors.js';
import { type FetchLike, parseRetryAfter, sleep, wwwAuthError } from './util.js';

export interface HttpOptions {
  fetch?: FetchLike;
  /** Longest `Retry-After` we wait out automatically before giving up (seconds). */
  maxRetryAfterSeconds?: number;
  log?: (line: string) => void;
}

export interface PoppyRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * The body, or a builder called once per attempt. Token requests pass a builder so each
   * retry carries brand-new assertions (fresh `jti`s), never a replayed one.
   */
  body?: string | (() => Promise<string>);
  /** Signs a DPoP proof for every attempt when set. */
  dpop?: DpopKey;
  /** Sent as `Authorization: {scheme} {token}`. Never put in the URL (4.3). */
  accessToken?: string;
  scheme?: 'DPoP' | 'Bearer';
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual' | 'error';
}

/**
 * The one place requests leave this client. It signs DPoP proofs, remembers `DPoP-Nonce`
 * values per origin and retries once on `use_dpop_nonce` (RFC 9449 section 8/9), and waits
 * out a 429 `Retry-After` once (4.3, "Rate limits").
 */
export class PoppyHttp {
  readonly fetch: FetchLike;
  private readonly nonces = new Map<string, string>();
  private readonly maxRetryAfter: number;
  private readonly log?: (line: string) => void;

  constructor(opts: HttpOptions = {}) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetryAfter = opts.maxRetryAfterSeconds ?? 30;
    this.log = opts.log;
  }

  async request(url: string, init: PoppyRequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const origin = new URL(url).origin;
    let nonceRetried = false;
    let rateRetried = false;
    for (;;) {
      const headers = new Headers(init.headers);
      const scheme = init.scheme ?? (init.dpop ? 'DPoP' : 'Bearer');
      if (init.accessToken) headers.set('authorization', `${scheme} ${init.accessToken}`);
      if (init.dpop) {
        headers.set(
          'dpop',
          await init.dpop.proof({
            htm: method,
            htu: url,
            accessToken: scheme === 'DPoP' ? init.accessToken : undefined,
            nonce: this.nonces.get(origin),
          }),
        );
      }
      const body = typeof init.body === 'function' ? await init.body() : init.body;
      const res = await this.fetch(url, {
        method,
        headers,
        body,
        signal: init.signal,
        // A redirect would change `htu`, so DPoP requests never follow one silently.
        redirect: init.redirect ?? (init.dpop ? 'manual' : 'follow'),
      });

      const nonce = res.headers.get('dpop-nonce');
      if (nonce) this.nonces.set(origin, nonce);

      if (init.dpop && nonce && !nonceRetried && (await isUseDpopNonce(res))) {
        nonceRetried = true;
        this.log?.(`DPoP nonce required by ${origin}; retrying with the nonce`);
        continue;
      }

      if (res.status === 429 && !rateRetried) {
        const wait = parseRetryAfter(res.headers.get('retry-after'));
        if (wait !== undefined && wait <= this.maxRetryAfter) {
          rateRetried = true;
          this.log?.(`rate limited by ${origin}; waiting ${wait}s (Retry-After)`);
          await sleep(wait * 1000, init.signal);
          continue;
        }
        throw new PoppyError('rate_limited', `rate limited by ${origin}`, {
          status: 429,
          details: { retry_after: wait },
        });
      }
      return res;
    }
  }
}

async function isUseDpopNonce(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 401) return false;
  if (wwwAuthError(res.headers.get('www-authenticate')).error === 'use_dpop_nonce') return true;
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body?.error === 'use_dpop_nonce';
  } catch {
    return false;
  }
}

/** Reads a JSON body, tolerating an empty one. */
export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T | undefined> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
