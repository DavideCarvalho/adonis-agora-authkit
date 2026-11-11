/**
 * Login do console pelo IdP (client interno `authkit-console`, `console_sso.ts`).
 *
 * Sobe um OidcService real (RedisMock) para o client estático e a sessão do IdP;
 * o ctx Adonis é fake (sessão em Map), como em `idp_session_bridge.spec.ts`.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import {
  CONSOLE_SSO_CALLBACK_PATH,
  CONSOLE_SSO_CLIENT_ID,
  CONSOLE_SSO_START_PATH,
  CONSOLE_SSO_STATE_KEY,
} from '../../src/host/console_sso.js';
import AccountSessionController from '../../src/host/controllers/account_session_controller.js';
import ConsoleSsoController from '../../src/host/controllers/console_sso_controller.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../bootstrap.js';

const ISSUER = 'http://localhost:9992/oidc';

function baseConfig(extra: Record<string, unknown> = {}) {
  return defineConfig({
    issuer: ISSUER,
    adapter: adapters.redis({ connection: 'main' }),
    jwks: { source: 'managed', algorithm: 'RS256' },
    accountStore: fakeAccountStore({
      findById: async (id: string) => ({ id, email: `${id}@x.com`, globalRoles: [] }) as any,
      isDisabled: async () => false,
      disableAccount: async () => {},
      enableAccount: async () => {},
    } as any),
    ...extra,
  } as any);
}

async function makeService(extra: Record<string, unknown> = {}) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(fakeApp, baseConfig(extra));
  return new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
}

async function idpSessionCookie(service: OidcService, accountId: string) {
  const provider: any = service.provider;
  const session = new provider.Session({ accountId, loginTs: Math.floor(Date.now() / 1000) });
  await session.save(3600);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const kctx = provider.createContext(new IncomingMessage(new Socket()), res);
  kctx.cookies.set(provider.cookieName('session'), session.jti, { signed: true });
  const setCookie = res.getHeader('set-cookie') as string[];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function fakeCtx(
  service: OidcService,
  opts: { cookie?: string; qs?: Record<string, unknown>; session?: Record<string, unknown> } = {},
) {
  const store = new Map<string, unknown>(Object.entries(opts.session ?? {}));
  const req = new IncomingMessage(new Socket());
  if (opts.cookie) req.headers.cookie = opts.cookie;
  const res = new ServerResponse(req);
  const out: { redirect?: string; status?: number; body?: unknown } = {};
  const ctx: any = {
    request: {
      request: req,
      ip: () => '127.0.0.1',
      qs: () => opts.qs ?? {},
      input: (k: string) => opts.qs?.[k],
      csrfToken: 'csrf',
    },
    response: {
      response: res,
      redirect: (url: string) => {
        out.redirect = url;
      },
      status(code: number) {
        out.status = code;
        return this;
      },
      send: (body: unknown) => {
        out.body = body;
      },
    },
    session: {
      get: (k: string) => store.get(k),
      put: (k: string, v: unknown) => store.set(k, v),
      forget: (k: string) => store.delete(k),
      regenerate: async () => {},
    },
    containerResolver: { make: async () => service },
  };
  return { ctx, store, out };
}

test.group('login do console pelo IdP: client interno', () => {
  test('ligado por padrão: o provider conhece o client `authkit-console`', async ({ assert }) => {
    const service = await makeService();
    const client = await (service.provider as any).Client.find(CONSOLE_SSO_CLIENT_ID);
    assert.exists(client);
    assert.deepEqual(client.responseTypes, ['none']);
    assert.deepEqual(client.redirectUris, [`http://localhost:9992${CONSOLE_SSO_CALLBACK_PATH}`]);
    assert.equal(client.tokenEndpointAuthMethod, 'none');
  });

  test('`acceptIdpSession: false`: sem client interno', async ({ assert }) => {
    const service = await makeService({ accountSession: { acceptIdpSession: false } });
    const client = await (service.provider as any).Client.find(CONSOLE_SSO_CLIENT_ID);
    assert.notExists(client);
  });

  test('`acceptIdpSession: false` + senha desligada: o config resolve (a recusa é no registerAuthHost)', async ({
    assert,
  }) => {
    const service = await makeService({
      accountSession: { acceptIdpSession: false },
      authMethods: { password: false },
    });
    assert.isFalse(service.config.accountSession.acceptIdpSession);
  });
});

test.group('login do console pelo IdP: rotas', () => {
  test('início: redireciona para o authorize do client interno e guarda o state', async ({
    assert,
  }) => {
    const service = await makeService();
    const { ctx, store, out } = fakeCtx(service, { qs: { return_to: '/auth/admin' } });
    await new ConsoleSsoController().start(ctx);

    assert.exists(out.redirect);
    const url = new URL(out.redirect!, 'http://localhost:9992');
    assert.equal(url.pathname, '/oidc/auth');
    assert.equal(url.searchParams.get('client_id'), CONSOLE_SSO_CLIENT_ID);
    assert.equal(url.searchParams.get('response_type'), 'none');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      `http://localhost:9992${CONSOLE_SSO_CALLBACK_PATH}`,
    );
    const pending = store.get(CONSOLE_SSO_STATE_KEY) as { state: string; returnTo: string };
    assert.equal(url.searchParams.get('state'), pending.state);
    assert.equal(pending.returnTo, '/auth/admin');
  });

  test('início: return_to externo é descartado (open-redirect)', async ({ assert }) => {
    const service = await makeService();
    const { ctx, store } = fakeCtx(service, { qs: { return_to: 'https://evil.test' } });
    await new ConsoleSsoController().start(ctx);
    assert.isNull((store.get(CONSOLE_SSO_STATE_KEY) as { returnTo: unknown }).returnTo);
  });

  test('início com sessão do IdP ativa: abre o console direto, sem passar pelo IdP', async ({
    assert,
  }) => {
    const service = await makeService();
    const cookie = await idpSessionCookie(service, 'user-1');
    const { ctx, store, out } = fakeCtx(service, { cookie, qs: { return_to: '/auth/admin' } });
    await new ConsoleSsoController().start(ctx);
    assert.equal(out.redirect, '/auth/admin');
    assert.equal(store.get(ACCOUNT_SESSION_KEY), 'user-1');
  });

  test('callback: state certo + sessão do IdP → console aberto e volta ao destino', async ({
    assert,
  }) => {
    const service = await makeService();
    const cookie = await idpSessionCookie(service, 'user-1');
    const { ctx, store, out } = fakeCtx(service, {
      cookie,
      qs: { state: 's1' },
      session: { [CONSOLE_SSO_STATE_KEY]: { state: 's1', returnTo: '/auth/admin' } },
    });
    await new ConsoleSsoController().callback(ctx);
    assert.equal(out.redirect, '/auth/admin');
    assert.equal(store.get(ACCOUNT_SESSION_KEY), 'user-1');
    assert.isUndefined(store.get(CONSOLE_SSO_STATE_KEY));
  });

  test('callback: state errado ou ausente → 400, sem console', async ({ assert }) => {
    const service = await makeService();
    const cookie = await idpSessionCookie(service, 'user-1');
    const { ctx, store, out } = fakeCtx(service, {
      cookie,
      qs: { state: 'forjado' },
      session: { [CONSOLE_SSO_STATE_KEY]: { state: 's1', returnTo: null } },
    });
    await new ConsoleSsoController().callback(ctx);
    assert.equal(out.status, 400);
    assert.isUndefined(store.get(ACCOUNT_SESSION_KEY));

    const none = fakeCtx(service, { cookie, qs: { state: 's1' } });
    await new ConsoleSsoController().callback(none.ctx);
    assert.equal(none.out.status, 400);
  });

  test('callback: o IdP devolveu erro → raiz, sem loop de volta ao console', async ({ assert }) => {
    const service = await makeService();
    const { ctx, out } = fakeCtx(service, {
      qs: { state: 's1', error: 'access_denied' },
      session: { [CONSOLE_SSO_STATE_KEY]: { state: 's1', returnTo: '/auth/admin' } },
    });
    await new ConsoleSsoController().callback(ctx);
    assert.equal(out.redirect, '/');
  });

  test('`acceptIdpSession: false`: o início cai no login próprio do console', async ({
    assert,
  }) => {
    const service = await makeService({ accountSession: { acceptIdpSession: false } });
    const { ctx, out } = fakeCtx(service, { qs: { return_to: '/auth/admin' } });
    await new ConsoleSsoController().start(ctx);
    assert.equal(out.redirect, '/account/login?return_to=%2Fauth%2Fadmin');
  });
});

test.group('GET /account/login com SSO', () => {
  test('default: vai para o login do IdP, preservando o return_to', async ({ assert }) => {
    const service = await makeService();
    const { ctx, out } = fakeCtx(service, { qs: { return_to: '/auth/admin' } });
    await new AccountSessionController().show(ctx);
    assert.equal(out.redirect, `${CONSOLE_SSO_START_PATH}?return_to=%2Fauth%2Fadmin`);
  });

  test('senha desligada: `?method=password` NÃO reabre o formulário', async ({ assert }) => {
    const service = await makeService({ authMethods: { password: false } });
    const { ctx, out } = fakeCtx(service, { qs: { method: 'password' } });
    await new AccountSessionController().show(ctx);
    assert.equal(out.redirect, CONSOLE_SSO_START_PATH);
  });
});
