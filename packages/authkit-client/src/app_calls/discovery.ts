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
  resolve(name: string): string | undefined;
  /** The app served at exactly this origin, when known. */
  appOf(origin: string): string | undefined;
  /** Called when the known apps change. */
  subscribe(fn: () => void): unknown;
}

/** The published discovery, or `undefined`. */
export function agoraDiscovery(): AgoraDiscovery | undefined {
  const value = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as
    | Partial<AgoraDiscovery>
    | undefined;
  return value && typeof value.appOf === 'function' ? (value as AgoraDiscovery) : undefined;
}

/**
 * The app at exactly `origin`: the static map first (it overrides discovery), then the
 * published discovery. A discovery answer that is not a valid app name is ignored.
 */
export function appForOrigin(origin: string, origins: Map<string, string>): string | undefined {
  const fixed = origins.get(origin);
  if (fixed) return fixed;
  const discovery = agoraDiscovery();
  if (!discovery) return undefined;
  try {
    const name = discovery.appOf(origin);
    return typeof name === 'string' && APP_NAME_PATTERN.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
