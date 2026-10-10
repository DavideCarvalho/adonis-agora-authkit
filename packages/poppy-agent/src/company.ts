import { type Discovered, discover, HttpJsonCache } from './discovery.js';
import { DpopKey } from './dpop.js';
import { ConversationError, OAuthError, PoppyError, ResourceAuthError } from './errors.js';
import { PoppyHttp, type PoppyRequestInit, readJson } from './http.js';
import type { AgentIdentity } from './identity.js';
import { generateEs256Key } from './keys.js';
import type { AccountTokenRecord, CompanyState, StateStore, TokenRecord } from './store.js';
import { type NarrowingParams, TokenClient, type TokenClientOptions } from './token_client.js';
import type { AuthServerMetadata, PoppyDocument, TokenResponse } from './types.js';
import { type FetchLike, randomId, type SecurityOptions, scopeSet, wwwAuthError } from './util.js';

export interface PoppyAgentOptions extends SecurityOptions {
  store: StateStore;
  identity: AgentIdentity;
  /** Local user ("profile") the agent acts for. Defaults to `default`. */
  profile?: string;
  fetch?: FetchLike;
  log?: (line: string) => void;
  tokenClient?: TokenClientOptions;
  maxRetryAfterSeconds?: number;
}

/** Entry point: one agent identity, one local state file, one local user. */
export class PoppyAgent {
  readonly http: PoppyHttp;
  readonly cache = new HttpJsonCache();
  readonly profile: string;

  constructor(readonly opts: PoppyAgentOptions) {
    this.profile = opts.profile ?? 'default';
    this.http = new PoppyHttp({
      fetch: opts.fetch,
      log: opts.log,
      maxRetryAfterSeconds: opts.maxRetryAfterSeconds,
    });
  }

  get identity() {
    return this.opts.identity;
  }
  get store() {
    return this.opts.store;
  }
  log(line: string) {
    this.opts.log?.(line);
  }

  /** Discovers a Company and loads (or creates) this user's state there. */
  async company(domain: string): Promise<CompanyClient> {
    const discovered = await discover(domain, {
      fetch: this.http.fetch,
      insecureDev: this.opts.insecureDev,
      cache: this.cache,
    });
    if (!discovered.document.auth || !discovered.metadata) {
      throw new PoppyError(
        'no_auth',
        `${discovered.domain} publishes no auth: it can only be browsed as an ordinary website (section 5)`,
      );
    }
    const issuer = discovered.document.auth.issuer;
    const companies = this.store.profile(this.profile).companies;
    let state = companies[issuer];
    if (!state) {
      state = {
        issuer,
        domains: [],
        // 4.2: opaque, random, per Company. Never derived from personal information.
        userId: randomId('usr_'),
        dpopKey: await generateEs256Key(),
        tokens: {},
        conversations: {},
      };
      companies[issuer] = state;
    }
    const org = discovered.document.organization.domain.toLowerCase();
    if (!state.domains.includes(org)) state.domains.push(org);
    await this.store.save();
    return new CompanyClient(this, discovered, state);
  }
}

const EXPIRY_SKEW_MS = 30_000;

function tokenKey(opts: { bearer?: boolean } & NarrowingParams): string {
  if (opts.bearer) return `bearer|${opts.resource ?? ''}|${opts.scope ?? ''}`;
  if (!opts.scope && !opts.resource) return 'dpop';
  return `dpop|${opts.resource ?? ''}|${opts.scope ?? ''}`;
}

export interface SignInResult {
  grantedScope: string;
  /** Requested scopes the User didn't grant (4.4: "checks scope before continuing"). */
  missingScopes: string[];
  sessionId: string;
}

/** One User at one Company: Sessions, Account Token, and authenticated requests. */
export class CompanyClient {
  readonly tokens: TokenClient;
  readonly dpop: DpopKey;

  constructor(
    readonly agent: PoppyAgent,
    readonly discovered: Discovered,
    readonly state: CompanyState,
  ) {
    this.tokens = new TokenClient(
      agent.identity,
      discovered.metadata!,
      agent.http,
      agent.opts.tokenClient,
    );
    this.dpop = new DpopKey(state.dpopKey);
  }

  get document(): PoppyDocument {
    return this.discovered.document;
  }
  get metadata(): AuthServerMetadata {
    return this.discovered.metadata!;
  }
  get issuer(): string {
    return this.document.auth!.issuer;
  }
  get userId(): string {
    return this.state.userId;
  }
  get http(): PoppyHttp {
    return this.agent.http;
  }
  get security(): SecurityOptions {
    return { insecureDev: this.agent.opts.insecureDev };
  }
  get accountToken(): AccountTokenRecord | undefined {
    const a = this.state.accountToken;
    if (a?.expiresAt && a.expiresAt <= Date.now()) return undefined;
    return a;
  }

  async save() {
    await this.agent.store.save();
  }

  /** Forget the current Session; the next request starts a new one. */
  async newSession() {
    this.state.sessionId = undefined;
    this.state.tokens = {};
    await this.save();
  }

  /**
   * A valid Session Token. Starts a Session if there is none (signed in if an Account Token
   * exists, 4.8), renews it when it is close to expiry, and handles `invalid_session`,
   * `account_mismatch` and a revoked Account Token (`invalid_grant`) as 4.2/4.8/4.9 describe.
   */
  async token(
    opts: { bearer?: boolean; forceRenew?: boolean } & NarrowingParams = {},
  ): Promise<TokenRecord> {
    const key = tokenKey(opts);
    const rec = this.state.tokens[key];
    if (
      rec &&
      !opts.forceRenew &&
      rec.sessionId === this.state.sessionId &&
      rec.expiresAt - EXPIRY_SKEW_MS > Date.now()
    ) {
      return rec;
    }
    // Narrower and Bearer tokens are for an existing Session (4.3), so make sure there is one.
    if (key !== 'dpop' && !this.state.sessionId) await this.token();
    const resp = await this.issue(opts);
    return this.record(key, resp, opts.resource);
  }

  private async issue(opts: { bearer?: boolean } & NarrowingParams): Promise<TokenResponse> {
    const dpop = opts.bearer ? undefined : this.dpop;
    const narrowing = { scope: opts.scope, resource: opts.resource };
    const acct = this.accountToken;
    if (acct) {
      try {
        return await this.tokens.refresh({
          refreshToken: acct.refreshToken,
          sessionId: this.state.sessionId,
          dpop,
          ...narrowing,
        });
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        if (e.code === 'invalid_grant') {
          // 4.8/4.9: expired, revoked, or the User disconnected us. Continue signed out.
          this.agent.log('Account Token rejected (invalid_grant); continuing signed out');
          this.state.accountToken = undefined;
          await this.save();
        } else if (
          (e.code === 'invalid_session' || e.code === 'account_mismatch') &&
          this.state.sessionId
        ) {
          this.agent.log(`${e.code}: starting a new Session`);
          await this.newSession();
          return this.tokens.refresh({ refreshToken: acct.refreshToken, dpop, ...narrowing });
        } else {
          throw e;
        }
      }
    }
    try {
      return await this.tokens.jwtBearer({
        userId: this.userId,
        sessionId: this.state.sessionId,
        dpop,
        ...narrowing,
      });
    } catch (e) {
      if (e instanceof OAuthError && e.code === 'invalid_session' && this.state.sessionId) {
        this.agent.log('invalid_session: starting a new Session');
        await this.newSession();
        return this.tokens.jwtBearer({ userId: this.userId, dpop, ...narrowing });
      }
      throw e;
    }
  }

  private async record(key: string, resp: TokenResponse, resource?: string): Promise<TokenRecord> {
    if (resp.session_id !== this.state.sessionId) {
      // A different Session: tokens of the old one don't apply any more.
      this.state.tokens = {};
      this.state.sessionId = resp.session_id;
    }
    if (resp.refresh_token && this.state.accountToken) {
      // 4.8: the Company rotated the Account Token; MUST use the new one from now on.
      this.state.accountToken = {
        ...this.state.accountToken,
        refreshToken: resp.refresh_token,
        expiresAt:
          typeof resp.refresh_token_expires_in === 'number'
            ? Date.now() + resp.refresh_token_expires_in * 1000
            : this.state.accountToken.expiresAt,
      };
    }
    const rec: TokenRecord = {
      accessToken: resp.access_token,
      tokenType: resp.token_type,
      expiresAt: Date.now() + resp.expires_in * 1000,
      scope: resp.scope ?? '',
      sessionId: resp.session_id,
      signedIn: resp.signed_in,
      resource,
    };
    this.state.tokens[key] = rec;
    await this.save();
    return rec;
  }

  /** Stores the result of any sign-in type (4.4): Account Token + signed-in Session Token. */
  async applySignIn(
    resp: TokenResponse,
    via: AccountTokenRecord['via'],
    requestedScope: string,
  ): Promise<SignInResult> {
    if (!resp.refresh_token) {
      throw new OAuthError('invalid_response', {
        description: 'sign-in returned no Account Token',
      });
    }
    const old = this.state.accountToken;
    this.state.accountToken = {
      refreshToken: resp.refresh_token,
      scope: resp.scope ?? '',
      obtainedAt: Date.now(),
      expiresAt:
        typeof resp.refresh_token_expires_in === 'number'
          ? Date.now() + resp.refresh_token_expires_in * 1000
          : undefined,
      via,
    };
    this.state.tokens = {};
    this.state.sessionId = resp.session_id;
    this.state.tokens.dpop = {
      accessToken: resp.access_token,
      tokenType: resp.token_type,
      expiresAt: Date.now() + resp.expires_in * 1000,
      scope: resp.scope ?? '',
      sessionId: resp.session_id,
      signedIn: resp.signed_in,
    };
    await this.save();
    if (old && old.refreshToken !== resp.refresh_token) {
      // 4.4: the new Account Token replaces the old one, which we SHOULD revoke.
      try {
        await this.tokens.revoke(old.refreshToken);
      } catch (e) {
        this.agent.log(`could not revoke the replaced Account Token: ${(e as Error).message}`);
      }
    }
    const granted = scopeSet(resp.scope);
    return {
      grantedScope: resp.scope ?? '',
      missingScopes: [...scopeSet(requestedScope)].filter((s) => !granted.has(s)),
      sessionId: resp.session_id,
    };
  }

  /** Sign out (4.9): revoke the Account Token. Sessions carry on signed out. */
  async signOut(): Promise<boolean> {
    const acct = this.state.accountToken;
    if (!acct) return false;
    await this.tokens.revoke(acct.refreshToken, 'refresh_token');
    this.state.accountToken = undefined;
    // Signed-in Session Tokens may still be valid; drop them so the next request renews
    // with the agent's assertion and gets a signed-out token (4.9).
    this.state.tokens = {};
    await this.save();
    return true;
  }

  /** A Bearer Session Token for one MCP server (4.3 "Bearer tokens"). */
  async bearerFor(resource: string, forceRenew = false): Promise<string> {
    return (await this.token({ bearer: true, resource, forceRenew })).accessToken;
  }

  /**
   * An API or conversation request with `Authorization: DPoP` + a proof (4.3). Retries once
   * with a renewed token on `invalid_token`, and once with the Account Token on
   * `sign_in_required` when the current token is signed out but an Account Token exists.
   */
  async fetch(
    url: string,
    init: Omit<PoppyRequestInit, 'dpop' | 'accessToken' | 'scheme'> & NarrowingParams = {},
  ): Promise<Response> {
    const { scope, resource, ...rest } = init;
    let rec = await this.token({ scope, resource });
    for (let attempt = 0; ; attempt++) {
      const res = await this.http.request(url, {
        ...rest,
        dpop: this.dpop,
        accessToken: rec.accessToken,
        scheme: 'DPoP',
      });
      if (attempt > 0) return res;
      const err = wwwAuthError(res.headers.get('www-authenticate'));
      if (res.status === 401 && (!err.error || err.error === 'invalid_token')) {
        rec = await this.token({ scope, resource, forceRenew: true });
        continue;
      }
      // A signed-out token, or a signed-in one whose Session was signed out meanwhile (4.4
      // "How sign-in is remembered"): the Account Token signs the Session (back) in.
      if (res.status === 403 && err.error === 'sign_in_required' && this.accountToken) {
        rec = await this.token({ scope, resource, forceRenew: true });
        continue;
      }
      return res;
    }
  }

  /** `fetch` + JSON, mapping failures to typed errors (section 6, 7.13). */
  async json<T>(
    url: string,
    init: Omit<PoppyRequestInit, 'dpop' | 'accessToken' | 'scheme'> & NarrowingParams = {},
  ): Promise<{ status: number; body: T }> {
    const res = await this.fetch(url, init);
    if (!res.ok) await throwForResponse(res);
    return { status: res.status, body: (await readJson<T>(res)) as T };
  }
}

/** Maps a failed resource response to a typed error. */
export async function throwForResponse(res: Response): Promise<never> {
  const auth = wwwAuthError(res.headers.get('www-authenticate'));
  if (auth.error) {
    throw new ResourceAuthError(auth.error, {
      status: res.status,
      scope: auth.scope,
      description: auth.description,
    });
  }
  const body = await readJson<Record<string, unknown>>(res);
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  throw new ConversationError(code, {
    status: res.status,
    description: typeof body?.error_description === 'string' ? body.error_description : undefined,
    conversationId: typeof body?.conversation_id === 'string' ? body.conversation_id : undefined,
  });
}
