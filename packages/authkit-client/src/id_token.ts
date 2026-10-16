import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { DEFAULT_ALGS, getJwks } from './jwks.js';

/** Typed error thrown when an id_token does not satisfy OIDC Core §3.1.3.7. */
export class InvalidIdTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidIdTokenError';
  }
}

export interface ValidateIdTokenOptions {
  /** Expected issuer — compared exactly with the `iss` claim. */
  issuer: string;
  /** The RP's client_id; must be in `aud` (and equal `azp` when present). */
  clientId: string;
  /** IdP `jwks_uri`. Default: `${issuer}/jwks` (authkit-server convention). */
  jwksUri?: string;
  /** Pre-resolved key function (e.g. `createLocalJWKSet` in tests). Wins over `jwksUri`. */
  keys?: JWTVerifyGetKey;
  /** Accepted algorithms. Default: asymmetric only. */
  algorithms?: string[];
  /**
   * The nonce sent in the authorization request. When given, the token's `nonce`
   * claim must equal it. Leave it out only where no nonce was sent (refresh).
   */
  nonce?: string;
  /**
   * The `max_age` sent in the authorization request, in seconds. When given, the
   * token must carry `auth_time` and the authentication must be at most this old.
   */
  maxAge?: number;
  /**
   * Expected `sub`. On refresh, OIDC Core §12.2 requires the new id_token to be
   * about the same end-user as the one it replaces.
   */
  subject?: string;
  /** Clock skew tolerance in seconds. Default: 5. */
  clockTolerance?: number;
  /** Current time (tests). */
  currentDate?: Date;
}

/** Claims of a validated id_token. `sub`, `iat` and `exp` are guaranteed. */
export interface IdTokenClaims extends JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce?: string;
  auth_time?: number;
  sid?: string;
  azp?: string;
}

/**
 * Validates an id_token as required by OIDC Core §3.1.3.7:
 * signature against the IdP JWKS, `iss`, `aud` ∋ clientId, `azp` (when `aud`
 * has several entries or `azp` is present), `exp`, `iat`, and — when the caller
 * passes them — `nonce`, `auth_time`/`max_age` and `sub`.
 *
 * Throws {@link InvalidIdTokenError} on any violation.
 */
export async function validateIdToken(
  token: string,
  opts: ValidateIdTokenOptions,
): Promise<IdTokenClaims> {
  const keys = opts.keys ?? getJwks(opts.jwksUri ?? `${opts.issuer.replace(/\/$/, '')}/jwks`);
  const clockTolerance = opts.clockTolerance ?? 5;

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.clientId,
      algorithms: opts.algorithms ?? DEFAULT_ALGS,
      requiredClaims: ['sub', 'iat', 'exp'],
      clockTolerance,
      currentDate: opts.currentDate,
    });
    payload = verified.payload;
  } catch (error) {
    throw new InvalidIdTokenError(`Invalid id_token: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud.length > 1 && payload.azp === undefined) {
    throw new InvalidIdTokenError('id_token has several audiences but no azp claim');
  }
  if (payload.azp !== undefined && payload.azp !== opts.clientId) {
    throw new InvalidIdTokenError('id_token azp does not match the client_id');
  }

  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) {
    throw new InvalidIdTokenError('id_token nonce does not match the authorization request');
  }

  if (opts.subject !== undefined && payload.sub !== opts.subject) {
    throw new InvalidIdTokenError('id_token sub does not match the current session');
  }

  if (opts.maxAge !== undefined) {
    if (typeof payload.auth_time !== 'number') {
      throw new InvalidIdTokenError('id_token is missing auth_time, required by max_age');
    }
    const now = Math.floor((opts.currentDate ?? new Date()).getTime() / 1000);
    if (now - payload.auth_time > opts.maxAge + clockTolerance) {
      throw new InvalidIdTokenError('id_token auth_time is older than max_age');
    }
  }

  return payload as IdTokenClaims;
}
