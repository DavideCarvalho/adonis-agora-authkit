/**
 * An in-process FAKE Poppy Company, written strictly from the spec (Draft 0.1). It doubles as a
 * conformance check of the client: every request the agent makes is verified the way a real
 * Company MUST verify it (private_key_jwt, JWT bearer assertion, DPoP proofs with nonce/ath/jti
 * replay, PKCE, iss, scopes, Bearer-only-at-MCP, browser assertion rules), and violations are
 * recorded in `violations` so tests can assert there were none.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  EmbeddedJWK,
  type JWK,
  jwtVerify,
} from 'jose';
import { z } from 'zod';

const id = (p: string) => p + randomBytes(9).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

interface Session {
  id: string;
  clientId: string;
  userId: string;
  account?: string;
  scope: string;
  ended?: boolean;
  /** The Account Token the Session was signed in with. */
  viaToken?: string;
}
interface AccessToken {
  sessionId: string;
  clientId: string;
  userId: string;
  scope: string;
  signedIn: boolean;
  jkt?: string;
  bearer: boolean;
  resource?: string;
  exp: number;
}
interface AccountToken {
  clientId: string;
  userId: string;
  account: string;
  scope: string;
  revoked?: boolean;
  via: string;
}
interface Conversation {
  id: string;
  clientId: string;
  owner: string; // userId, or account once used
  userId: string;
  account?: string;
  events: Record<string, unknown>[];
  status: 'working' | 'idle' | 'queued' | 'closed';
  responder: 'agent' | 'human';
  parent?: string;
  openDirect?: string;
  messageIds: Map<string, string>;
}

export interface FakeOptions {
  /** Require a DPoP nonce on token and resource requests (RFC 9449 8/9). */
  requireNonce?: boolean;
  /** Close the SSE stream right after the first `message` event (tests Last-Event-ID resume). */
  dropStreamAfterFirstMessage?: boolean;
  /** Device polls answered `authorization_pending`, then one `slow_down`, then approve. */
  devicePendingPolls?: number;
  /** Return 429 + Retry-After once on the first OpenAPI call. */
  rateLimitOnce?: boolean;
  /** Access token lifetime. */
  accessTtl?: number;
  /** Rotate the Account Token on refresh. */
  rotateAccountToken?: boolean;
}

export class FakeCompany {
  server!: Server;
  origin = '';
  readonly violations: string[] = [];
  readonly log: string[] = [];
  readonly sessions = new Map<string, Session>();
  readonly tokens = new Map<string, AccessToken>();
  readonly accountTokens = new Map<string, AccountToken>();
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string; used?: boolean }
  >();
  readonly devices = new Map<
    string,
    { clientId: string; scope: string; polls: number; lastPoll?: number }
  >();
  readonly mediated = new Map<string, { sessionId: string; scope: string; attempts: number }>();
  readonly conversations = new Map<string, Conversation>();
  readonly seenJti = new Set<string>();
  readonly lastEventIdHeaders: string[] = [];
  readonly browserJoins: { sessionId: string; returnTo: string }[] = [];
  private nonce = id('n_');
  private rateLimited = false;
  private subscribers = new Map<string, Set<(chunk: string) => void>>();
  private clientCache = new Map<
    string,
    { metadata: Record<string, unknown>; jwks: { keys: JWK[] } }
  >();
  mcpCalls = 0;

  constructor(readonly opts: FakeOptions = {}) {}

  get issuer() {
    return this.origin;
  }
  get domain() {
    return new URL(this.origin).host;
  }
  get tokenEndpoint() {
    return `${this.origin}/oauth/token`;
  }
  get mcpUrl() {
    return `${this.origin}/mcp`;
  }

  async start(port = 0) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.violations.push(`server error: ${(e as Error).stack}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    for (const set of this.subscribers.values()) set.clear();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  poppyJson() {
    return {
      protocol_version: '0.1',
      organization: { name: 'Fake Co', domain: '127.0.0.1' },
      auth: {
        issuer: this.issuer,
        direct: { scopes: ['poppy:read', 'poppy:write', 'addresses'] },
        device: { scopes: ['poppy:read', 'poppy:write'] },
        mediated: {
          endpoint: `${this.origin}/poppy/sign-in`,
          fields: [
            { name: 'email', label: 'Email', secret: false },
            { name: 'password', label: 'Password', secret: true },
          ],
          scopes: ['poppy:read'],
        },
        custom_scopes: { addresses: 'Manage saved shipping addresses' },
        future_field: 'ignored',
      },
      agent: {
        protocols: [
          { type: 'something-else', endpoint: 'https://ignored.example/x' },
          { type: 'poppy', endpoint: `${this.origin}/poppy/conversations` },
        ],
      },
      web: { browser_session_endpoint: `${this.origin}/poppy/browser-session` },
      apis: [
        { type: 'graphql', url: 'https://ignored.example/graphql', description: 'unknown type' },
        { type: 'openapi', url: `${this.origin}/openapi.json`, description: 'Orders' },
        { type: 'mcp', url: this.mcpUrl, description: 'Tools' },
      ],
      extensions: { 'example.com/unknown': { version: '9' } },
    };
  }

  /* ------------------------------------------------------------------ helpers */

  private send(
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  private oauthError(
    res: ServerResponse,
    status: number,
    error: string,
    extra: Record<string, string> = {},
  ) {
    this.log.push(`oauth error ${error}`);
    this.send(res, status, { error }, extra);
  }
  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  private violation(msg: string) {
    this.violations.push(msg);
  }

  /** Fetches and checks the agent's Client ID Metadata Document (4.1). */
  private async client(clientId: string) {
    const cached = this.clientCache.get(clientId);
    if (cached) return cached;
    const res = await fetch(clientId);
    if (!res.ok) throw new Error('client metadata unreachable');
    const metadata = (await res.json()) as Record<string, unknown>;
    if (metadata.client_id !== clientId) this.violation('client_id != metadata URL');
    if (metadata.token_endpoint_auth_method !== 'private_key_jwt') this.violation('auth method');
    const host = new URL(clientId).host;
    const jwksUri = String(metadata.jwks_uri);
    if (new URL(jwksUri).host !== host) this.violation('jwks_uri not on client_id domain');
    for (const r of metadata.redirect_uris as string[]) {
      if (new URL(r).host !== host) this.violation('redirect_uri not on client_id domain');
    }
    const jwks = (await (await fetch(jwksUri)).json()) as { keys: JWK[] };
    for (const k of jwks.keys) if ('d' in k) this.violation('private key material in JWKS');
    const entry = { metadata, jwks };
    this.clientCache.set(clientId, entry);
    return entry;
  }

  private checkJti(jti: unknown, what: string): boolean {
    if (typeof jti !== 'string' || Buffer.from(jti, 'base64url').length < 16) {
      this.violation(`${what}: jti must carry >= 128 random bits`);
      return false;
    }
    if (this.seenJti.has(jti)) {
      this.violation(`${what}: jti replayed`);
      return false;
    }
    this.seenJti.add(jti);
    return true;
  }

  /** private_key_jwt (RFC 7523 2.2). Returns the client_id or undefined. */
  private async clientAuth(form: URLSearchParams): Promise<string | undefined> {
    const clientId = form.get('client_id');
    if (!clientId) return undefined;
    if (
      form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    ) {
      this.violation('client_assertion_type');
      return undefined;
    }
    const { jwks } = await this.client(clientId);
    try {
      const { payload } = await jwtVerify(
        form.get('client_assertion') ?? '',
        createLocalJWKSet(jwks),
        {
          issuer: clientId,
          subject: clientId,
          audience: [this.tokenEndpoint, this.issuer],
          algorithms: ['ES256'],
        },
      );
      if (typeof payload.aud !== 'string')
        this.violation('client assertion aud should be a single string');
      if (!this.checkJti(payload.jti, 'client assertion')) return undefined;
      return clientId;
    } catch (e) {
      this.violation(`client assertion: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Verifies a DPoP proof (RFC 9449 4.3). Returns jkt, or an error code. */
  private async dpop(
    req: IncomingMessage,
    url: string,
    accessToken?: string,
  ): Promise<{ jkt?: string; error?: string }> {
    const proof = req.headers.dpop;
    if (typeof proof !== 'string') return { error: 'invalid_dpop_proof' };
    try {
      const header = decodeProtectedHeader(proof);
      if (header.typ !== 'dpop+jwt') this.violation('DPoP typ');
      if (header.alg !== 'ES256') this.violation('DPoP alg');
      if (!header.jwk || 'd' in header.jwk) this.violation('DPoP jwk missing or private');
      const { payload } = await jwtVerify(proof, EmbeddedJWK, {
        typ: 'dpop+jwt',
        algorithms: ['ES256'],
      });
      if (payload.htm !== req.method) this.violation(`DPoP htm ${payload.htm} != ${req.method}`);
      const htu = new URL(url);
      htu.search = '';
      if (payload.htu !== htu.toString()) this.violation(`DPoP htu ${payload.htu} != ${htu}`);
      if (typeof payload.iat !== 'number' || Math.abs(now() - payload.iat) > 60)
        this.violation('DPoP iat');
      if (!this.checkJti(payload.jti, 'DPoP')) return { error: 'invalid_dpop_proof' };
      if (accessToken) {
        const ath = createHash('sha256').update(accessToken).digest('base64url');
        if (payload.ath !== ath) this.violation('DPoP ath mismatch');
      } else if (payload.ath !== undefined)
        this.violation('token endpoint proof must not have ath');
      if (this.opts.requireNonce && payload.nonce !== this.nonce)
        return { error: 'use_dpop_nonce' };
      return { jkt: await calculateJwkThumbprint(header.jwk as JWK) };
    } catch (e) {
      this.violation(`DPoP: ${(e as Error).message}`);
      return { error: 'invalid_dpop_proof' };
    }
  }

  private issue(
    res: ServerResponse,
    s: Session,
    opts: {
      jkt?: string;
      scope?: string;
      resource?: string;
      refreshToken?: string;
      extra?: Record<string, unknown>;
    },
  ) {
    const scope = opts.scope ?? s.scope;
    const access = id('at_');
    this.tokens.set(access, {
      sessionId: s.id,
      clientId: s.clientId,
      userId: s.userId,
      scope,
      signedIn: Boolean(s.account),
      jkt: opts.jkt,
      bearer: !opts.jkt,
      resource: opts.resource,
      exp: now() + (this.opts.accessTtl ?? 3600),
    });
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: opts.jkt ? 'DPoP' : 'Bearer',
      expires_in: this.opts.accessTtl ?? 3600,
      scope,
      session_id: s.id,
      signed_in: Boolean(s.account),
      unknown_future_field: true,
      ...opts.extra,
    };
    if (opts.refreshToken) {
      body.refresh_token = opts.refreshToken;
      body.refresh_token_expires_in = 2592000;
    }
    this.send(res, 200, body);
  }

  private narrow(requested: string | null, allowed: string): string | null {
    if (!requested) return allowed;
    const allow = new Set(allowed.split(' ').filter(Boolean));
    const req = requested.split(' ').filter(Boolean);
    return req.every((s) => allow.has(s)) ? req.join(' ') : null;
  }

  /** Sign a Session in and mint an Account Token (end of every sign-in type, 4.4). */
  private signIn(s: Session, scope: string, via: string) {
    const account = `acct_${s.userId}`;
    if (s.account && s.account !== account) return undefined;
    s.account = account;
    s.scope = scope;
    const rt = id('pat_');
    s.viaToken = rt;
    this.accountTokens.set(rt, { clientId: s.clientId, userId: s.userId, account, scope, via });
    return rt;
  }

  /* ------------------------------------------------------------------ router */

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.origin);
    const p = url.pathname;
    this.log.push(`${req.method} ${p}`);
    if (p === '/.well-known/poppy.json')
      return this.send(res, 200, this.poppyJson(), { 'cache-control': 'max-age=60' });
    if (p === '/.well-known/oauth-authorization-server') {
      return this.send(res, 200, {
        issuer: this.issuer,
        token_endpoint: this.tokenEndpoint,
        revocation_endpoint: `${this.origin}/oauth/revoke`,
        authorization_endpoint: `${this.origin}/oauth/authorize`,
        device_authorization_endpoint: `${this.origin}/oauth/device`,
        poppy_domains: ['127.0.0.1', 'fake.example'],
        some_other_field: 'ignored',
      });
    }
    if (p === '/oauth/token' && req.method === 'POST') return this.token(req, res);
    if (p === '/oauth/revoke' && req.method === 'POST') return this.revoke(req, res);
    if (p === '/oauth/authorize') return this.authorize(url, res);
    if (p === '/oauth/device' && req.method === 'POST') return this.deviceAuthorize(req, res);
    if (p === '/device/approve') {
      // Simulates the User approving on another device.
      const d = [...this.devices.values()].find(() => true);
      if (d) d.polls = Number.POSITIVE_INFINITY;
      return this.send(res, 200, {});
    }
    if (p.startsWith('/poppy/sign-in') && req.method === 'POST')
      return this.mediatedSignIn(req, res, url);
    if (p === '/poppy/browser-session' && req.method === 'POST')
      return this.browserSession(req, res);
    if (p.startsWith('/poppy/conversations')) return this.conversationsRoute(req, res, url);
    if (p === '/openapi.json') {
      return this.send(res, 200, {
        openapi: '3.1.0',
        info: { title: 'Fake', version: '1' },
        servers: [{ url: '/api' }],
        paths: {
          '/public': { get: { summary: 'Public info' } },
          '/orders': { get: { summary: 'Your orders (poppy:read)' } },
          '/addresses': { post: { summary: 'Add an address (addresses)' } },
        },
      });
    }
    if (p.startsWith('/api/')) return this.api(req, res, url);
    if (p === '/mcp') return this.mcp(req, res, url);
    this.send(res, 404, { error: 'not_found' });
  }

  /* ------------------------------------------------------------------ token endpoint */

  private async token(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    let jkt: string | undefined;
    if (req.headers.dpop) {
      const d = await this.dpop(req, this.tokenEndpoint);
      if (d.error === 'use_dpop_nonce')
        return this.oauthError(res, 400, 'use_dpop_nonce', { 'dpop-nonce': this.nonce });
      if (d.error) return this.oauthError(res, 400, d.error);
      jkt = d.jkt;
    }
    const resource = form.get('resource') ?? undefined;
    if (!jkt) {
      // Bearer only for an MCP server (4.3).
      if (resource !== this.mcpUrl) {
        this.violation('token request without DPoP for a non-MCP resource');
        return this.oauthError(res, 400, 'invalid_dpop_proof');
      }
    }
    const grant = form.get('grant_type');
    const sessionId = form.get('session_id');
    const scopeReq = form.get('scope');

    if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      const { jwks } = await this.client(clientId);
      const assertion = form.get('assertion') ?? '';
      let sub: string;
      try {
        const h = decodeProtectedHeader(assertion);
        if (h.typ === 'poppy-browser+jwt') return this.oauthError(res, 400, 'invalid_grant');
        const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks), {
          issuer: clientId,
          audience: this.tokenEndpoint,
          algorithms: ['ES256'],
        });
        if (typeof payload.aud !== 'string')
          this.violation('session assertion aud must be a string');
        if (!payload.exp || !payload.iat || payload.exp - payload.iat > 300)
          this.violation('session assertion not short-lived');
        if (!this.checkJti(payload.jti, 'session assertion'))
          return this.oauthError(res, 400, 'invalid_grant');
        sub = String(payload.sub);
        if (!/^usr_[A-Za-z0-9_-]{16,}$/.test(sub))
          this.violation(`User ID looks non-opaque: ${sub}`);
      } catch (e) {
        this.violation(`session assertion: ${(e as Error).message}`);
        return this.oauthError(res, 400, 'invalid_grant');
      }
      let s: Session | undefined;
      if (sessionId) {
        s = this.sessions.get(sessionId);
        if (!s || s.ended || s.clientId !== clientId || s.userId !== sub)
          return this.oauthError(res, 400, 'invalid_session');
        if (s.account) return this.oauthError(res, 400, 'invalid_grant'); // signed-in: renew with the Account Token
      } else {
        s = { id: id('ses_'), clientId, userId: sub, scope: '' };
        this.sessions.set(s.id, s);
      }
      return this.issue(res, s, { jkt, scope: '', resource });
    }

    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      const at = this.accountTokens.get(rt);
      if (!at || at.revoked || at.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      let s: Session | undefined;
      if (sessionId) {
        s = this.sessions.get(sessionId);
        if (!s || s.ended || s.clientId !== clientId || s.userId !== at.userId)
          return this.oauthError(res, 400, 'invalid_session');
        if (s.account && s.account !== at.account)
          return this.oauthError(res, 400, 'account_mismatch');
      } else {
        s = { id: id('ses_'), clientId, userId: at.userId, scope: '' };
        this.sessions.set(s.id, s);
      }
      s.account = at.account;
      s.scope = at.scope;
      s.viaToken = rt;
      const scope = this.narrow(scopeReq, at.scope);
      if (scope === null) return this.oauthError(res, 400, 'invalid_scope');
      let rotated: string | undefined;
      if (this.opts.rotateAccountToken) {
        at.revoked = true;
        rotated = id('pat_');
        s.viaToken = rotated;
        this.accountTokens.set(rotated, { ...at, revoked: false });
      }
      return this.issue(res, s, { jkt, scope, resource, refreshToken: rotated });
    }

    if (grant === 'authorization_code') {
      if (!jkt) return this.oauthError(res, 400, 'invalid_dpop_proof');
      const c = this.codes.get(form.get('code') ?? '');
      if (!c || c.used || c.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      c.used = true;
      if (form.get('redirect_uri') !== c.redirectUri)
        return this.oauthError(res, 400, 'invalid_grant');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) {
        this.violation('PKCE verifier mismatch');
        return this.oauthError(res, 400, 'invalid_grant');
      }
      const s = this.sessions.get(sessionId ?? '');
      if (!s || s.clientId !== clientId) return this.oauthError(res, 400, 'invalid_session');
      const rt = this.signIn(s, c.scope, 'direct');
      if (!rt) return this.oauthError(res, 400, 'account_mismatch');
      return this.issue(res, s, { jkt, refreshToken: rt });
    }

    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const d = this.devices.get(form.get('device_code') ?? '');
      if (!d || d.clientId !== clientId) return this.oauthError(res, 400, 'invalid_grant');
      d.polls++;
      const pending = this.opts.devicePendingPolls ?? 1;
      if (d.polls <= pending) return this.oauthError(res, 400, 'authorization_pending');
      if (d.polls === pending + 1) return this.oauthError(res, 400, 'slow_down');
      const s = this.sessions.get(sessionId ?? '');
      if (!s || s.clientId !== clientId) return this.oauthError(res, 400, 'invalid_session');
      this.devices.delete(form.get('device_code')!);
      const rt = this.signIn(s, d.scope, 'device');
      if (!rt) return this.oauthError(res, 400, 'account_mismatch');
      return this.issue(res, s, { jkt, refreshToken: rt });
    }
    return this.oauthError(res, 400, 'unsupported_grant_type');
  }

  private async revoke(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    if (form.get('token_type_hint') !== 'refresh_token')
      this.violation('revocation without token_type_hint=refresh_token');
    const at = this.accountTokens.get(form.get('token') ?? '');
    if (at && at.clientId === clientId) {
      at.revoked = true;
      // Sign out every Session signed in with it; they continue signed out (4.9).
      for (const s of this.sessions.values()) {
        if (s.viaToken === form.get('token') && s.clientId === clientId) {
          s.account = undefined;
          s.scope = '';
        }
      }
    }
    this.send(res, 200);
  }

  private async authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const { metadata } = await this.client(clientId);
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!(metadata.redirect_uris as string[]).includes(redirectUri)) {
      this.violation('redirect_uri not registered');
      return this.send(res, 400, { error: 'invalid_request' });
    }
    if (q.get('response_type') !== 'code') this.violation('response_type');
    if (q.get('code_challenge_method') !== 'S256') this.violation('PKCE method must be S256');
    if (!q.get('state')) this.violation('missing state');
    const scope = q.get('scope') ?? '';
    if (!scope) this.violation('sign-in without scope');
    const back = new URL(redirectUri);
    back.searchParams.set('state', q.get('state') ?? '');
    back.searchParams.set('iss', this.issuer);
    if (q.get('login_hint') === 'deny') {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = id('code_');
      this.codes.set(code, {
        clientId,
        redirectUri,
        challenge: q.get('code_challenge') ?? '',
        scope,
      });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  private async deviceAuthorize(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    const scope = form.get('scope') ?? '';
    if (!scope.split(' ').every((s) => ['poppy:read', 'poppy:write'].includes(s)))
      return this.oauthError(res, 400, 'invalid_scope');
    const deviceCode = id('dc_');
    this.devices.set(deviceCode, { clientId, scope, polls: 0 });
    this.send(res, 200, {
      device_code: deviceCode,
      user_code: 'WDJB-MJHT',
      verification_uri: `${this.origin}/device`,
      verification_uri_complete: `${this.origin}/device?user_code=WDJB-MJHT`,
      expires_in: 600,
      interval: 1,
    });
  }

  /* ------------------------------------------------------------------ resource auth */

  /** DPoP-bound Session Token check for APIs/conversations (4.3). Bearer is rejected here. */
  private async resourceAuth(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<AccessToken | undefined> {
    const auth = req.headers.authorization ?? '';
    if (url.search.includes('access_token')) this.violation('token in URL');
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'DPoP' || !token) {
      if (scheme === 'Bearer') this.violation('Bearer token used outside MCP');
      this.send(res, 401, undefined, { 'www-authenticate': 'DPoP error="invalid_token"' });
      return undefined;
    }
    const t = this.tokens.get(token);
    if (!t || t.exp < now() || t.bearer) {
      this.send(res, 401, undefined, { 'www-authenticate': 'DPoP error="invalid_token"' });
      return undefined;
    }
    const d = await this.dpop(req, url.toString(), token);
    if (d.error === 'use_dpop_nonce') {
      this.send(res, 401, undefined, {
        'www-authenticate': 'DPoP error="use_dpop_nonce"',
        'dpop-nonce': this.nonce,
      });
      return undefined;
    }
    if (d.error || d.jkt !== t.jkt) {
      if (!d.error) this.violation('DPoP key does not match token binding');
      this.send(res, 401, undefined, { 'www-authenticate': 'DPoP error="invalid_dpop_proof"' });
      return undefined;
    }
    // Sign-out takes effect right away (4.9 SHOULD).
    const s = this.sessions.get(t.sessionId);
    if (t.signedIn && !s?.account) return { ...t, signedIn: false, scope: '' };
    return t;
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (this.opts.rateLimitOnce && !this.rateLimited) {
      this.rateLimited = true;
      return this.send(res, 429, { error: 'rate_limited' }, { 'retry-after': '1' });
    }
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const scopes = new Set(t.scope.split(' '));
    if (url.pathname === '/api/public')
      return this.send(res, 200, { hello: 'world', signed_in: t.signedIn });
    if (url.pathname === '/api/orders') {
      if (!t.signedIn)
        return this.send(res, 403, undefined, {
          'www-authenticate': 'DPoP error="sign_in_required"',
        });
      if (!scopes.has('poppy:read')) {
        return this.send(res, 403, undefined, {
          'www-authenticate': 'DPoP error="insufficient_scope", scope="poppy:read"',
        });
      }
      return this.send(res, 200, { orders: [{ id: 'ord_1042', item: 'jacket' }] });
    }
    if (url.pathname === '/api/addresses') {
      if (!t.signedIn)
        return this.send(res, 403, undefined, {
          'www-authenticate': 'DPoP error="sign_in_required"',
        });
      if (!scopes.has('addresses')) {
        return this.send(res, 403, undefined, {
          'www-authenticate': 'DPoP error="insufficient_scope", scope="addresses"',
        });
      }
      return this.send(res, 201, { ok: true });
    }
    this.send(res, 404, { error: 'not_found' });
  }

  /* ------------------------------------------------------------------ mediated */

  private async mediatedSignIn(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const body = JSON.parse((await this.body(req)) || '{}');
    const parts = url.pathname.split('/');
    if (parts.length === 4) {
      const pending = this.mediated.get(parts[3]);
      if (!pending || pending.sessionId !== t.sessionId)
        return this.send(res, 200, { status: 'failed' });
      if (body.credentials) this.violation('credentials re-sent with the one-time code');
      if (body.code !== '123456') {
        pending.attempts++;
        return this.send(
          res,
          200,
          pending.attempts >= 3
            ? { status: 'failed' }
            : { status: 'code_required', sign_in_id: parts[3] },
        );
      }
      this.mediated.delete(parts[3]);
      const s = this.sessions.get(t.sessionId)!;
      const rt = this.signIn(s, pending.scope, 'mediated')!;
      const access = id('at_');
      this.tokens.set(access, { ...t, scope: pending.scope, signedIn: true, exp: now() + 3600 });
      return this.send(res, 200, {
        status: 'complete',
        access_token: access,
        token_type: 'DPoP',
        expires_in: 3600,
        refresh_token: rt,
        scope: pending.scope,
        session_id: s.id,
        signed_in: true,
      });
    }
    if (body.scope !== 'poppy:read') return this.send(res, 400, { error: 'invalid_scope' });
    const { email, password } = body.credentials ?? {};
    if (email !== 'dana@example.com' || password !== 'hunter2')
      return this.send(res, 200, { status: 'failed' });
    const signInId = id('sgn_');
    this.mediated.set(signInId, { sessionId: t.sessionId, scope: body.scope, attempts: 0 });
    this.send(res, 200, {
      status: 'code_required',
      sign_in_id: signInId,
      code: { sent_to: 'Text to the phone number ending in 71' },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
  }

  /* ------------------------------------------------------------------ browser */

  private async browserSession(req: IncomingMessage, res: ServerResponse) {
    if (new URL(req.url ?? '/', this.origin).search)
      this.violation('browser assertion endpoint called with a query');
    const form = new URLSearchParams(await this.body(req));
    const assertion = form.get('assertion') ?? '';
    try {
      const h = decodeProtectedHeader(assertion);
      if (h.typ !== 'poppy-browser+jwt') throw new Error('typ');
      const unverified = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      const { jwks } = await this.client(unverified.iss);
      const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks), {
        audience: `${this.origin}/poppy/browser-session`,
        typ: 'poppy-browser+jwt',
      });
      if ((payload.exp ?? 0) - (payload.iat ?? 0) > 60) throw new Error('exp > iat + 60');
      if (!this.checkJti(payload.jti, 'browser assertion')) throw new Error('jti');
      const s = this.sessions.get(String(payload.session_id));
      if (!s || s.clientId !== payload.iss || s.userId !== payload.sub) throw new Error('session');
      const returnTo = new URL(String(payload.return_to));
      if (returnTo.hostname !== '127.0.0.1') throw new Error('return_to');
      this.browserJoins.push({ sessionId: s.id, returnTo: returnTo.toString() });
      res.writeHead(303, {
        location: returnTo.toString(),
        'set-cookie': `fake_session=${s.id}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      });
      res.end();
    } catch (e) {
      this.violation(`browser assertion: ${(e as Error).message}`);
      res.writeHead(400).end('bad assertion');
    }
  }

  /* ------------------------------------------------------------------ MCP */

  private async mcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const t = this.tokens.get(token ?? '');
    if (scheme !== 'Bearer' || !t || !t.bearer || t.resource !== this.mcpUrl || t.exp < now()) {
      if (scheme === 'DPoP') this.violation('DPoP token sent to MCP');
      res.writeHead(401, {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      return res.end();
    }
    void url;
    this.mcpCalls++;
    const server = new McpServer({ name: 'fake-co', version: '1.0.0' });
    server.registerTool(
      'whoami',
      { description: 'Who the session is', inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({
        content: [
          { type: 'text', text: JSON.stringify({ signed_in: t.signedIn, scope: t.scope }) },
        ],
      }),
    );
    server.registerTool(
      'search_products',
      {
        description: 'Search products',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => ({
        content: [{ type: 'text', text: `Found: insulated ${query}, size M, $70` }],
      }),
    );
    server.registerTool(
      'place_order',
      { description: 'Place an order', inputSchema: { sku: z.string() } },
      async ({ sku }) => ({
        content: [{ type: 'text', text: `ordered ${sku}` }],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const raw = req.method === 'POST' ? await this.body(req) : undefined;
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  }

  /* ------------------------------------------------------------------ conversations */

  private push(c: Conversation, ev: Record<string, unknown>) {
    const full = { id: id('evt_'), created_at: new Date().toISOString(), ...ev };
    c.events.push(full);
    for (const fn of this.subscribers.get(c.id) ?? [])
      fn(`id: ${full.id}\ndata: ${JSON.stringify(full)}\n\n`);
    return full;
  }
  private setState(c: Conversation, status: Conversation['status'], responder = c.responder) {
    if (c.status === status && c.responder === responder) return;
    c.status = status;
    c.responder = responder;
    this.push(c, { type: 'state', status, responder });
  }
  private delta(c: Conversation, messageId: string, text: string) {
    for (const fn of this.subscribers.get(c.id) ?? []) {
      fn(`event: text-delta\ndata: ${JSON.stringify({ message_id: messageId, text })}\n\n`);
    }
  }

  /** The fake Company Agent. */
  private respond(c: Conversation, t: AccessToken, msg: Record<string, unknown>) {
    this.setState(c, 'working');
    setTimeout(() => {
      if (c.status === 'closed') return;
      const text = String(msg.text ?? '');
      const reply = (replyText: string, data?: Record<string, unknown>) => {
        const mid = id('msg_');
        const half = Math.ceil(replyText.length / 2);
        this.delta(c, mid, replyText.slice(0, half));
        this.delta(c, mid, replyText.slice(half));
        this.push(c, {
          type: 'message',
          message: {
            id: mid,
            role: 'company',
            sender: c.responder,
            text: replyText,
            ...(data ? { data } : {}),
          },
        });
      };
      if (/order/i.test(text)) {
        if (!t.signedIn || !t.scope.split(' ').includes('poppy:read')) {
          this.push(
            c,
            t.signedIn
              ? { type: 'authorization', error: 'insufficient_scope', scope: 'poppy:read' }
              : { type: 'authorization', error: 'sign_in_required' },
          );
          reply('Please sign in so I can look up your orders.');
        } else {
          c.owner = `acct_${t.userId}`;
          c.account = c.owner;
          reply('Here are your orders.', { orders: [{ id: 'ord_1042', item: 'jacket' }] });
        }
      } else if (/specialist|talk to the user/i.test(text)) {
        this.push(c, {
          type: 'user_requested',
          reason: 'A specialist needs to confirm with the customer.',
        });
        reply('I need to talk with the user directly.');
      } else if (msg.text !== undefined || msg.data !== undefined) {
        reply(`You said: ${text}${msg.data ? ` + data ${JSON.stringify(msg.data)}` : ''}`);
      }
      this.setState(c, 'idle');
    }, 20);
  }

  private owns(c: Conversation, t: AccessToken) {
    if (c.clientId !== t.clientId || c.userId !== t.userId) return false;
    if (c.account && !t.signedIn) return 'sign_in_required';
    return true;
  }

  private async conversationsRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const parts = url.pathname.split('/').filter(Boolean); // poppy, conversations, {id}, {action}
    const convId = parts[2];
    const action = parts[3];
    if (!convId && req.method === 'POST') {
      const body = JSON.parse(await this.body(req));
      const m = body.message;
      this.checkOutgoing(m);
      const prior = [...this.conversations.values()].find(
        (c) => c.userId === t.userId && c.messageIds.has(m.id),
      );
      if (prior) {
        if (prior.messageIds.get(m.id) !== JSON.stringify(m))
          return this.send(res, 409, { error: 'message_id_conflict' });
        return this.send(res, 201, {
          conversation_id: prior.id,
          status: prior.status,
          responder: prior.responder,
        });
      }
      let parent: Conversation | undefined;
      if (body.parent_conversation_id) {
        parent = this.conversations.get(body.parent_conversation_id);
        if (!parent || parent.userId !== t.userId || parent.parent)
          return this.send(res, 404, { error: 'conversation_not_found' });
        if (parent.status === 'closed')
          return this.send(res, 409, { error: 'conversation_closed' });
        if (parent.openDirect)
          return this.send(res, 409, {
            error: 'direct_conversation_open',
            conversation_id: parent.openDirect,
          });
      }
      const c: Conversation = {
        id: id('cnv_'),
        clientId: t.clientId,
        userId: t.userId,
        owner: t.userId,
        events: [],
        status: 'idle',
        responder: 'agent',
        parent: parent?.id,
        messageIds: new Map([[m.id, JSON.stringify(m)]]),
      };
      this.conversations.set(c.id, c);
      if (parent) {
        parent.openDirect = c.id;
        this.push(parent, { type: 'direct_opened', conversation_id: c.id });
      }
      this.push(c, { type: 'message', message: { ...m, role: 'user' } });
      this.respond(c, t, m);
      return this.send(res, 201, {
        conversation_id: c.id,
        status: c.status,
        responder: c.responder,
      });
    }
    const c = this.conversations.get(convId ?? '');
    const owns = c ? this.owns(c, t) : false;
    if (!c || owns === false) return this.send(res, 404, { error: 'conversation_not_found' });
    if (owns === 'sign_in_required')
      return this.send(res, 403, undefined, {
        'www-authenticate': 'DPoP error="sign_in_required"',
      });

    if (action === 'messages' && req.method === 'POST') {
      const m = JSON.parse(await this.body(req)).message;
      this.checkOutgoing(m);
      const seen = [...this.conversations.values()].find(
        (x) => x.userId === t.userId && x.messageIds.has(m.id),
      );
      if (seen) {
        if (seen.messageIds.get(m.id) !== JSON.stringify(m))
          return this.send(res, 409, { error: 'message_id_conflict' });
        return this.send(res, 202, { status: c.status, responder: c.responder });
      }
      if (c.status === 'closed') return this.send(res, 409, { error: 'conversation_closed' });
      if (c.openDirect)
        return this.send(res, 409, {
          error: 'direct_conversation_open',
          conversation_id: c.openDirect,
        });
      c.messageIds.set(m.id, JSON.stringify(m));
      this.push(c, { type: 'message', message: { ...m, role: 'user' } });
      this.respond(c, t, m);
      return this.send(res, 202, { status: c.status, responder: c.responder });
    }
    if (action === 'handoff' && req.method === 'POST') {
      if (c.status === 'closed') return this.send(res, 409, { error: 'conversation_closed' });
      this.setState(c, 'queued', 'agent');
      setTimeout(() => this.setState(c, 'idle', 'human'), 20);
      return this.send(res, 202, { status: c.status, responder: c.responder });
    }
    if (action === 'close' && req.method === 'POST') {
      this.setState(c, 'closed');
      if (c.parent) {
        const parent = this.conversations.get(c.parent);
        if (parent) {
          parent.openDirect = undefined;
          this.push(parent, { type: 'direct_closed', conversation_id: c.id });
        }
      }
      return this.send(res, 200, { status: c.status, responder: c.responder });
    }
    if (action === 'events' && req.method === 'GET') return this.events(req, res, url, c);
    this.send(res, 404, { error: 'not_found' });
  }

  private checkOutgoing(m: Record<string, unknown>) {
    if (typeof m?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(m.id))
      this.violation('bad message id');
    if (m?.sender !== 'agent' && m?.sender !== 'human') this.violation('bad sender');
    if (m?.text === undefined && m?.data === undefined && m?.context === undefined)
      this.violation('empty message');
  }

  private after(c: Conversation, cursor: string | undefined) {
    if (!cursor) return c.events;
    const i = c.events.findIndex((e) => e.id === cursor);
    return i === -1 ? undefined : c.events.slice(i + 1);
  }

  private async events(req: IncomingMessage, res: ServerResponse, url: URL, c: Conversation) {
    if (req.headers.accept?.includes('text/event-stream')) {
      const lastId = req.headers['last-event-id'];
      if (typeof lastId === 'string') this.lastEventIdHeaders.push(lastId);
      if (url.searchParams.get('cursor')) this.violation('SSE reconnect should use Last-Event-ID');
      const backlog = this.after(c, typeof lastId === 'string' ? lastId : undefined);
      if (!backlog) return this.send(res, 400, { error: 'invalid_cursor' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': hello\n\n');
      let sentMessage = false;
      const write = (chunk: string) => {
        res.write(chunk);
        if (
          this.opts.dropStreamAfterFirstMessage &&
          !sentMessage &&
          chunk.includes('"type":"message"') &&
          chunk.includes('"role":"company"')
        ) {
          sentMessage = true;
          this.opts.dropStreamAfterFirstMessage = false;
          unsubscribe();
          res.end();
        }
      };
      for (const ev of backlog) write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (res.writableEnded) return;
      const set = this.subscribers.get(c.id) ?? new Set();
      this.subscribers.set(c.id, set);
      set.add(write);
      const unsubscribe = () => set.delete(write);
      req.on('close', unsubscribe);
      return;
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 5);
    let events = this.after(c, cursor);
    if (!events) return this.send(res, 400, { error: 'invalid_cursor' });
    const deadline = Date.now() + wait * 1000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      events = this.after(c, cursor) ?? [];
    }
    const page = events.slice(0, 50);
    this.send(res, 200, {
      conversation_id: c.id,
      events: page,
      cursor: page.length ? page[page.length - 1].id : cursor,
      has_more: events.length > page.length,
      status: c.status,
      responder: c.responder,
    });
  }
}
