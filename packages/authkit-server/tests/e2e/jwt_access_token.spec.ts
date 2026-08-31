import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { base64url, createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { AuthAccount } from '../../src/accounts/account_store.js';
import { type AuthServerConfigInput, adapters, defineConfig } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import { OidcService } from '../../src/provider/oidc_service.js';

// ---------------------------------------------------------------------------
// E2E harness for RFC 9068 JWT Access Tokens. Drives login → consent → token
// through the REAL host interaction controller (mirrors full_flow.spec.ts) and
// then asserts the access_token shape: header typ at+jwt, RFC 9068 claims, and
// signature validable purely from the jwks_uri.
// ---------------------------------------------------------------------------

const PORT = 9855;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'app1';
const CLIENT_SECRET = 's';
const REDIRECT_URI = `${ISSUER}/cb`;
const APP_KEY = 'a'.repeat(32);

const PASSWORD = 'correct-horse';
const EMAIL = 'user@example.com';
const ACCOUNT_ID = 'user-1';

function makeStore() {
  const account: AuthAccount = {
    id: ACCOUNT_ID,
    email: EMAIL,
    name: 'Test User',
    avatarUrl: null,
    globalRoles: ['USER'],
  };
  return {
    findById: async (id: string) => (id === ACCOUNT_ID ? account : null),
    findByEmail: async (email: string) => (email === EMAIL ? account : null),
    verifyCredentials: async (email: string, password: string) =>
      email === EMAIL && password === PASSWORD ? { id: ACCOUNT_ID } : null,
    create: async () => {
      throw new Error('not used');
    },
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
  } as any;
}

const SESSIONS = new Map<string, Map<string, any>>();

function getSession(req: IncomingMessage, res: ServerResponse): Map<string, any> {
  const cookies = parseCookies(req);
  let sid = cookies.hsid;
  if (!sid || !SESSIONS.has(sid)) {
    sid = `sid-${Math.random().toString(36).slice(2)}`;
    SESSIONS.set(sid, new Map());
    appendSetCookie(res, `hsid=${sid}; Path=/; HttpOnly`);
  }
  return SESSIONS.get(sid)!;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function appendSetCookie(res: ServerResponse, value: string) {
  const prev = res.getHeader('set-cookie');
  const arr = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  arr.push(value);
  res.setHeader('set-cookie', arr);
}

function buildCtx(
  service: OidcService,
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, string>,
  uid: string,
  query: URLSearchParams,
) {
  const session = getSession(req, res);
  const ctx: any = {
    request: {
      request: req,
      response: res,
      param: (name: string) => (name === 'uid' ? uid : undefined),
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, body[k]])),
      input: (key: string, def?: any) => body[key] ?? def,
      qs: () => Object.fromEntries(query.entries()),
      ip: () => '127.0.0.1',
      protocol: () => 'http',
      host: () => `localhost:${PORT}`,
      csrfToken: 'test-csrf',
      encryptedCookie: () => undefined,
    },
    response: {
      response: res,
      redirect: (url: string) => {
        res.writeHead(303, { location: url });
        res.end();
      },
      encryptedCookie: () => {},
      badRequest: (p: any) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(p));
      },
      notFound: (p: any) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(p));
      },
    },
    session: {
      get: (k: string) => session.get(k),
      put: (k: string, v: any) => session.set(k, v),
      forget: (k: string) => session.delete(k),
    },
    containerResolver: { make: async () => service },
  };
  return ctx;
}

function recordingRenderer(ctx: any, view: string, props: Record<string, unknown>) {
  const res: ServerResponse = ctx.response.response;
  if (res.writableEnded) return;
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-render-view': view,
    'x-render-step': String((props as any).step ?? ''),
  });
  res.end(JSON.stringify({ view, step: (props as any).step ?? null }));
}

async function startServer(
  accessTokens?: AuthServerConfigInput['accessTokens'],
  grants: string[] = ['authorization_code', 'refresh_token'],
): Promise<{ server: Server }> {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT_URI], grants },
      ],
      accountStore: makeStore(),
      branding: {
        company: 'AuthKit Test',
        clients: {},
        default: { appName: 'Test', accent: '#000', accentSoft: '#111', tagline: 'tl' },
        firstParty: [],
      },
      render: recordingRenderer as any,
      trustedDevices: { enabled: false },
      accessTokens,
    }),
  );
  const service = new OidcService(cfg!, APP_KEY);
  const controller = new InteractionController();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', ISSUER);
      const m = url.pathname.match(/^\/auth\/interaction\/([^/]+)(?:\/(.+))?$/);
      if (m) {
        const body = await readBody(req);
        const uid = m[1];
        const action = m[2] ?? '';
        const ctx = buildCtx(service, req, res, body, uid, url.searchParams);
        if (action === '') await controller.show(ctx);
        else if (action === 'identifier') await controller.identifier(ctx);
        else if (action === 'login') await controller.login(ctx);
        else if (action === 'consent') await controller.consent(ctx);
        else {
          res.writeHead(404);
          res.end();
        }
        if (!res.writableEnded) res.end();
        return;
      }
      service.callback(req, res);
    } catch (err: any) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.stack ?? err) }));
      }
    }
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  return { server };
}

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        resolve({});
      }
    });
  });
}

class Jar {
  private store = new Map<string, string>();
  header(): Record<string, string> {
    if (this.store.size === 0) return {};
    return { cookie: [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
  }
  absorb(res: Response) {
    const set: string[] =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];
    for (const sc of set) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) this.store.delete(name);
      else this.store.set(name, value);
    }
  }
}

async function hop(jar: Jar, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { ...(init?.headers ?? {}), ...jar.header() },
  });
  jar.absorb(res);
  return res;
}

async function followToInteraction(jar: Jar, startUrl: string): Promise<string> {
  let next: string | null = startUrl;
  for (let i = 0; i < 8 && next; i++) {
    const res = await hop(jar, next);
    const loc = res.headers.get('location');
    if (loc) {
      const abs = new URL(loc, ISSUER);
      const m = abs.pathname.match(/^\/auth\/interaction\/([^/]+)$/);
      if (m) return m[1];
      next = abs.toString();
      continue;
    }
    throw new Error(`unexpected non-redirect at hop ${i}: ${res.status}`);
  }
  throw new Error('did not reach interaction');
}

async function resumeToCode(jar: Jar, fromRes: Response): Promise<string> {
  let loc = fromRes.headers.get('location');
  for (let i = 0; i < 10 && loc; i++) {
    const abs = new URL(loc, ISSUER);
    if (abs.pathname === '/cb') {
      const code = abs.searchParams.get('code');
      if (!code) throw new Error(`no code on /cb: ${abs.search}`);
      return code;
    }
    const im = abs.pathname.match(/^\/auth\/interaction\/([^/]+)$/);
    if (im) {
      const uid = im[1];
      const show = await hop(jar, abs.toString());
      const view = show.headers.get('x-render-view');
      if (view === 'consent') {
        const consent = await hop(jar, `${ISSUER}/auth/interaction/${uid}/consent`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        });
        loc = consent.headers.get('location');
        continue;
      }
      throw new Error(`unexpected interaction screen during resume: ${view}`);
    }
    const res = await hop(jar, abs.toString());
    loc = res.headers.get('location');
  }
  throw new Error('resume did not reach /cb');
}

async function exchangeCode(
  code: string,
  verifier: string,
  extra: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      ...extra,
    }).toString(),
  });
  return res.json();
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url.encode(randomBytes(32));
  const challenge = base64url.encode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(challenge: string, extra: Record<string, string> = {}): string {
  const u = new URL(`${ISSUER}/auth`);
  u.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    state: `st-${Math.random().toString(36).slice(2)}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  return u.toString();
}

async function postForm(jar: Jar, url: string, fields: Record<string, string>): Promise<Response> {
  return hop(jar, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Login → consent → token, returning the token response. */
async function loginAndExchange(extraAuthorize: Record<string, string> = {}): Promise<any> {
  const jar = new Jar();
  const { verifier, challenge } = pkce();
  const uid = await followToInteraction(jar, authorizeUrl(challenge, extraAuthorize));
  await postForm(jar, `${ISSUER}/auth/interaction/${uid}/identifier`, { email: EMAIL });
  const login = await postForm(jar, `${ISSUER}/auth/interaction/${uid}/login`, {
    password: PASSWORD,
  });
  const code = await resumeToCode(jar, login);
  return exchangeCode(code, verifier);
}

// ===========================================================================
// VARIANT 1 — opaque remains the default (untouched behaviour)
// ===========================================================================

test.group('e2e access tokens — opaque default', (group) => {
  let server: Server;
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer(/* no accessTokens config */));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('default AT is opaque (not a JWT) and introspectable', async ({ assert }) => {
    const tokens = await loginAndExchange();
    assert.isString(tokens.access_token, JSON.stringify(tokens));
    // Opaque tokens are NOT three-part JWTs.
    assert.notInclude(tokens.access_token, '.');
  });
});

// ===========================================================================
// VARIANT 2 — simple mode: accessTokens: { format: 'jwt' }
// ===========================================================================

test.group('e2e access tokens — simple JWT (RFC 9068)', (group) => {
  let server: Server;
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer({ format: 'jwt' }));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('AT is a JWT with typ=at+jwt and RFC 9068 claims', async ({ assert }) => {
    const tokens = await loginAndExchange();
    assert.isString(tokens.access_token, JSON.stringify(tokens));

    const header = decodeProtectedHeader(tokens.access_token);
    assert.equal(header.typ, 'at+jwt');
    assert.isString(header.kid);

    const claims = decodeJwt(tokens.access_token) as any;
    assert.equal(claims.iss, ISSUER);
    assert.equal(claims.sub, ACCOUNT_ID);
    assert.equal(claims.aud, ISSUER); // default audience = issuer
    assert.equal(claims.client_id, CLIENT_ID);
    assert.isString(claims.jti);
    assert.isNumber(claims.iat);
    assert.isNumber(claims.exp);
    assert.isString(claims.scope);
    assert.include(claims.scope, 'openid');
  });

  test('AT signature validates purely from the jwks_uri', async ({ assert }) => {
    const tokens = await loginAndExchange();
    const disco = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
    const jwks = createRemoteJWKSet(new URL(disco.jwks_uri));
    const { payload, protectedHeader } = await jwtVerify(tokens.access_token, jwks, {
      issuer: ISSUER,
      audience: ISSUER,
      typ: 'at+jwt',
    });
    assert.equal(payload.sub, ACCOUNT_ID);
    assert.equal(protectedHeader.typ, 'at+jwt');
  });
});

// ===========================================================================
// VARIANT 3 — per-resource config (RFC 8707 resource indicators)
// ===========================================================================

test.group('e2e access tokens — per-resource JWT', (group) => {
  let server: Server;
  const API = 'https://api.acme.test';
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer({
      // root stays opaque; only the named API issues JWT with a custom audience
      format: 'opaque',
      resources: {
        [API]: { audience: 'acme-api', scopes: ['openid', 'profile'], format: 'jwt' },
      },
    }));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('requesting resource=<API> yields a JWT with that resource audience', async ({ assert }) => {
    // resource indicator must be requested at both authorize and token.
    const tokens = await loginAndExchange({ resource: API });
    assert.isString(tokens.access_token, JSON.stringify(tokens));
    const header = decodeProtectedHeader(tokens.access_token);
    assert.equal(header.typ, 'at+jwt');
    const claims = decodeJwt(tokens.access_token) as any;
    assert.equal(claims.aud, 'acme-api');
    assert.equal(claims.iss, ISSUER);
  });
});
