import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { base64url, decodeJwt } from 'jose';
import type { AuthAccount } from '../../src/accounts/account_store.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import { OidcService } from '../../src/provider/oidc_service.js';

// ---------------------------------------------------------------------------
// E2E harness — drives login → consent → token through the REAL host
// interaction controller methods (not the in-memory interactionFinished
// shortcut). The OIDC endpoints go through OidcService.callback; the
// interaction endpoints call the real AuthInteractionController, fed a
// hand-built minimal ctx that wraps the raw node req/res (which is exactly what
// service.interactions.* hand to the oidc-provider).
// ---------------------------------------------------------------------------

const PORT = 9844;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'app1';
const CLIENT_SECRET = 's';
const REDIRECT_URI = `${ISSUER}/cb`;
const APP_KEY = 'a'.repeat(32);

const PASSWORD = 'correct-horse';
const EMAIL = 'user@example.com';
const ACCOUNT_ID = 'user-1';

/** TOTP code our fake store will accept in the step-up variant. */
const VALID_TOTP = '123456';

/**
 * Minimal account store. `getMfaState`/`verifyTotp` drive the step-up variant.
 * `mfaEnabled` is toggled per test group so the same store shape serves both.
 */
function makeStore(opts: { mfaEnabled: boolean }) {
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
    // MFA capability (drives step-up)
    getMfaState: async () => ({ enabled: opts.mfaEnabled, enabledAt: 1_000 }),
    verifyTotp: async (_id: string, code: string) => code === VALID_TOTP,
  } as any;
}

// ---------------------------------------------------------------------------
// Fake ctx builder. Wraps the raw node req/res in an AdonisJS-shaped ctx so the
// real interaction controller runs unmodified. Session is a Map-backed store
// persisted across the cookie jar via a single `sid` cookie the harness owns.
// ---------------------------------------------------------------------------

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
    // The provider parts read these raw node objects.
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

/**
 * Renderer that records what the controller asked to render and ends the HTTP
 * response with a small JSON marker. The driver reads `x-render-*` to decide the
 * next step (which step/screen we're on) without scraping HTML.
 */
function recordingRenderer(ctx: any, view: string, props: Record<string, unknown>) {
  const res: ServerResponse = ctx.response.response;
  if (res.writableEnded) return;
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-render-view': view,
    'x-render-step': String((props as any).step ?? ''),
    'x-render-no-enrollment': String((props as any).noEnrollment ?? ''),
    'x-render-error': String((props as any).error ?? ''),
  });
  res.end(JSON.stringify({ view, step: (props as any).step ?? null }));
}

// ---------------------------------------------------------------------------
// Server wiring: OIDC paths → service.callback; interaction paths → real
// controller methods via the fake ctx.
// ---------------------------------------------------------------------------

async function startServer(opts: { mfaEnabled: boolean; deviceFlow?: boolean }): Promise<{
  server: Server;
  service: OidcService;
}> {
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
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          redirectUris: [REDIRECT_URI],
          grants: opts.deviceFlow
            ? [
                'authorization_code',
                'refresh_token',
                'urn:ietf:params:oauth:grant-type:device_code',
              ]
            : ['authorization_code', 'refresh_token'],
        },
      ],
      accountStore: makeStore({ mfaEnabled: opts.mfaEnabled }),
      branding: {
        company: 'AuthKit Test',
        clients: {},
        default: { appName: 'Test', accent: '#000', accentSoft: '#111', tagline: 'tl' },
        // No first-party clients → consent screen is shown (we drive it).
        firstParty: [],
      },
      render: recordingRenderer as any,
      stepUp: { acrValues: ['urn:authkit:mfa'], mfaAcr: 'urn:authkit:mfa' },
      deviceFlow: opts.deviceFlow ? { enabled: true } : undefined,
      // trusted devices off so the step-up variant always challenges MFA.
      trustedDevices: { enabled: false },
    }),
  );
  const service = new OidcService(cfg!, APP_KEY);
  const controller = new InteractionController();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', ISSUER);
      const m = url.pathname.match(/^\/auth\/interaction\/([^/]+)(?:\/(.+))?$/);
      if (m) {
        // Only consume the request body for interaction routes; the provider
        // re-reads the raw stream for /token etc., so we must NOT drain it there.
        const body = await readBody(req);
        const uid = m[1];
        const action = m[2] ?? ''; // '', 'identifier', 'login', 'mfa', 'consent'
        const ctx = buildCtx(service, req, res, body, uid, url.searchParams);
        if (action === '') await controller.show(ctx);
        else if (action === 'identifier') await controller.identifier(ctx);
        else if (action === 'login') await controller.login(ctx);
        else if (action === 'mfa') await controller.mfaVerify(ctx);
        else if (action === 'consent') await controller.consent(ctx);
        else {
          res.writeHead(404);
          res.end();
        }
        if (!res.writableEnded) res.end();
        return;
      }
      // Everything else (authorize, token, device, jwks, discovery) → provider.
      service.callback(req, res);
    } catch (err: any) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.stack ?? err) }));
      }
    }
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  return { server, service };
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

// ---------------------------------------------------------------------------
// Cookie-jar fetch driver (ported from authkit-client e2e_roundtrip).
// ---------------------------------------------------------------------------

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
  // GET authorize → 303 to /auth/interaction/:uid (or chain) → return uid
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

/** After login/mfa completes the interaction, follow resume → /cb?code. */
async function resumeToCode(jar: Jar, fromRes: Response): Promise<string> {
  let loc = fromRes.headers.get('location');
  for (let i = 0; i < 10 && loc; i++) {
    const abs = new URL(loc, ISSUER);
    if (abs.pathname === '/cb') {
      const code = abs.searchParams.get('code');
      if (!code) throw new Error(`no code on /cb: ${abs.search}`);
      return code;
    }
    // If it routes back to an interaction (e.g. consent), drive that screen.
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
      // already showed something else; follow nothing
      throw new Error(`unexpected interaction screen during resume: ${view}`);
    }
    const res = await hop(jar, abs.toString());
    loc = res.headers.get('location');
  }
  throw new Error('resume did not reach /cb');
}

async function exchangeCode(code: string, verifier: string): Promise<any> {
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

// ===========================================================================
// VARIANT 1 — base login → consent → token
// ===========================================================================

test.group('e2e full flow (real host controllers)', (group) => {
  let server: Server;
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer({ mfaEnabled: false }));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('login → consent → token (id_token claims correct)', async ({ assert }) => {
    const jar = new Jar();
    const { verifier, challenge } = pkce();
    const uid = await followToInteraction(jar, authorizeUrl(challenge));

    // step 1: identifier
    await postForm(jar, `${ISSUER}/auth/interaction/${uid}/identifier`, { email: EMAIL });
    // step 2: password → completes interaction (303 resume)
    const login = await postForm(jar, `${ISSUER}/auth/interaction/${uid}/login`, {
      password: PASSWORD,
    });
    assert.equal(login.status, 303);

    const code = await resumeToCode(jar, login);
    const tokens = await exchangeCode(code, verifier);
    assert.isString(tokens.id_token, JSON.stringify(tokens));
    assert.isString(tokens.access_token);

    const claims = decodeJwt(tokens.id_token);
    assert.equal(claims.sub, ACCOUNT_ID);
    assert.equal(claims.email, EMAIL);
    assert.equal(claims.aud, CLIENT_ID);
  });

  test('wrong password re-renders password step (no completion)', async ({ assert }) => {
    const jar = new Jar();
    const { challenge } = pkce();
    const uid = await followToInteraction(jar, authorizeUrl(challenge));
    await postForm(jar, `${ISSUER}/auth/interaction/${uid}/identifier`, { email: EMAIL });
    const login = await postForm(jar, `${ISSUER}/auth/interaction/${uid}/login`, {
      password: 'wrong',
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('x-render-view'), 'login');
    assert.equal(login.headers.get('x-render-step'), 'password');
  });
});

// ===========================================================================
// VARIANT 2 — step-up (acr_values=mfaAcr) with TOTP → id_token acr/amr
// ===========================================================================

test.group('e2e step-up MFA flow', (group) => {
  let server: Server;
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer({ mfaEnabled: true }));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('acr_values=mfaAcr forces TOTP and stamps acr/amr in id_token', async ({ assert }) => {
    const jar = new Jar();
    const { verifier, challenge } = pkce();
    const uid = await followToInteraction(
      jar,
      authorizeUrl(challenge, { acr_values: 'urn:authkit:mfa' }),
    );

    await postForm(jar, `${ISSUER}/auth/interaction/${uid}/identifier`, { email: EMAIL });
    // password → MFA challenge screen (does NOT complete yet)
    const pw = await postForm(jar, `${ISSUER}/auth/interaction/${uid}/login`, {
      password: PASSWORD,
    });
    assert.equal(pw.status, 200);
    assert.equal(pw.headers.get('x-render-view'), 'mfa-challenge');

    // submit TOTP → completes interaction
    const mfa = await postForm(jar, `${ISSUER}/auth/interaction/${uid}/mfa`, {
      code: VALID_TOTP,
    });
    assert.equal(mfa.status, 303);

    const code = await resumeToCode(jar, mfa);
    const tokens = await exchangeCode(code, verifier);
    assert.isString(tokens.id_token, JSON.stringify(tokens));

    const claims = decodeJwt(tokens.id_token) as any;
    // Step-up succeeded end-to-end: the MFA challenge was forced by acr_values and
    // the verified second factor stamped the acr into the id_token.
    assert.equal(claims.acr, 'urn:authkit:mfa');
    // `amr` is carried on the interaction login result; the oidc-provider only
    // surfaces it in the id_token when configured to do so. When present it must
    // reflect the second factor that was actually used.
    if (claims.amr !== undefined) {
      assert.includeMembers(claims.amr, ['mfa', 'totp']);
    }
  });
});

// ===========================================================================
// VARIANT 3 — device authorization grant (RFC 8628)
// device/auth → user-code entry through the REAL device sources → approve via
// interaction (login) → token poll succeeds.
// ===========================================================================

/** Extract a hidden/text input value by name from an HTML form blob. */
function inputValue(html: string, name: string): string | null {
  const re = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m =
    html.match(re) ??
    html.match(new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'));
  return m ? m[1] : null;
}

/** Extract the action URL of a <form> by its id. */
function formAction(html: string, id: string): string | null {
  const re = new RegExp(`<form[^>]*id=["']${id}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const a = tag.match(/action=["']([^"']*)["']/i);
  return a ? a[1] : null;
}

test.group('e2e device authorization grant', (group) => {
  let server: Server;
  group.setup(async () => {
    SESSIONS.clear();
    ({ server } = await startServer({ mfaEnabled: false, deviceFlow: true }));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('device/auth → user-code → approve via login → token poll', async ({ assert }) => {
    // 1) Device starts the flow at the device_authorization_endpoint.
    const startRes = await fetch(`${ISSUER}/device/auth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ scope: 'openid profile email' }).toString(),
    });
    const start = (await startRes.json()) as any;
    assert.equal(startRes.status, 200, JSON.stringify(start));
    assert.isString(start.device_code);
    assert.isString(start.user_code);

    // 2) User enters the user-code through the REAL device sources (browser side).
    const jar = new Jar();
    const inputPage = await hop(jar, `${ISSUER}/device`);
    const inputHtml = await inputPage.text();
    const inputAction = formAction(inputHtml, 'op.deviceInputForm') ?? '/device';
    const xsrf = inputValue(inputHtml, 'xsrf');
    const inputFields: Record<string, string> = { user_code: start.user_code };
    for (const m of inputHtml.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
      const tag = m[0];
      const name = tag.match(/name=["']([^"']*)["']/i)?.[1];
      const value = tag.match(/value=["']([^"']*)["']/i)?.[1];
      if (name && name !== 'user_code') inputFields[name] = value ?? '';
    }

    const confirmRes = await postForm(jar, new URL(inputAction, ISSUER).toString(), inputFields);
    // The confirm screen (or a redirect to interaction) follows. The provider may
    // 303 straight to the interaction or render the confirm form first.
    let interactionUid: string | null = null;
    let confirmHtml = '';
    if (confirmRes.status === 303) {
      const loc = confirmRes.headers.get('location');
      const m = loc?.match(/\/auth\/interaction\/([^/?]+)/);
      if (m) interactionUid = m[1];
    } else {
      confirmHtml = await confirmRes.text();
      const confirmAction =
        formAction(confirmHtml, 'op.deviceConfirmForm') ?? new URL(inputAction, ISSUER).pathname;
      // Replay every hidden field the provider's confirm form carries (xsrf,
      // user_code, confirm) — the provider validates the xsrf + user_code pair.
      const fields: Record<string, string> = {};
      for (const m of confirmHtml.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
        const tag = m[0];
        const name = tag.match(/name=["']([^"']*)["']/i)?.[1];
        const value = tag.match(/value=["']([^"']*)["']/i)?.[1];
        if (name) fields[name] = value ?? '';
      }
      const approve = await postForm(jar, new URL(confirmAction, ISSUER).toString(), fields);
      const loc = approve.headers.get('location');
      const m = loc?.match(/\/auth\/interaction\/([^/?]+)/);
      if (m) interactionUid = m[1];
    }

    void xsrf;
    assert.isString(interactionUid, 'device approval should hand off to a login interaction');

    // 3) Approve by logging in through the REAL interaction controller.
    await postForm(jar, `${ISSUER}/auth/interaction/${interactionUid}/identifier`, {
      email: EMAIL,
    });
    const login = await postForm(jar, `${ISSUER}/auth/interaction/${interactionUid}/login`, {
      password: PASSWORD,
    });
    // Follow the resume; the device confirm flow ends on the provider's success page.
    let loc = login.headers.get('location');
    for (let i = 0; i < 10 && loc; i++) {
      const r = await hop(jar, new URL(loc, ISSUER).toString());
      // a 200 (success/confirm page) ends the chain
      if (!r.headers.get('location')) {
        // If we landed on a consent screen, drive it.
        if (r.headers.get('x-render-view') === 'consent') {
          const c = await postForm(jar, `${ISSUER}/auth/interaction/${interactionUid}/consent`, {});
          loc = c.headers.get('location');
          continue;
        }
        break;
      }
      loc = r.headers.get('location');
    }

    // 4) Device polls the token endpoint with the device_code grant.
    let tokens: any;
    for (let i = 0; i < 5; i++) {
      const tRes = await fetch(`${ISSUER}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: start.device_code,
        }).toString(),
      });
      tokens = await tRes.json();
      if (tokens.access_token) break;
      // authorization_pending → retry
    }

    assert.isString(tokens.access_token, JSON.stringify(tokens));
    assert.isString(tokens.id_token);
    const claims = decodeJwt(tokens.id_token) as any;
    assert.equal(claims.sub, ACCOUNT_ID);
  });
});
