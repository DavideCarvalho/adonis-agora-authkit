import { test } from '@japa/runner';
import { registerOidcClient } from '../src/register_oidc_client.js';

/**
 * O Adonis encaminha a query string da request atual no `redirect` por padrão
 * (`redirect.forwardQueryString`). O client sempre monta o destino, então todo
 * redirect dele precisa passar `false` — sem isso o `code`/`state`/`iss` do
 * callback vazam para a URL do app (`/?code=…`) e o `/auth/login` de um callback
 * falho arrasta o code antigo para o authorize seguinte.
 *
 * Aqui os handlers são capturados por um router falso e chamados direto, e cada
 * redirect é registrado com o segundo argumento (`forwardQueryString`).
 */

type Recorded = { pattern: string; handler: (ctx: any) => Promise<unknown> };

function fakeRouter() {
  const routes: Recorded[] = [];
  const make = (method: string) => (pattern: string, handler: (ctx: any) => Promise<unknown>) => {
    const recorded: Recorded = { pattern, handler };
    routes.push(recorded);
    const chain = {
      use: () => chain,
      as: () => chain,
      _method: method,
    };
    return chain;
  };
  return {
    routes,
    get: make('GET'),
    post: make('POST'),
  } as any;
}

function fakeCtx(overrides: { manager?: any; qs?: Record<string, string>; session?: any }) {
  const redirects: { url: string; forward: boolean | undefined }[] = [];
  const ctx = {
    containerResolver: { make: async () => overrides.manager },
    request: { qs: () => overrides.qs ?? {}, input: () => undefined },
    session: overrides.session,
    response: {
      redirect: (url: string, forward?: boolean) => {
        redirects.push({ url, forward });
        return undefined;
      },
    },
  } as any;
  return { ctx, redirects };
}

const manager = () => ({
  clientConfig: {
    issuer: 'https://idp.test/oidc',
    clientId: 'app',
    redirectUri: 'https://app.test/auth/callback',
    scopes: ['openid'],
  },
  startSession: () => undefined,
  createAuthenticator: async () => ({ getIdentity: async () => ({ globalRoles: [] }) }),
});

test.group('registerOidcClient: redirect não encaminha a query da request', () => {
  test('login → authorize sem forward da query', async ({ assert }) => {
    const router = fakeRouter();
    registerOidcClient(router);
    const login = router.routes.find((r: Recorded) => r.pattern === '/auth/login')!;

    const { ctx, redirects } = fakeCtx({ manager: manager(), session: { put: () => undefined } });
    await login.handler(ctx);

    assert.lengthOf(redirects, 1);
    assert.strictEqual(redirects[0].forward, false, 'login encaminhou a query da request');
    assert.include(redirects[0].url, '/oidc/auth?');
  });

  test('callback sem PKCE → /auth/login sem forward (o code não vaza)', async ({ assert }) => {
    const router = fakeRouter();
    registerOidcClient(router);
    const callback = router.routes.find((r: Recorded) => r.pattern === '/auth/callback')!;

    const { ctx, redirects } = fakeCtx({
      manager: manager(),
      qs: { code: 'stale-code', state: 'stale-state' },
      session: { get: () => undefined, forget: () => undefined },
    });
    await callback.handler(ctx);

    assert.lengthOf(redirects, 1);
    assert.strictEqual(redirects[0].url, '/auth/login');
    assert.strictEqual(redirects[0].forward, false, 'callback falho encaminhou a query');
  });

  test('callback com sucesso → destino do app sem forward', async ({ assert }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'at',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: 'header.payload.signature',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as any;

    try {
      const router = fakeRouter();
      registerOidcClient(router);
      const callback = router.routes.find((r: Recorded) => r.pattern === '/auth/callback')!;

      const { ctx, redirects } = fakeCtx({
        manager: manager(),
        qs: { code: 'good-code', state: 'good-state' },
        session: {
          get: () => ({ verifier: 'verifier', state: 'good-state' }),
          forget: () => undefined,
        },
      });
      await callback.handler(ctx);

      assert.lengthOf(redirects, 1);
      assert.strictEqual(redirects[0].url, '/');
      assert.strictEqual(redirects[0].forward, false, 'pós-login encaminhou a query do callback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
