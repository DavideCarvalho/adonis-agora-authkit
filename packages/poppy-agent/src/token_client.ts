import type { DpopKey } from './dpop.js';
import { OAuthError } from './errors.js';
import { type PoppyHttp, readJson } from './http.js';
import type { AgentIdentity } from './identity.js';
import type { AuthServerMetadata, DeviceAuthorizationResponse, TokenResponse } from './types.js';
import { parseRetryAfter } from './util.js';

export const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface TokenClientOptions {
  /**
   * `aud` of the client assertion. RFC 7523 allows the token endpoint URL (the default here,
   * matching the spec's examples) or the issuer identifier.
   */
  clientAssertionAudience?: 'token_endpoint' | 'issuer';
}

export interface NarrowingParams {
  /** Ask for fewer scopes than the Session has (4.3 "Narrower tokens"). */
  scope?: string;
  /** RFC 8707 resource indicator. */
  resource?: string;
}

/**
 * OAuth calls against the Company's authorization server (section 4): every request carries
 * a `private_key_jwt` client assertion (4.1), and token requests carry a DPoP proof unless a
 * Bearer token (MCP) is wanted (4.3).
 */
export class TokenClient {
  constructor(
    private readonly identity: AgentIdentity,
    readonly metadata: AuthServerMetadata,
    private readonly http: PoppyHttp,
    private readonly opts: TokenClientOptions = {},
  ) {}

  private async clientAuth(): Promise<Record<string, string>> {
    const aud =
      this.opts.clientAssertionAudience === 'issuer'
        ? this.metadata.issuer
        : this.metadata.token_endpoint;
    return {
      client_id: this.identity.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await this.identity.clientAssertion(aud),
    };
  }

  /** POSTs a form; the builder runs per attempt so retries get fresh assertions. */
  private async post(
    endpoint: string,
    build: () => Promise<Record<string, string | undefined>>,
    dpop?: DpopKey,
  ): Promise<{ status: number; body: Record<string, unknown> | undefined; headers: Headers }> {
    const res = await this.http.request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      dpop,
      body: async () => {
        const params = { ...(await build()), ...(await this.clientAuth()) };
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
          if (v !== undefined && v !== '') form.set(k, v);
        return form.toString();
      },
    });
    return { status: res.status, body: await readJson(res), headers: res.headers };
  }

  private toError(r: { status: number; body?: Record<string, unknown>; headers: Headers }) {
    const code = typeof r.body?.error === 'string' ? r.body.error : `http_${r.status}`;
    return new OAuthError(code, {
      status: r.status,
      description:
        typeof r.body?.error_description === 'string' ? r.body.error_description : undefined,
      retryAfter: parseRetryAfter(r.headers.get('retry-after')),
      details: r.body,
    });
  }

  /** Any token-endpoint grant. Validates the response shape of 4.2/4.4. */
  async token(
    params: () => Promise<Record<string, string | undefined>>,
    dpop?: DpopKey,
  ): Promise<TokenResponse> {
    const r = await this.post(this.metadata.token_endpoint, params, dpop);
    if (r.status !== 200 || !r.body) throw this.toError(r);
    const t = r.body as unknown as TokenResponse;
    if (typeof t.access_token !== 'string' || !t.access_token) {
      throw new OAuthError('invalid_response', {
        description: 'no access_token in token response',
      });
    }
    if (typeof t.expires_in !== 'number' || !(t.expires_in > 0)) {
      throw new OAuthError('invalid_response', { description: 'expires_in must be > 0 (4.2)' });
    }
    if (typeof t.session_id !== 'string' || !t.session_id) {
      throw new OAuthError('invalid_response', { description: 'no session_id in token response' });
    }
    const expected = dpop ? 'dpop' : 'bearer';
    if (String(t.token_type).toLowerCase() !== expected) {
      // RFC 9449 section 5: a client that sent a proof must not accept a downgraded token.
      throw new OAuthError('invalid_response', {
        description: `token_type is ${t.token_type}, expected ${dpop ? 'DPoP' : 'Bearer'}`,
      });
    }
    t.signed_in = t.signed_in === true;
    t.scope = typeof t.scope === 'string' ? t.scope : '';
    return t;
  }

  /** JWT bearer grant: starts a Session, or renews a signed-out one with `sessionId` (4.2). */
  jwtBearer(
    input: { userId: string; sessionId?: string; dpop?: DpopKey } & NarrowingParams,
  ): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: GRANT_JWT_BEARER,
        assertion: await this.identity.sessionAssertion(input.userId, this.metadata.token_endpoint),
        session_id: input.sessionId,
        scope: input.scope,
        resource: input.resource,
      }),
      input.dpop,
    );
  }

  /** Account Token grant (4.8): signs a Session in, or starts a new signed-in Session. */
  refresh(
    input: { refreshToken: string; sessionId?: string; dpop?: DpopKey } & NarrowingParams,
  ): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        session_id: input.sessionId,
        scope: input.scope,
        resource: input.resource,
      }),
      input.dpop,
    );
  }

  /** Direct Sign-In code exchange (4.5 step 4). */
  authorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    sessionId: string;
    dpop: DpopKey;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        session_id: input.sessionId,
      }),
      input.dpop,
    );
  }

  /** Device Sign-In step 1 (4.6). */
  async deviceAuthorization(scope: string): Promise<DeviceAuthorizationResponse> {
    const endpoint = this.metadata.device_authorization_endpoint;
    if (!endpoint)
      throw new OAuthError('unsupported', { description: 'no device_authorization_endpoint' });
    const r = await this.post(endpoint, async () => ({ scope }));
    if (r.status !== 200 || !r.body) throw this.toError(r);
    const d = r.body as unknown as DeviceAuthorizationResponse;
    if (!d.device_code || !d.user_code || !d.verification_uri) {
      throw new OAuthError('invalid_response', {
        description: 'incomplete device authorization response',
      });
    }
    return d;
  }

  /** Device Sign-In polling (4.6 step 3). Throws `authorization_pending` / `slow_down` etc. */
  deviceToken(input: {
    deviceCode: string;
    sessionId: string;
    dpop: DpopKey;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: GRANT_DEVICE_CODE,
        device_code: input.deviceCode,
        session_id: input.sessionId,
      }),
      input.dpop,
    );
  }

  /** RFC 7009 revocation of an Account Token (4.9). */
  async revoke(token: string, hint: 'refresh_token' | 'access_token' = 'refresh_token') {
    const r = await this.post(this.metadata.revocation_endpoint, async () => ({
      token,
      token_type_hint: hint,
    }));
    if (r.status !== 200) throw this.toError(r);
  }
}
