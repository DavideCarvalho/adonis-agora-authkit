import { test } from '@japa/runner';
import { registerOidcClient } from '../src/register_oidc_client.js';

/**
 * Nenhum redirect do client deve encaminhar a query da request atual: os destinos
 * são URLs que a própria lib monta, e encaminhar arrasta o `code`/`state`/`iss` do
 * callback para o app (que termina em `/?code=…`).
 *
 * O opt-out tem que ser o builder `withQs(false)`. O segundo argumento posicional
 * de `redirect(path, forwardQueryString)` NÃO basta: quando o app liga
 * `redirect.forwardQueryString: true` no config/app.ts — o caso comum — o
 * positional é ignorado e o Redirect herda a config global. Por isso o `response`
 * falso aqui só considera o encaminhamento desligado se `withQs(false)` for
 * chamado; a forma posicional cai no default do config (encaminha) e o teste falha.
 */

type Redirect = { url: string; forward: boolean };

function fakeResponse(redirects: Redirect[]) {
  return {
    redirect(path?: string, _forward?: boolean) {
      // Forma posicional: em produção com `redirect.forwardQueryString: true`
      // (o caso comum, em config/app.ts) o argumento é IGNORADO e o Redirect
      // herda a config global — ou seja, encaminha. O fake modela isso de
      // propósito: só `withQs(false)` conta como opt-out.
      if (typeof path === 'string') {
        redirects.push({ url: path, forward: true });
        return undefined as any;
      }
      const builder = {
        _url: '',
        _forward: true,
        withQs(value: boolean) {
          builder._forward = value;
          return builder;
        },
        status() {
          return builder;
        },
        toPath(url: string) {
          redirects.push({ url, forward: builder._forward });
          return undefined as any;
        },
        back() {
          redirects.push({ url: 'back', forward: builder._forward });
          return undefined as any;
        },
      };
      return builder;
    },
  };
}

function fakeRouter() {
  const routes: { pattern: string; handler: (ctx: any) => Promise<unknown> }[] = [];
  const make = (pattern: string, handler: (ctx: any) => Promise<unknown>) => {
    const chain = { use: () => chain, as: () => chain };
    routes.push({ pattern, handler });
    return chain;
  };
  return { routes, get: make, post: make } as any;
}

function fakeCtx(overrides: { manager?: any; qs?: Record<string, string>; session?: any }) {
  const redirects: Redirect[] = [];
  const ctx = {
    containerResolver: { make: async () => overrides.manager },
    request: { qs: () => overrides.qs ?? {}, input: () => undefined },
    session: overrides.session,
    response: fakeResponse(redirects),
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
  test('login → authorize sem encaminhar a query', async ({ assert }) => {
    const router = fakeRouter();
    registerOidcClient(router);
    const login = router.routes.find((r: { pattern: string }) => r.pattern === '/auth/login')!;

    const { ctx, redirects } = fakeCtx({ manager: manager(), session: { put: () => undefined } });
    await login.handler(ctx);

    assert.lengthOf(redirects, 1);
    assert.isFalse(redirects[0].forward, 'login encaminhou a query da request');
    assert.include(redirects[0].url, '/oidc/auth?');
  });

  test('callback sem PKCE → /auth/login sem encaminhar (o code não vaza)', async ({ assert }) => {
    const router = fakeRouter();
    registerOidcClient(router);
    const callback = router.routes.find(
      (r: { pattern: string }) => r.pattern === '/auth/callback',
    )!;

    const { ctx, redirects } = fakeCtx({
      manager: manager(),
      qs: { code: 'stale-code', state: 'stale-state' },
      session: { get: () => undefined, forget: () => undefined },
    });
    await callback.handler(ctx);

    assert.lengthOf(redirects, 1);
    assert.strictEqual(redirects[0].url, '/auth/login');
    assert.isFalse(redirects[0].forward, 'callback falho encaminhou a query');
  });

  test('callback com sucesso → destino do app sem encaminhar', async ({ assert }) => {
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
      const callback = router.routes.find(
        (r: { pattern: string }) => r.pattern === '/auth/callback',
      )!;

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
      assert.isFalse(redirects[0].forward, 'pós-login encaminhou a query do callback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('logout → end-session sem encaminhar a query', async ({ assert }) => {
    const router = fakeRouter();
    registerOidcClient(router);
    const logout = router.routes.find((r: { pattern: string }) => r.pattern === '/auth/logout')!;

    const { ctx, redirects } = fakeCtx({
      manager: { ...manager(), getIdToken: () => 'id-token', endSession: () => undefined },
    });
    await logout.handler(ctx);

    assert.lengthOf(redirects, 1);
    assert.include(redirects[0].url, '/oidc/');
    assert.isFalse(redirects[0].forward, 'logout encaminhou a query');
  });
});
