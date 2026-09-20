/**
 * Ponte SSO sessão do IdP → sessão do console (`accountSession.acceptIdpSession`).
 *
 * Sobe um OidcService real (RedisMock), cria uma sessão do oidc-provider para
 * uma conta e assina o cookie `_session` com as keys do provider — o mesmo
 * cookie que o browser carrega depois da interaction de login. O ctx Adonis é
 * fake (sessão em Map), como nos demais testes de host.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import {
  ACCOUNT_IDP_SESSION_KEY,
  endBridgedIdpSession,
  ensureConsoleSession,
} from '../../src/host/idp_session_bridge.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../bootstrap.js';

const ISSUER = 'http://localhost:9991';

async function makeService(acceptIdpSession: boolean, disabled: string[] = []) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [],
      accountStore: fakeAccountStore({
        findById: async (id: string) =>
          id === 'ghost' ? null : ({ id, email: `${id}@x.com`, globalRoles: [] } as any),
        isDisabled: async (id: string) => disabled.includes(id),
        disableAccount: async () => {},
        enableAccount: async () => {},
      } as any),
      ...(acceptIdpSession ? { accountSession: { acceptIdpSession: true } } : {}),
    }),
  );
  return new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
}

/** Cria uma sessão do IdP logada e devolve o header Cookie que o browser mandaria. */
async function idpSessionCookie(service: OidcService, accountId: string) {
  const provider: any = service.provider;
  const session = new provider.Session({ accountId, loginTs: Math.floor(Date.now() / 1000) });
  await session.save(3600);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const kctx = provider.createContext(new IncomingMessage(new Socket()), res);
  kctx.cookies.set(provider.cookieName('session'), session.jti, { signed: true });
  const setCookie = res.getHeader('set-cookie') as string[];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { session, cookie };
}

function fakeCtx(service: OidcService, cookie?: string, initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const req = new IncomingMessage(new Socket());
  if (cookie) req.headers.cookie = cookie;
  const res = new ServerResponse(req);
  let regenerated = 0;
  const ctx: any = {
    request: { request: req, ip: () => '127.0.0.1' },
    response: { response: res },
    session: {
      get: (k: string) => store.get(k),
      put: (k: string, v: unknown) => store.set(k, v),
      forget: (k: string) => store.delete(k),
      regenerate: async () => {
        regenerated++;
      },
    },
    containerResolver: { make: async () => service },
  };
  return { ctx, store, regenerated: () => regenerated };
}

test.group('ponte SSO IdP → console de conta', () => {
  test('default (desligado): sessão do IdP NÃO abre o console', async ({ assert }) => {
    const service = await makeService(false);
    const { cookie } = await idpSessionCookie(service, 'user-1');
    const { ctx, store } = fakeCtx(service, cookie);

    assert.isFalse(await ensureConsoleSession(ctx));
    assert.isUndefined(store.get(ACCOUNT_SESSION_KEY));
  });

  test('ligado: sessão ativa do IdP abre o console para a conta dela', async ({ assert }) => {
    const service = await makeService(true);
    const { session, cookie } = await idpSessionCookie(service, 'user-1');
    const { ctx, store, regenerated } = fakeCtx(service, cookie);

    assert.isTrue(await ensureConsoleSession(ctx));
    assert.equal(store.get(ACCOUNT_SESSION_KEY), 'user-1');
    assert.equal(store.get(ACCOUNT_IDP_SESSION_KEY), session.uid);
    assert.equal(regenerated(), 1); // anti-fixation
  });

  test('ligado: sem cookie do IdP (ou cookie forjado) → sem console', async ({ assert }) => {
    const service = await makeService(true);
    assert.isFalse(await ensureConsoleSession(fakeCtx(service).ctx));
    // id de sessão sem a assinatura das keys do provider é ignorado
    const forged = fakeCtx(service, '_session=abc; _session.sig=nope');
    assert.isFalse(await ensureConsoleSession(forged.ctx));
  });

  test('ligado: conta desabilitada ou inexistente não entra', async ({ assert }) => {
    const service = await makeService(true, ['user-off']);
    const off = await idpSessionCookie(service, 'user-off');
    assert.isFalse(await ensureConsoleSession(fakeCtx(service, off.cookie).ctx));
    const ghost = await idpSessionCookie(service, 'ghost');
    assert.isFalse(await ensureConsoleSession(fakeCtx(service, ghost.cookie).ctx));
  });

  test('login próprio do console (sem ponte) segue intocado', async ({ assert }) => {
    const service = await makeService(true);
    const { ctx, store } = fakeCtx(service, undefined, { [ACCOUNT_SESSION_KEY]: 'user-9' });
    assert.isTrue(await ensureConsoleSession(ctx));
    assert.equal(store.get(ACCOUNT_SESSION_KEY), 'user-9');
  });

  test('sessão do IdP encerrada → console derivado dela encerra junto', async ({ assert }) => {
    const service = await makeService(true);
    const { session, cookie } = await idpSessionCookie(service, 'user-1');
    const { ctx, store } = fakeCtx(service, cookie);
    assert.isTrue(await ensureConsoleSession(ctx));

    await session.destroy(); // logout OIDC / expiração
    assert.isFalse(await ensureConsoleSession(ctx));
    assert.isUndefined(store.get(ACCOUNT_SESSION_KEY));
    assert.isUndefined(store.get(ACCOUNT_IDP_SESSION_KEY));
  });

  test('"Sair" do console aberto pela ponte encerra a sessão do IdP', async ({ assert }) => {
    const service = await makeService(true);
    const { session, cookie } = await idpSessionCookie(service, 'user-1');
    const { ctx, store } = fakeCtx(service, cookie);
    assert.isTrue(await ensureConsoleSession(ctx));

    await endBridgedIdpSession(ctx);
    assert.isUndefined(store.get(ACCOUNT_IDP_SESSION_KEY));
    assert.isUndefined(await (service.provider as any).Session.find(session.jti));
  });
});
