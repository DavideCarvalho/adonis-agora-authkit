import { randomBytes } from 'node:crypto';
import type { CompanyClient, SignInResult } from './company.js';
import { OAuthError, PoppyError } from './errors.js';
import { readJson } from './http.js';
import type { DeviceAuthorizationResponse, MediatedResponse, TokenResponse } from './types.js';
import { requireSecureUrl, scopeSet, sha256b64url, sleep } from './util.js';

export type SignInType = 'direct' | 'device' | 'mediated';

/** The sign-in types this Company offers that can grant every requested scope (4.4). */
export function eligibleSignInTypes(company: CompanyClient, scope: string): SignInType[] {
  const auth = company.document.auth!;
  const wanted = [...scopeSet(scope)];
  return (['direct', 'device', 'mediated'] as const).filter((t) => {
    const cfg = auth[t];
    return cfg && wanted.every((s) => cfg.scopes.includes(s));
  });
}

function assertScopeAllowed(company: CompanyClient, type: SignInType, scope: string) {
  const cfg = company.document.auth![type];
  if (!cfg) throw new PoppyError('unsupported_sign_in', `${type} sign-in is not offered`);
  if (scopeSet(scope).size === 0) {
    throw new PoppyError('invalid_scope', 'sign-in requests MUST include scope (4.4)');
  }
  const extra = [...scopeSet(scope)].filter((s) => !cfg.scopes.includes(s));
  if (extra.length > 0) {
    throw new PoppyError(
      'invalid_scope',
      `${type} sign-in can't grant ${extra.join(', ')} (offers: ${cfg.scopes.join(' ')})`,
    );
  }
}

/* ------------------------------------------------------------------ Direct (4.5) */

export interface PendingDirectSignIn {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scope: string;
  issuer: string;
}

/** Step 1 of 4.5: PKCE (S256) + random `state`, and the authorization URL to open. */
export async function startDirectSignIn(
  company: CompanyClient,
  scope: string,
): Promise<PendingDirectSignIn> {
  assertScopeAllowed(company, 'direct', scope);
  const endpoint = company.metadata.authorization_endpoint;
  if (!endpoint) throw new PoppyError('unsupported_sign_in', 'no authorization_endpoint');
  // Make sure there is a Session for the code exchange to sign in.
  await company.token();
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const redirectUri = company.agent.identity.redirectUri;
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', company.agent.identity.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', sha256b64url(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, codeVerifier, redirectUri, scope, issuer: company.issuer };
}

/**
 * Steps 3–4 of 4.5: checks `state` and the RFC 9207 `iss` (exact match with the issuer we
 * started with), then exchanges the code with PKCE, DPoP and `session_id`.
 */
export async function completeDirectSignIn(
  company: CompanyClient,
  pending: PendingDirectSignIn,
  callback: URLSearchParams,
): Promise<SignInResult> {
  if (callback.get('state') !== pending.state) {
    throw new PoppyError('state_mismatch', 'Direct Sign-In callback state does not match');
  }
  const iss = callback.get('iss');
  if (iss !== pending.issuer) {
    throw new PoppyError(
      'issuer_mismatch',
      `Direct Sign-In callback iss "${iss ?? '(missing)'}" != "${pending.issuer}" (RFC 9207)`,
    );
  }
  const error = callback.get('error');
  if (error) {
    throw new OAuthError(error, { description: callback.get('error_description') ?? undefined });
  }
  const code = callback.get('code');
  if (!code) throw new PoppyError('invalid_callback', 'callback has neither code nor error');
  const sessionId = company.state.sessionId ?? (await company.token()).sessionId;
  const resp = await company.tokens.authorizationCode({
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    sessionId,
    dpop: company.dpop,
  });
  return company.applySignIn(resp, 'direct', pending.scope);
}

/* ------------------------------------------------------------------ Device (4.6) */

export interface DeviceSignInOptions {
  /** Shows the link and code to the User. `device_code` is never passed here. */
  display: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
  }) => void;
  signal?: AbortSignal;
  /** Hook for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPoll?: (status: 'authorization_pending' | 'slow_down', intervalSeconds: number) => void;
}

/** RFC 8628 device flow: start, show the code, poll every `interval`, +5s on `slow_down`. */
export async function deviceSignIn(
  company: CompanyClient,
  scope: string,
  opts: DeviceSignInOptions,
): Promise<SignInResult> {
  assertScopeAllowed(company, 'device', scope);
  const d: DeviceAuthorizationResponse = await company.tokens.deviceAuthorization(scope);
  opts.display({
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete: d.verification_uri_complete,
    expiresIn: d.expires_in,
  });
  const wait = opts.sleep ?? sleep;
  let interval = typeof d.interval === 'number' && d.interval > 0 ? d.interval : 5;
  const deadline = Date.now() + d.expires_in * 1000;
  for (;;) {
    await wait(interval * 1000, opts.signal);
    if (Date.now() > deadline) throw new OAuthError('expired_token');
    const sessionId = company.state.sessionId ?? (await company.token()).sessionId;
    try {
      const resp = await company.tokens.deviceToken({
        deviceCode: d.device_code,
        sessionId,
        dpop: company.dpop,
      });
      return await company.applySignIn(resp, 'device', scope);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.code === 'authorization_pending') {
        opts.onPoll?.('authorization_pending', interval);
        continue;
      }
      if (e.code === 'slow_down') {
        interval += 5; // RFC 8628 section 3.5
        opts.onPoll?.('slow_down', interval);
        continue;
      }
      throw e; // access_denied, expired_token, anything else: stop asking.
    }
  }
}

/* ------------------------------------------------------------------ Mediated (4.7) */

export type MediatedOutcome =
  | { status: 'complete'; result: SignInResult }
  | { status: 'code_required'; signInId: string; sentTo?: string; expiresAt?: string }
  | { status: 'failed' | 'expired' };

async function mediatedRequest(
  company: CompanyClient,
  url: string,
  body: unknown,
  scope: string,
): Promise<MediatedOutcome> {
  const res = await company.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await readJson<MediatedResponse & { error?: string }>(res);
  if (!json || typeof json.status !== 'string') {
    throw new PoppyError(json?.error ?? `http_${res.status}`, undefined, {
      status: res.status,
      description: 'mediated sign-in failed',
    });
  }
  switch (json.status) {
    case 'complete': {
      const resp = json as unknown as TokenResponse;
      if (String(resp.token_type).toLowerCase() !== 'dpop') {
        throw new OAuthError('invalid_response', { description: 'expected a DPoP Session Token' });
      }
      return { status: 'complete', result: await company.applySignIn(resp, 'mediated', scope) };
    }
    case 'code_required':
      if (!json.sign_in_id || !/^[A-Za-z0-9_-]{1,256}$/.test(json.sign_in_id)) {
        throw new PoppyError('invalid_response', 'code_required without a valid sign_in_id');
      }
      return {
        status: 'code_required',
        signInId: json.sign_in_id,
        sentTo: json.code?.sent_to,
        expiresAt: json.expires_at,
      };
    case 'failed':
    case 'expired':
      return { status: json.status };
    default:
      throw new PoppyError('invalid_response', `unknown mediated status ${String(json.status)}`);
  }
}

/**
 * Mediated Sign-In (4.7). Credentials go ONLY to `auth.mediated.endpoint`, with the current
 * Session Token. Secret values are never logged or echoed by this module.
 */
export async function mediatedSignIn(
  company: CompanyClient,
  scope: string,
  credentials: Record<string, string>,
): Promise<MediatedOutcome> {
  assertScopeAllowed(company, 'mediated', scope);
  const mediated = company.document.auth!.mediated!;
  const endpoint = requireSecureUrl(mediated.endpoint, 'auth.mediated.endpoint', company.security);
  const missing = mediated.fields.filter((f) => typeof credentials[f.name] !== 'string');
  if (missing.length > 0) {
    throw new PoppyError(
      'missing_credentials',
      `missing: ${missing.map((f) => f.name).join(', ')}`,
    );
  }
  const sent: Record<string, string> = {};
  for (const f of mediated.fields) sent[f.name] = credentials[f.name];
  return mediatedRequest(company, endpoint.toString(), { scope, credentials: sent }, scope);
}

/** Submits only the one-time code, to `{endpoint}/{sign_in_id}` (4.7). */
export function submitMediatedCode(
  company: CompanyClient,
  scope: string,
  signInId: string,
  code: string,
): Promise<MediatedOutcome> {
  const base = company.document.auth!.mediated!.endpoint.replace(/\/+$/, '');
  return mediatedRequest(company, `${base}/${encodeURIComponent(signInId)}`, { code }, scope);
}
