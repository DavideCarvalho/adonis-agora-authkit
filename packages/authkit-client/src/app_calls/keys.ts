/**
 * The app key directory on the authkit server (the Hub): an app publishes its own public keys
 * (`PUT /api/apps/keys`) and the other apps read them (`GET /api/apps/:app/keys?purpose=`), both
 * with this app's service client id and secret. It is how Agora libs share a public key between
 * apps without copying it into config — e.g. the federated console reads the key an app seals
 * commands to, published under `console:<lib>`. The trust is the Hub's: the key was published by
 * that app's own authenticated client and is served over an authenticated API.
 */

/** A public OKP JWK (Ed25519 / X25519 …). Never carries `d`. */
export interface OkpJwk {
  kty: 'OKP';
  crv: string;
  x: string;
  kid?: string;
  use?: string;
  alg?: string;
  key_ops?: string[];
}

/** Default path of the publish endpoint, on the issuer's origin. */
export const APP_KEYS_PATH = '/api/apps/keys';
/** Same rule as the server. */
export const KEY_PURPOSE_PATTERN = /^[a-z0-9:_-]{1,64}$/;
/** How long a fetched key is trusted before asking the Hub again. */
export const APP_KEY_CACHE_MS = 5 * 60_000;
/** When a failed publish is tried again: 10 s, 1 min, 5 min. */
export const APP_KEY_RETRY_DELAYS_MS: readonly number[] = [10_000, 60_000, 300_000];

interface LoggerLike {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface AppKeysClientOptions {
  /** The authkit issuer; the endpoints are on its origin. */
  issuer: string;
  /** This app's service-tenant client. */
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch | undefined;
  logger?: LoggerLike | undefined;
  timeoutMs?: number | undefined;
  retryDelaysMs?: readonly number[] | undefined;
  cacheMs?: number | undefined;
  now?: (() => number) | undefined;
}

/** Why a JWK cannot be published, or `null` when it is a public OKP key. */
export function publicOkpProblem(jwk: unknown): string | null {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return 'the jwk must be an object';
  const k = jwk as Record<string, unknown>;
  if ('d' in k) return 'it carries `d` (a private key): publish the public JWK only';
  if (k.kty !== 'OKP') return 'only OKP keys (`kty: "OKP"`) can be published';
  if (typeof k.crv !== 'string' || typeof k.x !== 'string') return 'the jwk needs `crv` and `x`';
  return null;
}

/** What fixes a failed publish, by HTTP status (`undefined`: no response). */
export function publishFix(status: number | undefined, endpoint: string): string {
  if (status === undefined) {
    return `the authkit server is unreachable at ${endpoint}; check \`issuer\` in config/authkit_client.ts and that the server is up.`;
  }
  if (status === 401) {
    return 'the server did not accept service.clientId/clientSecret; check them in config/authkit_client.ts and that the client is an enabled service tenant on the authkit server.';
  }
  if (status === 404) {
    return 'the authkit server does not serve the key directory; upgrade @adonis-agora/authkit-server there (and do not pass registerAuthHost({ appKeys: false })).';
  }
  if (status === 422) return 'the server refused the key (see `detail`).';
  if (status === 503) {
    return 'the authkit server cannot store keys (its auth_app_keys table is missing, or it has no database); run `node ace agora:doctor` on the authkit server.';
  }
  return 'the authkit server failed; its log has the details (`node ace agora:doctor` there checks its tables).';
}

/** Publishes and reads keys of the app key directory. */
export class AppKeysClient {
  #o: AppKeysClientOptions;
  #cache = new Map<string, { jwk: OkpJwk; at: number }>();
  #inflight = new Map<string, Promise<OkpJwk | null>>();
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: AppKeysClientOptions) {
    this.#o = options;
  }

  get #fetch(): typeof globalThis.fetch {
    return this.#o.fetch ?? globalThis.fetch;
  }

  get #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #headers(): Record<string, string> {
    const basic = Buffer.from(
      `${encodeURIComponent(this.#o.clientId)}:${encodeURIComponent(this.#o.clientSecret)}`,
    ).toString('base64');
    return { authorization: `Basic ${basic}`, accept: 'application/json' };
  }

  /**
   * Publishes `jwk` under `purpose`, replacing this app's keys for that purpose. Resolves after
   * the first attempt; a failure is retried in the background (10 s, 1 min, 5 min). Never rejects:
   * an invalid key or a refusal is logged.
   */
  async publish(input: { purpose: string; jwk: OkpJwk }): Promise<void> {
    if (!KEY_PURPOSE_PATTERN.test(String(input?.purpose))) {
      this.#o.logger?.warn(
        { purpose: input?.purpose },
        `authkit: publishAppKey: purpose must match ${KEY_PURPOSE_PATTERN} (e.g. "console:durable"); not published`,
      );
      return;
    }
    const problem = publicOkpProblem(input.jwk);
    if (problem) {
      this.#o.logger?.warn(
        { purpose: input.purpose },
        `authkit: publishAppKey: ${problem}; not published`,
      );
      return;
    }
    const delays = this.#o.retryDelaysMs ?? APP_KEY_RETRY_DELAYS_MS;
    const endpoint = new URL(APP_KEYS_PATH, this.#o.issuer).href;
    let warned = false;
    /** One warning per publish, at the first failure: the status and what fixes it. */
    const warnOnce = (status: number | undefined, detail: unknown, retrying: boolean) => {
      if (warned) return;
      warned = true;
      this.#o.logger?.warn(
        { status, purpose: input.purpose, endpoint, ...(detail ? { detail } : {}) },
        `authkit: could not publish the app key "${input.purpose}" (${status ? `HTTP ${status}` : 'no response'}): ${publishFix(status, endpoint)}${retrying ? ' Retrying in the background.' : ''}`,
      );
    };
    const attempt = async (n: number): Promise<void> => {
      let status: number | undefined;
      let detail: unknown;
      try {
        const res = await this.#fetch(endpoint, {
          method: 'PUT',
          headers: { ...this.#headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ keys: [{ purpose: input.purpose, jwk: input.jwk }] }),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
        });
        status = res.status;
        const body =
          status >= 400
            ? ((await res.json().catch(() => null)) as { message?: unknown } | null)
            : null;
        await res.body?.cancel().catch(() => {});
        if (status >= 200 && status < 300) {
          this.#o.logger?.info?.({ purpose: input.purpose }, 'authkit: published the app key');
          return;
        }
        detail = body?.message;
        // Credentials or key refused: trying again gets the same answer.
        if (status === 401 || status === 404 || status === 422) {
          warnOnce(status, detail, false);
          return;
        }
      } catch (error) {
        detail = (error as Error)?.message ?? String(error);
      }
      const delay = delays[n];
      warnOnce(status, detail, delay !== undefined);
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void attempt(n + 1);
      }, delay);
      timer.unref?.();
      this.#timers.add(timer);
    };
    await attempt(0);
  }

  /**
   * The app's current public key for `purpose` (the first it published), or `null` when it
   * published none. Cached for 5 minutes; a miss or an error asks again on the next call (an
   * error returns the last key seen, when there is one).
   */
  async get(input: { app: string; purpose: string }): Promise<OkpJwk | null> {
    const id = `${input.app}\u0000${input.purpose}`;
    const cached = this.#cache.get(id);
    if (cached && this.#now - cached.at < (this.#o.cacheMs ?? APP_KEY_CACHE_MS)) return cached.jwk;
    const pending = this.#inflight.get(id);
    if (pending) return pending;
    const request = this.#fetchKey(input, cached?.jwk ?? null).finally(() =>
      this.#inflight.delete(id),
    );
    this.#inflight.set(id, request);
    return request;
  }

  async #fetchKey(
    input: { app: string; purpose: string },
    stale: OkpJwk | null,
  ): Promise<OkpJwk | null> {
    const id = `${input.app}\u0000${input.purpose}`;
    const url = new URL(
      `/api/apps/${encodeURIComponent(input.app)}/keys?purpose=${encodeURIComponent(input.purpose)}`,
      this.#o.issuer,
    );
    try {
      const res = await this.#fetch(url.href, {
        headers: this.#headers(),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        this.#cache.delete(id);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      const jwk = Array.isArray(body.keys)
        ? (body.keys.find((k) => publicOkpProblem(k) === null) as OkpJwk | undefined)
        : undefined;
      if (!jwk) {
        this.#cache.delete(id);
        return null;
      }
      this.#cache.set(id, { jwk, at: this.#now });
      return jwk;
    } catch (error) {
      this.#o.logger?.warn(
        { err: error, app: input.app, purpose: input.purpose },
        'authkit: could not read the app key from the server',
      );
      return stale;
    }
  }

  /** Stops pending publish retries. */
  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
