/**
 * Authorization-code flow in two calls: one to start it, one to finish it.
 *
 * `buildAuthorizeUrl` + `exchangeCode` are the raw steps; these two wrap them
 * with everything a callback must check and is easy to forget — `state`, the
 * RFC 9207 `iss` parameter, PKCE and the id_token (signature, `aud`, `nonce`…).
 *
 * ```ts
 * const { url, pending } = await createAuthorizationRequest({ issuer, clientId, redirectUri, scopes, endpoints })
 * session.put('oidc_pending', pending)
 * // ...IdP redirects back...
 * const { tokens, claims } = await completeAuthorization({
 *   issuer, clientId, clientSecret, redirectUri, endpoints,
 *   pending: session.pull('oidc_pending'),
 *   callbackParams: request.qs(),
 * })
 * ```
 *
 * Inside an AdonisJS app, prefer the `AuthkitClientManager` methods of the same
 * name — they fill the config and the discovered endpoints in for you.
 */

import { randomBytes } from 'node:crypto';
import { base64url } from 'jose';
import { conventionEndpoints, type OidcEndpoints } from './discovery.js';
import type { ResiliencePolicy } from './http/resilient_fetch.js';
import {
  type IdTokenClaims,
  InvalidIdTokenError,
  type ValidateIdTokenOptions,
  validateIdToken,
} from './id_token.js';
import { buildAuthorizeUrl, exchangeCode, generatePkce } from './oidc_login.js';
import type { TokenSet } from './types.js';

/**
 * What the app keeps (in the session) between the redirect to the IdP and the
 * callback. Plain JSON — safe to store in any session driver.
 */
export interface PendingAuthorization {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** `max_age` sent in the request, if any — re-checked against `auth_time`. */
  maxAge?: number;
}

export interface CreateAuthorizationRequestParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** Discovered endpoints. Without them, the authkit-server convention is used. */
  endpoints?: Pick<OidcEndpoints, 'authorizationEndpoint'>;
  /** Extra authorize parameters (`prompt`, `login_hint`, `audience`, `ui_locales`…). */
  extraParams?: Record<string, string | number | undefined | null>;
  /** OIDC `max_age` in seconds; the callback then requires a fresh enough `auth_time`. */
  maxAge?: number;
}

export interface AuthorizationRequest {
  /** Where to redirect the browser. */
  url: string;
  /** Store this until the callback, then pass it to `completeAuthorization`. */
  pending: PendingAuthorization;
}

const random = () => base64url.encode(randomBytes(32));

/** Builds the authorize URL with fresh `state`, `nonce` and PKCE (S256). */
export async function createAuthorizationRequest(
  p: CreateAuthorizationRequestParams,
): Promise<AuthorizationRequest> {
  const { verifier, challenge } = await generatePkce();
  const state = random();
  const nonce = random();
  const extraParams = { ...p.extraParams };
  if (p.maxAge !== undefined) extraParams.max_age = p.maxAge;

  const url = buildAuthorizeUrl({
    issuer: p.issuer,
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    scopes: p.scopes,
    state,
    nonce,
    codeChallenge: challenge,
    authorizationEndpoint: p.endpoints?.authorizationEndpoint,
    extraParams,
  });

  const pending: PendingAuthorization = { state, nonce, codeVerifier: verifier };
  if (p.maxAge !== undefined) pending.maxAge = p.maxAge;
  return { url, pending };
}

/** Why a callback was rejected. */
export type OidcCallbackErrorCode =
  /** No pending authorization in the session (expired, or a stale/forged callback). */
  | 'missing_pending'
  /** `state` does not match the pending authorization. */
  | 'state_mismatch'
  /** RFC 9207 `iss` parameter present and not the expected issuer (mix-up attack). */
  | 'issuer_mismatch'
  /** The IdP redirected back with `error` (e.g. `access_denied`, `login_required`). */
  | 'idp_error'
  /** No `code` in the callback. */
  | 'missing_code'
  /** Token endpoint call failed. */
  | 'token_exchange_failed'
  /** Token endpoint answered without an id_token (was `openid` in the scopes?). */
  | 'missing_id_token'
  /** id_token failed validation — see `cause`. */
  | 'invalid_id_token';

export class OidcCallbackError extends Error {
  constructor(
    readonly code: OidcCallbackErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      /** `error` / `error_description` sent by the IdP, for `idp_error`. */
      idpError?: { error: string; description?: string };
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'OidcCallbackError';
    this.idpError = options?.idpError;
  }

  readonly idpError?: { error: string; description?: string };

  /**
   * True when the right answer is to send the user back to login: the callback is
   * stale or did not belong to this browser, or the IdP sent the user back with an
   * error (`access_denied`, `login_required`…; see `idpError` to tell them apart).
   * False for real failures — a mix-up, a failed token exchange or id_token check.
   */
  get restartable(): boolean {
    return (
      this.code === 'missing_pending' ||
      this.code === 'state_mismatch' ||
      this.code === 'idp_error' ||
      this.code === 'missing_code'
    );
  }
}

export interface CompleteAuthorizationParams {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Discovered endpoints. Without them, the authkit-server convention is used. */
  endpoints?: Pick<OidcEndpoints, 'issuer' | 'tokenEndpoint' | 'jwksUri'>;
  /** What `createAuthorizationRequest` returned in `pending`. */
  pending: PendingAuthorization | null | undefined;
  /** The callback query string (`request.qs()`). */
  callbackParams: Record<string, unknown>;
  /** Overrides for the id_token check (keys in tests, clock tolerance…). */
  idToken?: Pick<ValidateIdTokenOptions, 'keys' | 'algorithms' | 'clockTolerance' | 'currentDate'>;
  fetchImpl?: typeof fetch;
  resilience?: ResiliencePolicy;
}

export interface CompletedAuthorization {
  tokens: TokenSet;
  /** Validated id_token claims. */
  claims: IdTokenClaims;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * The checks that say whether a callback belongs to this browser's pending authorization at all
 * (`missing_pending`, `state_mismatch`). They need nothing from the IdP, so a caller that has to
 * discover the IdP's endpoints first runs them before that: a stale or forged callback is
 * restartable even while the IdP is unreachable, rather than surfacing as a discovery failure.
 */
export function assertCallbackBelongs(
  pending: PendingAuthorization | null | undefined,
  callbackParams: Record<string, unknown>,
): asserts pending is PendingAuthorization {
  if (!pending?.state || !pending.nonce || !pending.codeVerifier) {
    throw new OidcCallbackError('missing_pending', 'No pending authorization for this callback');
  }
  if (str(callbackParams.state) !== pending.state) {
    throw new OidcCallbackError('state_mismatch', 'Callback state does not match');
  }
}

/**
 * Finishes the authorization-code flow: checks `state` and `iss`, exchanges the
 * code (with the PKCE verifier) and validates the id_token, `nonce` included.
 *
 * Throws {@link OidcCallbackError}; `error.restartable` tells "send the user back
 * to login" from a real failure.
 */
export async function completeAuthorization(
  p: CompleteAuthorizationParams,
): Promise<CompletedAuthorization> {
  const q = p.callbackParams;
  const pending = p.pending;
  assertCallbackBelongs(pending, q);
  const { issuer, tokenEndpoint, jwksUri } = p.endpoints ?? conventionEndpoints(p.issuer);

  const iss = str(q.iss);
  if (iss !== undefined && iss !== issuer) {
    throw new OidcCallbackError('issuer_mismatch', `Callback iss ${iss} is not ${issuer}`);
  }
  const idpError = str(q.error);
  if (idpError) {
    const description = str(q.error_description);
    throw new OidcCallbackError(
      'idp_error',
      `IdP returned ${idpError}${description ? `: ${description}` : ''}`,
      { idpError: { error: idpError, description } },
    );
  }
  const code = str(q.code);
  if (!code) throw new OidcCallbackError('missing_code', 'Callback has no code');

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode({
      issuer: p.issuer,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      redirectUri: p.redirectUri,
      code,
      codeVerifier: pending.codeVerifier,
      tokenEndpoint,
      fetchImpl: p.fetchImpl,
      resilience: p.resilience,
    });
  } catch (error) {
    throw new OidcCallbackError('token_exchange_failed', (error as Error).message, {
      cause: error,
    });
  }
  if (!tokens.idToken) {
    throw new OidcCallbackError(
      'missing_id_token',
      'Token endpoint returned no id_token — is "openid" in the scopes?',
    );
  }

  let claims: IdTokenClaims;
  try {
    claims = await validateIdToken(tokens.idToken, {
      ...p.idToken,
      issuer,
      clientId: p.clientId,
      jwksUri,
      nonce: pending.nonce,
      maxAge: pending.maxAge,
    });
  } catch (error) {
    const message = error instanceof InvalidIdTokenError ? error.message : String(error);
    throw new OidcCallbackError('invalid_id_token', message, { cause: error });
  }

  return { tokens, claims };
}
