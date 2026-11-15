/**
 * Which app an origin belongs to. Service discovery is published by another lib (telescope:
 * the heartbeat carries each app's URL) on a shared global slot; authkit-client only reads
 * it, never imports its publisher. The static `apps` map of `config/authkit_client.ts`
 * overrides it, and is the whole answer when no discovery is published.
 */

import { APP_NAME_PATTERN } from './config.js';

/** The shared global slot discovery is published on. */
export const DISCOVERY_SLOT = Symbol.for('@adonis-agora/discovery');

/** What a discovery publisher puts on {@link DISCOVERY_SLOT}. */
export interface AgoraDiscovery {
  /** The origin (or base URL) of app `name`, when known. */
  resolve?(name: string): string | undefined;
  /** The app served at exactly this origin, when known. */
  appOf(origin: string): string | undefined;
  /**
   * Calls `fn` when the known apps change, with the apps now known: their names, or a
   * name → origin map/record. Returns an unsubscribe function (optional).
   */
  subscribe?(fn: (apps?: unknown) => void): unknown;
}

/**
 * App names out of a `subscribe` notification: a name, names, a `Map` or a record keyed by
 * name, or objects with a `name`. Anything else gives none.
 */
export function namesOf(apps: unknown): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    const name =
      typeof value === 'string'
        ? value
        : value &&
            typeof value === 'object' &&
            typeof (value as { name?: unknown }).name === 'string'
          ? (value as { name: string }).name
          : undefined;
    if (name && APP_NAME_PATTERN.test(name)) out.add(name);
  };
  if (typeof apps === 'string') add(apps);
  else if (apps instanceof Map) for (const key of apps.keys()) add(key);
  else if (apps && typeof (apps as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const item of apps as Iterable<unknown>) add(item);
  } else if (apps && typeof apps === 'object') for (const key of Object.keys(apps)) add(key);
  return [...out];
}

/** The published discovery, or `undefined`. */
export function agoraDiscovery(): AgoraDiscovery | undefined {
  const value = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as
    | Partial<AgoraDiscovery>
    | undefined;
  return value && typeof value.appOf === 'function' ? (value as AgoraDiscovery) : undefined;
}

const validName = (name: unknown) =>
  typeof name === 'string' && APP_NAME_PATTERN.test(name) ? name : undefined;

/**
 * The app at exactly `origin`: the static map first (it overrides discovery), then the
 * published discovery's `appOf(origin)`, then — for a request discovery has not rewritten
 * yet — `http(s)://<name>` when discovery `resolve`s `<name>`. A discovery answer that is
 * not a valid app name is ignored.
 */
export function appForOrigin(origin: string, origins: Map<string, string>): string | undefined {
  const fixed = origins.get(origin);
  if (fixed) return fixed;
  const discovery = agoraDiscovery();
  if (!discovery) return undefined;
  try {
    const name = validName(discovery.appOf(origin));
    if (name) return name;
    if (typeof discovery.resolve !== 'function') return undefined;
    const url = URL.parse(origin);
    // `http://billing` (no port): the shape discovery rewrites.
    if (!url || url.port) return undefined;
    const host = validName(url.hostname);
    return host && discovery.resolve(host) ? host : undefined;
  } catch {
    return undefined;
  }
}
