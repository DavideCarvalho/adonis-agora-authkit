import { createRemoteJWKSet } from 'jose';

/**
 * Signature algorithms accepted by default on every JWT this package verifies
 * (id_token, logout_token, access token). Asymmetric only — defence against
 * alg confusion.
 */
export const DEFAULT_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

const cache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * The remote key set at `uri`, one per URI for the whole process: keys are
 * fetched once and reused (jose refetches on an unknown `kid`, so rotation
 * works). A rotated `jwks_uri` simply gets its own entry.
 */
export function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = cache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    cache.set(uri, set);
  }
  return set;
}

/** Clears the remote key sets (tests). */
export function clearJwksCache(): void {
  cache.clear();
}
