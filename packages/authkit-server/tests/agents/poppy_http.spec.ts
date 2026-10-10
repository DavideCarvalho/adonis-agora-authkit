import { test } from '@japa/runner';
import { setBootedApp } from '../../services/booted_app.js';
import {
  installPoppySlots,
  POPPY_AUTHENTICATE_SLOT,
  type PoppyAuthenticate,
  poppyAuth,
  poppyOf,
} from '../../src/agents/poppy/resource.js';
import { isBlockedAddress, safeFetchJson } from '../../src/agents/poppy/safe_fetch.js';
import { JWT_BEARER_GRANT } from '../../src/agents/poppy/service.js';
import { poppyWebSession } from '../../src/agents/poppy/web_session.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import AccountAppsController from '../../src/host/controllers/account_apps_controller.js';
import PoppyController from '../../src/host/controllers/poppy_controller.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { POPPY_WEB_SESSION_KEY } from '../../src/host/poppy_session_key.js';
import {
  ACCOUNT_ID,
  apiRequest,
  CLIENT_ID,
  dpopKey,
  dpopProof,
  type Env,
  ORDERS_API,
  POPPY_ISSUER,
  pkce,
  REDIRECT_URI,
  setupPoppy,
  TOKEN_URL,
} from './poppy_helpers.js';

function makeCtx(
  env: Env,
  opts: {
    method?: string;
    url?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    qs?: Record<string, unknown>;
    params?: Record<string, string>;
    session?: Record<string, unknown>;
  } = {},
) {
  const res = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const response: any = {
    header(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
      return response;
    },
    status(n: number) {
      res.status = n;
      return response;
    },
    send(b: unknown) {
      res.body = b;
      return response;
    },
    json(b: unknown) {
      res.body = b;
      return response;
    },
    notFound() {
      res.status = 404;
      return response;
    },
    forbidden() {
      res.status = 403;
      return response;
    },
    redirect(url: string) {
      res.status = 302;
      res.headers.location = url;
    },
  };
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const session = new Map(Object.entries(opts.session ?? {}));
  let regenerated = 0;
  const url = opts.url ?? 'https://shop.example/';
  const ctx: any = {
    request: {
      method: () => opts.method ?? 'POST',
      completeUrl: () => url.split('?')[0],
      hostname: () => opts.host ?? new URL(url).hostname,
      header: (name: string) => headers[name.toLowerCase()],
      headers: () => headers,
      all: () => ({ ...(opts.body ?? {}) }),
      body: () => opts.body ?? {},
      input: (key: string) => opts.body?.[key] ?? opts.qs?.[key],
      qs: () => opts.qs ?? {},
      param: (key: string) => opts.params?.[key],
      ip: () => '127.0.0.1',
      csrfToken: 'csrf',
    },
    response,
    session: {
      get: (k: string) => session.get(k),
      put: (k: string, v: unknown) => session.set(k, v),
      forget: (k: string) => session.delete(k),
      regenerate: async () => {
        regenerated++;
      },
      flash: () => {},
      flashMessages: { get: () => undefined },
    },
    containerResolver: {
      make: async (token: string) => (token === 'lucid.db' ? env.db : env.service),
    },
  };
  return { ctx, res, session, regenerated: () => regenerated };
}

test.group('poppy — HTTP', () => {
  test('GET /.well-known/poppy.json: 404 fora do domínio; metadata RFC 8414', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const c = new PoppyController();
    const ok = makeCtx(env, { url: 'https://www.shop.example/.well-known/poppy.json' });
    await c.discovery(ok.ctx);
    assert.equal(ok.res.status, 200);
    assert.equal((ok.res.body as any).organization.domain, 'shop.example');
    const evil = makeCtx(env, { url: 'https://evil.example/.well-known/poppy.json' });
    await c.discovery(evil.ctx);
    assert.equal(evil.res.status, 404);
    const meta = makeCtx(env);
    await c.metadata(meta.ctx);
    assert.deepEqual((meta.res.body as any).poppy_domains, ['shop.example', 'shop.example.co.uk']);
    await env.close();
  });

  test('token endpoint: status e headers dos erros; sucesso no-store', async ({ assert }) => {
    const env = await setupPoppy({ dpop: { requireNonce: true } });
    const c = new PoppyController();
    const dkey = await dpopKey();
    const form = await env.form({
      grant_type: JWT_BEARER_GRANT,
      assertion: await env.sessionAssertion(),
    });

    const noClient = makeCtx(env, { url: TOKEN_URL, body: { grant_type: JWT_BEARER_GRANT } });
    await c.token(noClient.ctx);
    assert.equal(noClient.res.status, 401);
    assert.equal((noClient.res.body as any).error, 'invalid_client');

    const nonce = makeCtx(env, {
      url: TOKEN_URL,
      body: form,
      headers: { dpop: await dpopProof(dkey) },
    });
    await c.token(nonce.ctx);
    assert.equal(nonce.res.status, 400);
    assert.equal((nonce.res.body as any).error, 'use_dpop_nonce');
    assert.isOk(nonce.res.headers['dpop-nonce']);
    assert.match(nonce.res.headers['www-authenticate'], /use_dpop_nonce/);

    const good = makeCtx(env, {
      url: TOKEN_URL,
      body: await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion(),
      }),
      headers: { dpop: await dpopProof(dkey, { nonce: nonce.res.headers['dpop-nonce'] }) },
    });
    await c.token(good.ctx);
    assert.equal(good.res.status, 200);
    assert.equal(good.res.headers['cache-control'], 'no-store');
    assert.equal((good.res.body as any).token_type, 'DPoP');
    await env.close();
  });

  test('browser-session: 303 + login na sessão do app; 400 sem cookie; asserção na URL recusada', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const c = new PoppyController();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    // Logada via Direct Sign-In.
    const { verifier, challenge } = pkce();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'poppy:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error('consent');
    const d = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['poppy:read'],
    });
    await env.poppy.token(
      await env.form({
        grant_type: 'authorization_code',
        code: new URL(d!.url).searchParams.get('code'),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        session_id,
      }),
      await dpopProof(dkey),
    );

    const assertion = await env.browserAssertion({
      session_id,
      return_to: 'https://shop.example/orders',
    });
    const ok = makeCtx(env, {
      url: `${POPPY_ISSUER}/browser-session`,
      body: { assertion },
      session: { [ACCOUNT_SESSION_KEY]: 'someone-else' },
    });
    await c.browserSession(ok.ctx);
    assert.equal(ok.res.status, 303);
    assert.equal(ok.res.headers.location, 'https://shop.example/orders');
    assert.equal(ok.session.get(ACCOUNT_SESSION_KEY), ACCOUNT_ID);
    assert.deepInclude(ok.session.get(POPPY_WEB_SESSION_KEY) as any, {
      sessionId: session_id,
      clientId: CLIENT_ID,
    });
    assert.equal(ok.regenerated(), 1);

    const bad = makeCtx(env, { url: `${POPPY_ISSUER}/browser-session`, body: { assertion } });
    await c.browserSession(bad.ctx);
    assert.equal(bad.res.status, 400);
    assert.isUndefined(bad.session.get(POPPY_WEB_SESSION_KEY));

    const inUrl = makeCtx(env, {
      url: `${POPPY_ISSUER}/browser-session`,
      qs: {
        assertion: await env.browserAssertion({ session_id, return_to: 'https://shop.example/' }),
      },
    });
    await c.browserSession(inUrl.ctx);
    assert.equal(inUrl.res.status, 400);

    // O cookie acompanha a Session: sign-out → o site desloga no próximo request.
    const grants = await env.poppy.listGrants(ACCOUNT_ID);
    await env.poppy.revokeGrant(grants[0].id);
    const next = makeCtx(env, {
      method: 'GET',
      url: 'https://shop.example/orders',
      session: Object.fromEntries(ok.session),
    });
    let called = false;
    await poppyWebSession()(next.ctx, async () => {
      called = true;
    });
    assert.isTrue(called);
    assert.isUndefined(next.session.get(ACCOUNT_SESSION_KEY));
    assert.isOk(next.session.get(POPPY_WEB_SESSION_KEY));
    await env.close();
  });

  test('mediated endpoint exige Session Token; poppyAuth anexa o principal', async ({ assert }) => {
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields: [{ name: 'pin', label: 'PIN', secret: true }],
          verify: async () => ({ status: 'complete', accountId: ACCOUNT_ID }),
        },
      },
    });
    const c = new PoppyController();
    const noToken = makeCtx(env, {
      url: `${POPPY_ISSUER}/sign-in`,
      body: { scope: 'poppy:read', credentials: { pin: '1' } },
    });
    await c.mediatedStart(noToken.ctx);
    assert.equal(noToken.res.status, 401);
    assert.match(noToken.res.headers['www-authenticate'], /^DPoP .*invalid_token/);

    const dkey = await dpopKey();
    const s = await env.startSession(dkey);
    const req = await apiRequest(dkey, s.access_token, {
      method: 'POST',
      url: `${POPPY_ISSUER}/sign-in`,
    });
    const ok = makeCtx(env, {
      url: req.url,
      headers: req.headers,
      body: { scope: 'poppy:read', credentials: { pin: '1' } },
    });
    await c.mediatedStart(ok.ctx);
    assert.equal(ok.res.status, 200);
    const body = ok.res.body as any;
    assert.equal(body.status, 'complete');

    const api = await apiRequest(dkey, body.access_token, { url: `${ORDERS_API}/1` });
    const apiCtx = makeCtx(env, { method: 'GET', url: api.url, headers: api.headers });
    let principal: any = null;
    await poppyAuth({ scopes: ['poppy:read'] })(apiCtx.ctx, async () => {
      principal = poppyOf(apiCtx.ctx);
    });
    assert.equal(principal.accountId, ACCOUNT_ID);
    const denied = makeCtx(env, {
      method: 'GET',
      url: api.url,
      headers: (await apiRequest(dkey, body.access_token, { url: api.url })).headers,
    });
    await poppyAuth({ scopes: ['addresses'] })(denied.ctx, async () => {});
    assert.equal(denied.res.status, 403);
    assert.match(denied.res.headers['www-authenticate'], /insufficient_scope.*scope="addresses"/);
    await env.close();
  });

  test('slot global @adonis-agora/poppy:authenticate (contrato do @adonis-agora/agent)', async ({
    assert,
  }) => {
    const env = await setupPoppy({ toActor: (p) => ({ id: p.accountId, tenant: 'acme' }) });
    setBootedApp({
      container: { make: async (t: string) => (t === 'lucid.db' ? env.db : env.service) },
    } as any);
    installPoppySlots(POPPY_ISSUER);
    const authenticate = (globalThis as any)[POPPY_AUTHENTICATE_SLOT] as PoppyAuthenticate;
    assert.equal((globalThis as any)[Symbol.for('@adonis-agora/poppy:issuer')], POPPY_ISSUER);
    const dkey = await dpopKey();
    const s = await env.startSession(dkey);
    const url = 'https://shop.example/poppy/conversations';
    const req = await apiRequest(dkey, s.access_token, { method: 'POST', url });
    const ok = await authenticate(req);
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.equal(ok.principal.userId, 'usr_Q7c1vK');
      assert.equal(ok.principal.clientId, CLIENT_ID);
      assert.isFalse(ok.principal.signedIn);
      assert.deepEqual(ok.principal.scopes, []);
      assert.match(ok.principal.sessionId, /^ses_/);
      assert.deepEqual(ok.principal.actor, { id: null, tenant: 'acme' });
    }
    const needs = await authenticate(
      await apiRequest(dkey, s.access_token, { method: 'POST', url }),
      { signedIn: true },
    );
    assert.isFalse(needs.ok);
    if (!needs.ok) {
      assert.equal(needs.status, 403);
      assert.equal(needs.error, 'sign_in_required');
      assert.match(needs.wwwAuthenticate, /sign_in_required/);
    }
    const none = await authenticate({ method: 'POST', url, headers: {} });
    assert.isTrue(!none.ok && none.status === 401 && none.error === 'invalid_token');
    await env.close();
  });

  test('console de conta lista e desconecta o agente Poppy', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const dev = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'poppy:read' }, `${POPPY_ISSUER}/oauth/device`),
    )) as any;
    await env.poppy.decideDevice({
      userCode: dev.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['poppy:read'],
    });
    await env.poppy.token(
      await env.form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: dev.device_code,
        session_id,
      }),
      await dpopProof(dkey),
    );
    const rendered: any[] = [];
    (env.service.config as any).render = async (_c: any, view: string, props: any) =>
      rendered.push({ view, props });
    const apps = new AccountAppsController();
    const page = makeCtx(env, { method: 'GET', session: { [ACCOUNT_SESSION_KEY]: ACCOUNT_ID } });
    await apps.index(page.ctx);
    const agents = rendered[0].props.agents;
    assert.lengthOf(agents, 1);
    assert.equal(agents[0].name, 'Example Agent');
    const revoke = makeCtx(env, {
      session: { [ACCOUNT_SESSION_KEY]: ACCOUNT_ID },
      params: { grantId: agents[0].id },
    });
    await apps.revokeAgent(revoke.ctx);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 0);
    assert.isFalse((await env.poppy.sessionState(session_id))!.signedIn);
    await env.close();
  });

  test('CSRF: isenta os endpoints de máquina, não as telas', async ({ assert }) => {
    const o = { mountPath: '/oidc', poppyPrefix: '/poppy' };
    for (const p of [
      '/poppy/oauth/token',
      '/poppy/oauth/revoke',
      '/poppy/oauth/device',
      '/poppy/sign-in',
      '/poppy/sign-in/sgn_1',
      '/poppy/browser-session',
    ]) {
      assert.isTrue(authkitCsrfExceptions(p, o), p);
    }
    assert.isFalse(authkitCsrfExceptions('/poppy/oauth/authorize', o));
    assert.isFalse(authkitCsrfExceptions('/poppy/device', o));
    assert.isFalse(
      authkitCsrfExceptions('/poppy/oauth/token', { mountPath: '/oidc', poppyPrefix: false }),
    );
  });
});

test.group('poppy — SSRF guard', () => {
  test('endereços internos são bloqueados', ({ assert }) => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '2002:7f00:1::1',
      'ff02::1',
    ]) {
      assert.isTrue(isBlockedAddress(ip), ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      assert.isFalse(isBlockedAddress(ip), ip);
    }
  });

  test('safeFetchJson: só https, IP literal interno, DNS para IP interno, sem credenciais', async ({
    assert,
  }) => {
    await assert.rejects(() => safeFetchJson('http://agent.example/agent.json'), /only https/);
    await assert.rejects(() => safeFetchJson('https://127.0.0.1/agent.json'), /blocked/);
    await assert.rejects(() => safeFetchJson('https://[::1]/agent.json'), /blocked/);
    await assert.rejects(() => safeFetchJson('https://u:p@agent.example/a'), /credentials/);
    await assert.rejects(
      () =>
        safeFetchJson('https://rebind.example/agent.json', {
          lookup: (_h, _o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
        }),
      /blocked/,
    );
    await assert.rejects(
      () =>
        safeFetchJson('https://mixed.example/agent.json', {
          lookup: (_h, _o, cb) =>
            cb(null, [
              { address: '93.184.216.34', family: 4 },
              { address: '192.168.0.1', family: 4 },
            ]),
        }),
      /blocked/,
    );
  });

  test('client_id http ou interno → invalid_client sem busca', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const r = await env.poppy
      .token(
        {
          client_id: 'http://agent.example/agent.json',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: 'x',
          grant_type: JWT_BEARER_GRANT,
        },
        await dpopProof(dkey),
      )
      .catch((e) => e);
    assert.equal(r.code, 'invalid_client');
    assert.notInclude(env.fetched, 'http://agent.example/agent.json');
    assert.isOk(TOKEN_URL);
    await env.close();
  });
});
