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
import { MEDIATED_SIGN_IN_GRANT } from '../../src/agents/poppy/service.js';
import { poppyWebSession } from '../../src/agents/poppy/web_session.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import AccountAppsController from '../../src/host/controllers/account_apps_controller.js';
import PoppyController from '../../src/host/controllers/poppy_controller.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { POPPY_WEB_SESSION_KEY } from '../../src/host/poppy_session_key.js';
import {
  ACCOUNT_ID,
  CLIENT_ID,
  dpopKey,
  dpopProof,
  type Env,
  ORDERS_API,
  OTHER_ACCOUNT_ID,
  POPPY_ISSUER,
  setupPoppy,
  TOKEN_URL,
} from './poppy_helpers.js';

const JOIN_URL = `${POPPY_ISSUER}/browser-session`;

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
    append(k: string, v: string) {
      const key = k.toLowerCase();
      res.headers[key] = res.headers[key] ? `${res.headers[key]}\n${v}` : v;
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
      host: () => opts.host ?? new URL(url).host,
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

/** Passos 1 e 2 da entrada do navegador: `{ code, cookie }` autorizados. */
async function authorizedJoin(env: Env, c: PoppyController, opts: { token?: string; sid: string }) {
  const page = makeCtx(env, { method: 'GET', url: JOIN_URL });
  await c.browserSessionPage(page.ctx);
  const code = /name="code" value="([^"]+)"/.exec(String(page.res.body))![1];
  const cookie = /__Host-poppy_join=([^;]+)/.exec(page.res.headers['set-cookie'])![1];
  const req = await env.request({
    method: 'POST',
    url: `${JOIN_URL}/authorize`,
    sid: opts.sid,
    token: opts.token,
  });
  const auth = makeCtx(env, { url: req.url, headers: req.headers, body: { code } });
  await c.browserSessionAuthorize(auth.ctx);
  return { page, auth, code, cookie };
}

test.group('poppy — HTTP', () => {
  test('poppy.json: 404 fora do domínio, www. redireciona; protected resource; RFC 8414', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const c = new PoppyController();
    const ok = makeCtx(env, { url: 'https://shop.example/.well-known/poppy.json' });
    await c.discovery(ok.ctx);
    assert.equal(ok.res.status, 200);
    assert.equal((ok.res.body as any).protocol_version, '0.3');
    assert.equal((ok.res.body as any).organization.domain, 'shop.example');

    const www = makeCtx(env, { url: 'https://www.shop.example/.well-known/poppy.json' });
    await c.discovery(www.ctx);
    assert.equal(www.res.status, 308);
    assert.equal(www.res.headers.location, 'https://shop.example/.well-known/poppy.json');

    const evil = makeCtx(env, { url: 'https://evil.example/.well-known/poppy.json' });
    await c.discovery(evil.ctx);
    assert.equal(evil.res.status, 404);

    const prm = makeCtx(env, {
      url: 'https://shop.example.co.uk/.well-known/oauth-protected-resource',
    });
    await c.protectedResource(prm.ctx);
    assert.deepEqual(prm.res.body, {
      resource: 'https://shop.example.co.uk',
      authorization_servers: [POPPY_ISSUER],
    });
    const prmEvil = makeCtx(env, {
      url: 'https://evil.example/.well-known/oauth-protected-resource',
    });
    await c.protectedResource(prmEvil.ctx);
    assert.equal(prmEvil.res.status, 404);

    const meta = makeCtx(env);
    await c.metadata(meta.ctx);
    assert.includeMembers((meta.res.body as any).protected_resources, [
      'https://shop.example',
      'https://shop.example.co.uk',
    ]);
    await env.close();
  });

  test('token endpoint: status dos erros, code_required com campos no corpo, 429 sem corpo', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      rateLimit: async ({ key }) => (key.includes('blocked') ? 30 : null),
      signIn: {
        mediated: {
          fields: [{ name: 'email', label: 'Email', secret: false }],
          scopes: ['orders:read'],
          verify: async () => ({
            status: 'code_required',
            accountId: ACCOUNT_ID,
            sentTo: 'x',
            code: '1',
          }),
        },
      },
      dpop: { requireNonce: true },
    });
    const c = new PoppyController();

    const noClient = makeCtx(env, { url: TOKEN_URL, body: { grant_type: 'refresh_token' } });
    await c.token(noClient.ctx);
    assert.equal(noClient.res.status, 401);
    assert.equal((noClient.res.body as any).error, 'invalid_client');

    const dkey = await dpopKey();
    const nonce = makeCtx(env, {
      url: TOKEN_URL,
      body: await env.form({ grant_type: 'refresh_token', refresh_token: 'x' }),
      headers: { dpop: await dpopProof(dkey) },
    });
    await c.token(nonce.ctx);
    assert.equal(nonce.res.status, 400);
    assert.equal((nonce.res.body as any).error, 'use_dpop_nonce');
    assert.isOk(nonce.res.headers['dpop-nonce']);

    const code = makeCtx(env, {
      url: TOKEN_URL,
      body: await env.form({
        grant_type: MEDIATED_SIGN_IN_GRANT,
        scope: 'orders:read',
        email: 'a@b.c',
      }),
      headers: {
        dpop: await dpopProof(dkey, { nonce: nonce.res.headers['dpop-nonce'] }),
      },
    });
    await c.token(code.ctx);
    assert.equal(code.res.status, 400);
    const body = code.res.body as any;
    assert.equal(body.error, 'code_required');
    assert.equal(body.sent_to, 'x');
    assert.isNumber(body.expires_in);
    assert.isOk(body.sign_in_id);
    assert.equal(code.res.headers['cache-control'], 'no-store');
    await env.close();

    const limited = await setupPoppy({
      rateLimit: async () => 30,
      signIn: {
        mediated: {
          fields: [{ name: 'email', label: 'Email', secret: false }],
          scopes: ['orders:read'],
          verify: async () => ({ status: 'failed' }),
        },
      },
    });
    const over = makeCtx(limited, {
      url: TOKEN_URL,
      body: await limited.form({
        grant_type: MEDIATED_SIGN_IN_GRANT,
        scope: 'orders:read',
        email: 'a@b.c',
      }),
    });
    await c.token(over.ctx);
    assert.equal(over.res.status, 429);
    assert.equal(over.res.headers['retry-after'], '30');
    assert.equal(over.res.body, '');
    await limited.close();
  });

  test('entrada do navegador: página, autorização, envio → cookie da Session e 303', async ({
    assert,
  }) => {
    const env = await setupPoppy({ web: { redirectTo: '/orders' } });
    const c = new PoppyController();
    const signed = await env.signIn();
    const { page, auth, code, cookie } = await authorizedJoin(env, c, {
      sid: 'join1',
      token: signed.access_token,
    });

    assert.equal(page.res.status, 200);
    assert.equal(page.res.headers['cache-control'], 'no-store');
    assert.equal(page.res.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(page.res.headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(
      page.res.headers['set-cookie'],
      /Path=\/; Max-Age=60; Secure; HttpOnly; SameSite=Strict/,
    );
    assert.isUndefined(page.session.get(POPPY_WEB_SESSION_KEY));
    assert.equal(auth.res.status, 204);

    // O mesmo código não é autorizado de novo.
    const req = await env.request({ method: 'POST', url: `${JOIN_URL}/authorize`, sid: 'join1' });
    const again = makeCtx(env, { url: req.url, headers: req.headers, body: { code } });
    await c.browserSessionAuthorize(again.ctx);
    assert.equal(again.res.status, 400);
    assert.deepEqual(again.res.body, { error: 'invalid_request' });

    const ok = makeCtx(env, {
      url: JOIN_URL,
      body: { code },
      headers: { cookie: `other=1; __Host-poppy_join=${cookie}` },
      session: { [ACCOUNT_SESSION_KEY]: 'someone-else' },
    });
    await c.browserSession(ok.ctx);
    assert.equal(ok.res.status, 303);
    assert.equal(ok.res.headers.location, '/orders');
    assert.match(ok.res.headers['set-cookie'], /__Host-poppy_join=; Path=\/; Max-Age=0/);
    assert.equal(ok.session.get(ACCOUNT_SESSION_KEY), ACCOUNT_ID);
    assert.deepInclude(ok.session.get(POPPY_WEB_SESSION_KEY) as any, {
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
    });
    assert.equal(ok.regenerated(), 1);

    // Uso único.
    const replay = makeCtx(env, {
      url: JOIN_URL,
      body: { code },
      headers: { cookie: `__Host-poppy_join=${cookie}` },
    });
    await c.browserSession(replay.ctx);
    assert.equal(replay.res.status, 400);

    // Sign-out: o site sai no próximo request, e a Session continua.
    const [grant] = await env.poppy.listGrants(ACCOUNT_ID);
    await env.poppy.revokeGrant(grant.id);
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
    assert.isNull((next.session.get(POPPY_WEB_SESSION_KEY) as any).accountId);
    await env.close();
  });

  test('entrada do navegador: sem cookie, código não autorizado e o primeiro envio consome', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const c = new PoppyController();

    // Cookie de outro navegador: falha, e o código não serve mais.
    const a = await authorizedJoin(env, c, { sid: 'join2' });
    const other = makeCtx(env, {
      url: JOIN_URL,
      body: { code: a.code },
      headers: { cookie: '__Host-poppy_join=outro' },
    });
    await c.browserSession(other.ctx);
    assert.equal(other.res.status, 400);
    assert.isUndefined(other.session.get(POPPY_WEB_SESSION_KEY));
    const late = makeCtx(env, {
      url: JOIN_URL,
      body: { code: a.code },
      headers: { cookie: `__Host-poppy_join=${a.cookie}` },
    });
    await c.browserSession(late.ctx);
    assert.equal(late.res.status, 400);

    // Código que o agente não autorizou.
    const page = makeCtx(env, { method: 'GET', url: JOIN_URL });
    await c.browserSessionPage(page.ctx);
    const code = /name="code" value="([^"]+)"/.exec(String(page.res.body))![1];
    const cookie = /__Host-poppy_join=([^;]+)/.exec(page.res.headers['set-cookie'])![1];
    const unauthorized = makeCtx(env, {
      url: JOIN_URL,
      body: { code },
      headers: { cookie: `__Host-poppy_join=${cookie}` },
    });
    await c.browserSession(unauthorized.ctx);
    assert.equal(unauthorized.res.status, 400);

    // Código expirado.
    const old = await authorizedJoin(env, c, { sid: 'join3' });
    env.setNow(Date.now() + 61_000);
    const expired = makeCtx(env, {
      url: JOIN_URL,
      body: { code: old.code },
      headers: { cookie: `__Host-poppy_join=${old.cookie}` },
    });
    await c.browserSession(expired.ctx);
    assert.equal(expired.res.status, 400);
    env.setNow(null);

    // Sem o header da Session: invalid_session, no corpo.
    const noHeader = makeCtx(env, { url: `${JOIN_URL}/authorize`, body: { code: 'x' } });
    await c.browserSessionAuthorize(noHeader.ctx);
    assert.equal(noHeader.res.status, 400);
    assert.equal((noHeader.res.body as any).error, 'invalid_session');
    await env.close();
  });

  test('entrada sem access token não mexe no login do navegador; com outra conta, troca', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const c = new PoppyController();
    const out = await authorizedJoin(env, c, { sid: 'join4' });
    const keep = makeCtx(env, {
      url: JOIN_URL,
      body: { code: out.code },
      headers: { cookie: `__Host-poppy_join=${out.cookie}` },
      session: { [ACCOUNT_SESSION_KEY]: OTHER_ACCOUNT_ID },
    });
    await c.browserSession(keep.ctx);
    assert.equal(keep.res.status, 303);
    assert.equal(keep.session.get(ACCOUNT_SESSION_KEY), OTHER_ACCOUNT_ID);
    assert.isNull((keep.session.get(POPPY_WEB_SESSION_KEY) as any).accountId);

    const next = makeCtx(env, {
      method: 'GET',
      url: 'https://shop.example/',
      session: Object.fromEntries(keep.session),
    });
    await poppyWebSession()(next.ctx, async () => {});
    assert.equal(next.session.get(ACCOUNT_SESSION_KEY), OTHER_ACCOUNT_ID);
    await env.close();
  });

  test('poppyAuth: anexa o principal; erros de token só no header, invalid_session no corpo', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const signed = await env.signIn({ scope: 'orders:read' });
    const url = `${ORDERS_API}/1`;

    const req = await env.request({ url, token: signed.access_token });
    const ok = makeCtx(env, { method: 'GET', url, headers: req.headers });
    let principal: any = null;
    await poppyAuth({ scopes: ['orders:read'] })(ok.ctx, async () => {
      principal = poppyOf(ok.ctx);
    });
    assert.equal(principal.accountId, ACCOUNT_ID);

    const denied = makeCtx(env, {
      method: 'GET',
      url,
      headers: (await env.request({ url, token: signed.access_token })).headers,
    });
    await poppyAuth({ scopes: ['addresses'] })(denied.ctx, async () => {});
    assert.equal(denied.res.status, 403);
    assert.match(
      denied.res.headers['www-authenticate'],
      /^Bearer .*insufficient_scope.*scope="addresses"/,
    );
    assert.equal(denied.res.body, '');

    const out = makeCtx(env, { method: 'GET', url, headers: (await env.request({ url })).headers });
    await poppyAuth({ scopes: ['orders:read'] })(out.ctx, async () => {});
    assert.equal(out.res.status, 401);
    assert.notMatch(out.res.headers['www-authenticate'], /error=/);
    assert.match(out.res.headers['www-authenticate'], /scope="orders:read"/);

    const none = makeCtx(env, { method: 'GET', url });
    await poppyAuth()(none.ctx, async () => {});
    assert.equal(none.res.status, 400);
    assert.equal((none.res.body as any).error, 'invalid_session');
    assert.isUndefined(none.res.headers['www-authenticate']);
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
    const url = 'https://shop.example/poppy/conversations';
    const ok = await authenticate(await env.request({ method: 'POST', url, agentId: 'agt_1' }));
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.equal(ok.principal.userId, 'usr_Q7c1vK');
      assert.equal(ok.principal.agentId, 'agt_1');
      assert.equal(ok.principal.clientId, CLIENT_ID);
      assert.isFalse(ok.principal.signedIn);
      assert.isNull(ok.principal.tokenType);
      assert.deepEqual(ok.principal.scopes, []);
      assert.match(ok.principal.sessionId, /^ses_/);
      assert.deepEqual(ok.principal.actor, { id: null, tenant: 'acme' });
    }
    const needs = await authenticate(await env.request({ method: 'POST', url, agentId: 'agt_1' }), {
      signedIn: true,
    });
    assert.isFalse(needs.ok);
    if (!needs.ok) {
      assert.equal(needs.status, 401);
      assert.isNull(needs.error);
      assert.match(needs.wwwAuthenticate!, /^Bearer/);
    }
    const none = await authenticate({ method: 'POST', url, headers: {} });
    assert.isTrue(!none.ok && none.status === 400 && none.error === 'invalid_session');
    await env.close();
  });

  test('console de conta lista e desconecta o agente Poppy', async ({ assert }) => {
    const env = await setupPoppy();
    const signed = await env.signIn({ scope: 'orders:read' });
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
    const check = await env.poppy.verifyAccess(await env.request({ token: signed.access_token }));
    assert.isTrue(!check.ok && check.error === 'invalid_token');
    await env.close();
  });

  test('CSRF: isenta os endpoints de máquina, não as telas', async ({ assert }) => {
    const o = { mountPath: '/oidc', poppyPrefix: '/poppy' };
    for (const p of [
      '/poppy/oauth/token',
      '/poppy/oauth/revoke',
      '/poppy/oauth/device',
      '/poppy/browser-session',
      '/poppy/browser-session/authorize',
    ]) {
      assert.isTrue(authkitCsrfExceptions(p, o), p);
    }
    assert.isFalse(authkitCsrfExceptions('/poppy/sign-in', o));
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
      '::ffff:0:127.0.0.1',
      '64:ff9b::10.0.0.1',
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
          grant_type: 'refresh_token',
        },
        await dpopProof(dkey),
      )
      .catch((e) => e);
    assert.equal(r.code, 'invalid_client');
    assert.notInclude(env.fetched, 'http://agent.example/agent.json');
    await env.close();
  });
});
