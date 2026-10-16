import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { OidcCallbackError } from '../src/authorization.js';
import type { ResolvedClientConfig } from '../src/define_config.js';
import { fakeHttpCtx, fakeSession, oidcRoutes } from './helpers/http.js';
import { signIdToken, testKeys } from './helpers/id_tokens.js';

/**
 * Nenhum redirect do client deve encaminhar a query da request atual: os destinos
 * são URLs que a própria lib monta, e encaminhar arrasta o `code`/`state`/`iss` do
 * callback para o app (que termina em `/?code=…`).
 *
 * O opt-out tem que ser o builder `withQs(false)`. O segundo argumento posicional
 * de `redirect(path, forwardQueryString)` NÃO basta: quando o app liga
 * `redirect.forwardQueryString: true` no config/app.ts — o caso comum — o
 * positional é ignorado e o Redirect herda a config global. Por isso o `response`
 * falso (helpers/http.ts) só considera o encaminhamento desligado se `withQs(false)` for
 * chamado; a forma posicional cai no default do config (encaminha) e o teste falha.
 */

const ISSUER = 'https://idp.test/oidc';

/** A real manager (discovery off, local keys) with the session/identity side stubbed. */
function manager(over: Partial<ResolvedClientConfig> = {}) {
  const m = new AuthkitClientManager(
    {
      issuer: ISSUER,
      clientId: 'app',
      redirectUri: 'https://app.test/auth/callback',
      scopes: ['openid'],
      resolverFactory: { resolver: async () => ({ resolve: async () => null }) },
      sessionKey: 'authkit',
      globalRolesClaim: 'roles',
      discovery: false,
      ...over,
    },
    { keys: testKeys },
  );
  m.startSession = () => undefined;
  m.createAuthenticator = async () => ({ getIdentity: async () => ({ globalRoles: [] }) }) as any;
  return m;
}

const PENDING = { state: 'good-state', nonce: 'good-nonce', codeVerifier: 'verifier' };

function stubTokenEndpoint(idToken: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test.group('registerOidcClient: redirect não encaminha a query da request', () => {
  test('login → authorize sem encaminhar a query', async ({ assert }) => {
    const login = oidcRoutes()('/auth/login');

    const { ctx, redirects } = fakeHttpCtx({ manager: manager(), session: fakeSession() });
    await login(ctx);

    assert.lengthOf(redirects, 1);
    assert.isFalse(redirects[0].forward, 'login encaminhou a query da request');
    assert.include(redirects[0].url, '/oidc/auth?');
  });

  test('callback sem PKCE → /auth/login sem encaminhar (o code não vaza)', async ({ assert }) => {
    const callback = oidcRoutes()('/auth/callback');

    const { ctx, redirects } = fakeHttpCtx({
      manager: manager(),
      qs: { code: 'stale-code', state: 'stale-state' },
      session: fakeSession(),
    });
    await callback(ctx);

    assert.lengthOf(redirects, 1);
    assert.strictEqual(redirects[0].url, '/auth/login');
    assert.isFalse(redirects[0].forward, 'callback falho encaminhou a query');
  });

  test('callback com sucesso → destino do app sem encaminhar', async ({ assert }) => {
    const restore = stubTokenEndpoint(
      await signIdToken({ iss: ISSUER, aud: 'app', nonce: PENDING.nonce }),
    );

    try {
      const callback = oidcRoutes()('/auth/callback');

      const { ctx, redirects } = fakeHttpCtx({
        manager: manager(),
        qs: { code: 'good-code', state: 'good-state' },
        session: fakeSession({ initial: { authkit_pkce: PENDING } }),
      });
      await callback(ctx);

      assert.lengthOf(redirects, 1);
      assert.strictEqual(redirects[0].url, '/');
      assert.isFalse(redirects[0].forward, 'pós-login encaminhou a query do callback');
    } finally {
      restore();
    }
  });

  test('logout → end-session sem encaminhar a query', async ({ assert }) => {
    const logout = oidcRoutes()('/auth/logout');

    const { ctx, redirects } = fakeHttpCtx({
      manager: Object.assign(manager(), { getIdToken: () => 'id-token' }),
    });
    await logout(ctx);

    assert.lengthOf(redirects, 1);
    assert.include(redirects[0].url, '/oidc/');
    assert.isFalse(redirects[0].forward, 'logout encaminhou a query');
  });
});

test.group('registerOidcClient: id_token and IdP endpoints', () => {
  const route = oidcRoutes();

  test('login sends nonce and stores it with state and the PKCE verifier', async ({ assert }) => {
    const session = fakeSession();
    const { ctx, redirects } = fakeHttpCtx({ manager: manager(), session });
    await route('/auth/login')(ctx);

    const url = new URL(redirects[0].url);
    const pending = session.store.get('authkit_pkce') as typeof PENDING;
    assert.equal(url.searchParams.get('nonce'), pending.nonce);
    assert.equal(url.searchParams.get('state'), pending.state);
    assert.isString(pending.codeVerifier);
  });

  test('callback rejects an id_token whose nonce is not the pending one', async ({ assert }) => {
    const restore = stubTokenEndpoint(
      await signIdToken({ iss: ISSUER, aud: 'app', nonce: 'other' }),
    );
    try {
      const { ctx } = fakeHttpCtx({
        manager: manager(),
        qs: { code: 'good-code', state: PENDING.state },
        session: fakeSession({ initial: { authkit_pkce: PENDING } }),
      });
      const error = await route('/auth/callback')(ctx).catch((e: unknown) => e);
      assert.instanceOf(error, OidcCallbackError);
      assert.equal((error as OidcCallbackError).code, 'invalid_id_token');
    } finally {
      restore();
    }
  });

  test('extraParams cannot override state, nonce or PKCE', async ({ assert }) => {
    const m = manager();
    const { url, pending } = await m.createAuthorizationRequest({
      extraParams: { state: 'x', nonce: 'x', code_challenge: 'x', prompt: 'login' },
    });
    const params = new URL(url).searchParams;
    assert.equal(params.get('state'), pending.state);
    assert.equal(params.get('nonce'), pending.nonce);
    assert.notEqual(params.get('code_challenge'), 'x');
    assert.equal(params.get('prompt'), 'login');
  });

  test('callback with an IdP error restarts the login', async ({ assert }) => {
    const { ctx, redirects } = fakeHttpCtx({
      manager: manager(),
      qs: { error: 'access_denied', state: PENDING.state },
      session: fakeSession({ initial: { authkit_pkce: PENDING } }),
    });
    await route('/auth/callback')(ctx);
    assert.strictEqual(redirects[0].url, '/auth/login');
  });

  test('login and logout use the configured endpoints', async ({ assert }) => {
    const m = manager({
      endpoints: {
        authorizationEndpoint: 'https://kc.test/realms/acme/protocol/openid-connect/auth',
        endSessionEndpoint: 'https://kc.test/realms/acme/protocol/openid-connect/logout',
      },
    });
    const login = fakeHttpCtx({ manager: m, session: fakeSession() });
    await route('/auth/login')(login.ctx);
    assert.isTrue(
      login.redirects[0].url.startsWith(
        'https://kc.test/realms/acme/protocol/openid-connect/auth?',
      ),
    );

    const logout = fakeHttpCtx({ manager: Object.assign(m, { getIdToken: () => 'id-token' }) });
    await route('/auth/logout')(logout.ctx);
    assert.isTrue(
      logout.redirects[0].url.startsWith(
        'https://kc.test/realms/acme/protocol/openid-connect/logout?',
      ),
    );
  });

  test('logout without an end_session_endpoint goes straight to the destination', async ({
    assert,
  }) => {
    const m = manager({ discovery: {} });
    // Discovered document without end_session_endpoint (Auth0-style tenant).
    (m as any).endpoints = async () => ({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      jwksUri: `${ISSUER}/.well-known/jwks.json`,
    });
    const { ctx, redirects } = fakeHttpCtx({
      manager: Object.assign(m, { getIdToken: () => 'x' }),
    });
    await route('/auth/logout')(ctx);
    assert.strictEqual(redirects[0].url, 'https://app.test/');
  });
});
