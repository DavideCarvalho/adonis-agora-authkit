/**
 * Where each Agora control plane lives (durable, telescope, crypto, flags, config…), read
 * from the issuer's discovery document (`agora_control_planes`, resource indicator → URL)
 * instead of one URL env var per control plane. Moving a control plane is a change to the
 * IdP's `serviceTenants.resources[*].url`, not to every app.
 */

import { type DiscoverOptions, discoverEndpoints, refreshDiscovery } from './discovery.js';

export interface DiscoverControlPlaneOptions {
  /** Issuer URL of the authkit server (the `issuer` in its config/authkit.ts). */
  issuer: string;
  /** Resource indicator of the control plane, e.g. `'urn:agora:telescope'`. */
  resource: string;
  /** Custom `fetch` (proxy, tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Discovery cache TTL in ms (shared with every other discovery call). Default: 15 min. */
  cacheTtlMs?: number;
  /** Resilience policy for the discovery request. Default: a plain `fetch`. */
  resilience?: DiscoverOptions['resilience'];
}

/** Thrown when the issuer's discovery document does not list the control plane. */
export class ControlPlaneNotFoundError extends Error {
  readonly code = 'E_CONTROL_PLANE_NOT_FOUND';
  constructor(
    readonly issuer: string,
    readonly resource: string,
  ) {
    super(
      `${issuer} does not publish a control plane for "${resource}": set serviceTenants.resources["${resource}"].url in its config/authkit.ts`,
    );
    this.name = 'ControlPlaneNotFoundError';
  }
}

/** A forced refetch (resource missing, `refresh()`) runs at most this often per issuer. */
const FORCED_REFRESH_INTERVAL_MS = 10_000;
const lastForced = new Map<string, number>();

const trimSlash = (s: string) => s.replace(/\/+$/, '');

function find(map: Record<string, string> | undefined, resource: string): string | undefined {
  if (!map) return undefined;
  if (map[resource]) return map[resource];
  const wanted = trimSlash(resource);
  const key = Object.keys(map).find((k) => trimSlash(k) === wanted);
  return key ? map[key] : undefined;
}

async function lookup(options: DiscoverControlPlaneOptions): Promise<string | undefined> {
  const endpoints = await discoverEndpoints(options.issuer, {
    onError: 'throw',
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.resilience ? { resilience: options.resilience } : {}),
  });
  return find(endpoints.controlPlanes, options.resource);
}

/**
 * Refetches the document unless a refetch succeeded in the last 10 s for this issuer.
 * Concurrent callers share one fetch (`refreshDiscovery` is single-flight); the throttle is
 * set only once it succeeds, so a failure is never remembered and the next call retries.
 */
async function forceRefresh(options: DiscoverControlPlaneOptions): Promise<boolean> {
  const key = trimSlash(options.issuer);
  if (Date.now() - (lastForced.get(key) ?? 0) < FORCED_REFRESH_INTERVAL_MS) return false;
  await refreshDiscovery(options.issuer, {
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.resilience ? { resilience: options.resilience } : {}),
  });
  lastForced.set(key, Date.now());
  return true;
}

/**
 * The URL of one control plane, from `{issuer}/.well-known/openid-configuration`.
 *
 * The document is cached per issuer (15 min, served stale while it refetches in the
 * background), so this is cheap to call per request. When the cached document does not list
 * the resource it is refetched once before giving up (at most every 10 s per issuer), so a
 * control plane added on the IdP is picked up without a restart.
 *
 * Throws {@link ControlPlaneNotFoundError} when the issuer does not publish the resource, and
 * `OidcDiscoveryError` when the document cannot be fetched (nothing is cached, the next call
 * retries).
 */
export async function discoverControlPlane(options: DiscoverControlPlaneOptions): Promise<string> {
  if (!options?.issuer || !options.resource) {
    throw new TypeError('discoverControlPlane: issuer and resource are required');
  }
  const url = await lookup(options);
  if (url) return url;
  if (await forceRefresh(options)) {
    const fresh = await lookup(options);
    if (fresh) return fresh;
  }
  throw new ControlPlaneNotFoundError(options.issuer, options.resource);
}

/**
 * A lazy control-plane URL for a config file: configs are synchronous, discovery is not.
 * Call it (`await url()`) where the URL is needed; `peek()` gives the last resolved value
 * with no I/O (`undefined` until the first call resolves); `refresh()` refetches the
 * discovery document (call it when the control plane stops answering, in case it moved).
 */
export type ControlPlaneUrl = (() => Promise<string>) & {
  /** The resource indicator this URL is for. */
  readonly resource: string;
  /** Last resolved URL, synchronously; `undefined` before the first resolution. */
  peek(): string | undefined;
  /** Refetches the discovery document (throttled to every 10 s per issuer) and resolves again. */
  refresh(): Promise<string>;
};

/**
 * The lazy form of {@link discoverControlPlane}, for `config/*.ts`:
 *
 * ```ts
 * // config/telescope.ts (tenant app)
 * tenant: {
 *   url: controlPlaneUrl({ issuer: env.get('AUTHKIT_ISSUER'), resource: 'urn:agora:telescope' }),
 *   ...
 * }
 * ```
 *
 * Nothing is fetched until it is called.
 */
export function controlPlaneUrl(options: DiscoverControlPlaneOptions): ControlPlaneUrl {
  if (!options?.issuer || !options.resource) {
    throw new TypeError('controlPlaneUrl: issuer and resource are required');
  }
  let last: string | undefined;
  const resolve = async () => {
    last = await discoverControlPlane(options);
    return last;
  };
  const refresh = async () => {
    await forceRefresh(options);
    return resolve();
  };
  return Object.assign(resolve, {
    resource: options.resource,
    peek: () => last,
    refresh,
  });
}

/** Clears the forced-refresh throttle (tests). */
export function __clearControlPlaneThrottleForTests(): void {
  lastForced.clear();
}
