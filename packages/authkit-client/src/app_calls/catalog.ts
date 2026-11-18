/**
 * This app's permission catalog: what it accepts from the other apps, published to the authkit
 * server (the Hub) at start so the console's "Apps it can call" offers it when someone grants
 * another app access here. Where the list comes from (`service.catalog`):
 *
 * - `@adonis-agora/authz` in the app (default): `authz.permissionCatalog()`, read from the global
 *   slot authz publishes at boot, so this package never imports authz;
 * - a function of your own (your RBAC tables, a constant list…);
 * - `false`: nothing is published. Calls between apps still work: the token says who is calling.
 *
 * Nothing here grants anything: grants stay on the Hub (`authkit:client grant-app`).
 */

/** Where the catalog comes from. See the module doc. */
export type AppCatalogSource =
  | 'authz'
  | false
  | (() => readonly string[] | Promise<readonly string[]>);

/** Default path of the publish endpoint, on the issuer's origin. */
export const APP_CATALOG_PATH = '/api/apps/catalog';

/** The slot `@adonis-agora/authz` publishes its catalog reader on. */
const AUTHZ_CATALOG_SLOT = Symbol.for('@adonis-agora/authz:catalog');

/** Same rule as the server's capabilities. */
const CAPABILITY = /^[A-Za-z0-9*][A-Za-z0-9._:*/-]{0,127}$/;
/** The server keeps at most this many per app. */
const MAX_CAPABILITIES = 1000;

/** authz's catalog reader, when authz is booted in this process. */
function authzCatalogReader(): { permissions(): Promise<string[]> } | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[AUTHZ_CATALOG_SLOT];
  return slot != null &&
    typeof slot === 'object' &&
    typeof (slot as { permissions?: unknown }).permissions === 'function'
    ? (slot as { permissions(): Promise<string[]> })
    : undefined;
}

/**
 * The catalog to publish, or `null` when there is nothing to publish: `false`, or no source
 * (`undefined` and authz is not in the app). `'authz'` without authz throws.
 */
export async function readAppCatalog(
  source: AppCatalogSource | undefined,
): Promise<{ capabilities: string[]; dropped: string[] } | null> {
  if (source === false) return null;
  let raw: readonly unknown[];
  if (typeof source === 'function') {
    raw = await source();
  } else {
    const reader = authzCatalogReader();
    if (!reader) {
      if (source === 'authz') {
        throw new Error(
          'authkit: service.catalog is "authz" but @adonis-agora/authz is not booted in this app',
        );
      }
      return null;
    }
    raw = await reader.permissions();
  }
  const capabilities = new Set<string>();
  const dropped: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry === 'string' && CAPABILITY.test(entry)) capabilities.add(entry);
    else dropped.push(String(entry));
  }
  return { capabilities: [...capabilities].sort().slice(0, MAX_CAPABILITIES), dropped };
}

export interface PublishAppCatalogOptions {
  /** The authkit issuer (`https://hub.example.com/oidc`); the endpoint is on its origin. */
  issuer: string;
  /** This app's service-tenant client: the server publishes for its `partition`. */
  clientId: string;
  clientSecret: string;
  capabilities: readonly string[];
  /** Default: `/api/apps/catalog` on the issuer's origin. */
  endpoint?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

/** Publishes the catalog. Resolves with the server's status; throws only on a network error. */
export async function publishAppCatalog(options: PublishAppCatalogOptions): Promise<number> {
  const endpoint = options.endpoint ?? new URL(APP_CATALOG_PATH, options.issuer).href;
  const basic = Buffer.from(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
  ).toString('base64');
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(endpoint, {
    method: 'PUT',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ capabilities: options.capabilities }),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  await res.body?.cancel().catch(() => {});
  return res.status;
}

interface LoggerLike {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** When the background publish tries again after a failure: 10 s, 1 min, 5 min. */
export const PUBLISH_RETRY_DELAYS_MS: readonly number[] = [10_000, 60_000, 300_000];

/**
 * Reads and publishes the catalog in the background (never blocks the start, never throws):
 * the Hub may be starting too, or be this very process, so a failure is retried a few times.
 * Returns a function that stops the retries.
 */
export function publishAppCatalogInBackground(
  options: Omit<PublishAppCatalogOptions, 'capabilities'> & {
    source: AppCatalogSource | undefined;
    logger?: LoggerLike | undefined;
    retryDelaysMs?: readonly number[] | undefined;
  },
): () => void {
  const delays = options.retryDelaysMs ?? PUBLISH_RETRY_DELAYS_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const attempt = async (n: number): Promise<void> => {
    if (stopped) return;
    let status: number | undefined;
    let reason: unknown;
    try {
      const catalog = await readAppCatalog(options.source);
      if (!catalog) return;
      if (catalog.dropped.length > 0) {
        options.logger?.warn(
          { dropped: catalog.dropped },
          'authkit: some catalog entries are not valid capability names and were left out',
        );
      }
      status = await publishAppCatalog({ ...options, capabilities: catalog.capabilities });
      if (status >= 200 && status < 300) {
        options.logger?.info?.(
          { count: catalog.capabilities.length },
          'authkit: published the app catalog',
        );
        return;
      }
      // Credentials or catalog refused: trying again would get the same answer.
      if (status === 401 || status === 404 || status === 422) {
        options.logger?.warn({ status }, 'authkit: the server refused the app catalog');
        return;
      }
    } catch (error) {
      reason = error;
      if (error instanceof Error && error.message.startsWith('authkit: service.catalog')) {
        options.logger?.warn({}, error.message);
        return;
      }
    }
    const delay = delays[n];
    if (delay === undefined) {
      options.logger?.warn(
        { status, err: reason },
        'authkit: could not publish the app catalog; it is published again on the next start',
      );
      return;
    }
    timer = setTimeout(() => void attempt(n + 1), delay);
    timer.unref?.();
  };
  void attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
