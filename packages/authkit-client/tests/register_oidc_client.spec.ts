import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { OidcCallbackError } from '../src/authorization.js';
import type { ResolvedClientConfig } from '../src/define_config.js';
import { oidcClientRoutes } from '../src/register_oidc_client.js';
import { fakeHttpCtx, fakeSession, oidcRoutes, registeredOidcRoutes } from './helpers/http.js';
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

test.group('registerOidcClient: mounted routes', () => {
  test('mounts the flow, the signup and the issuer redirects', ({ assert }) => {
    const routes = registeredOidcRoutes().map((r) => `${r.method} ${r.pattern}`);
    assert.sameMembers(routes, [
      'GET /auth/login',
      'GET /auth/signup',
      'GET /auth/callback',
      'POST /auth/logout',
      'POST /auth/backchannel-logout',
      'GET /account',
      'GET /account/*',
      'GET /auth/forgot-password',
      'GET /auth/reset-password',
      'GET /auth/reset-password/*',
      'GET /auth/admin',
      'GET /auth/admin/*',
      'GET /.well-known/agora-account-extensions',
      'POST /.well-known/agora-account-extensions',
    ]);
  });

  test('follows the prefix and gives every route a distinct name', ({ assert }) => {
    const routes = registeredOidcRoutes({ prefix: '/sso' });
    assert.includeMembers(
      routes.map((r) => r.pattern),
      ['/sso/signup', '/sso/forgot-password', '/sso/reset-password/*', '/sso/admin/*', '/account'],
    );
    const names = routes.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
    assert.include(names, 'auth.signup');
  });

  test('embedded topology: no issuer redirects when authkit-server runs in this app', ({
    assert,
  }) => {
    const app = {
      container: {
        hasBinding: (binding: string) => binding === 'authkit.server',
        bindValue: () => {},
        make: async () => undefined,
      },
    };
    const patterns = registeredOidcRoutes({ app }).map((r) => r.pattern);
    assert.includeMembers(patterns, ['/auth/login', '/auth/signup', '/auth/callback']);
    for (const page of ['/account', '/account/*', '/auth/forgot-password', '/auth/admin/*']) {
      assert.notInclude(patterns, page);
    }
  });

  test('loginMiddleware goes on login and signup only', ({ assert }) => {
    const guest = ['guest'];
    const routes = registeredOidcRoutes({ loginMiddleware: guest });
    const withGuest = routes.filter((r) => r.middleware.includes(guest)).map((r) => r.pattern);
    assert.sameMembers(withGuest, ['/auth/login', '/auth/signup']);
  });

  test('registerOidcClient mounts the oidcClientRoutes handlers (same behaviour)', async ({
    assert,
  }) => {
    const mounted = fakeHttpCtx({ manager: manager(), session: fakeSession() });
    await oidcRoutes()('/auth/signup')(mounted.ctx);
    const standalone = fakeHttpCtx({ manager: manager(), session: fakeSession() });
    await oidcClientRoutes().signup(standalone.ctx);
    const a = new URL(mounted.redirects[0].url);
    const b = new URL(standalone.redirects[0].url);
    assert.equal(a.origin + a.pathname, b.origin + b.pathname);
    assert.equal(a.searchParams.get('prompt'), b.searchParams.get('prompt'));
  });
});

test.group('registerOidcClient: signup', () => {
  test('starts the authorize flow with prompt=create and the passthrough params', async ({
    assert,
  }) => {
    const session = fakeSession();
    const { ctx, redirects } = fakeHttpCtx({
      manager: manager(),
      session,
      qs: { audience: 'signup', utm_source: 'ads' },
    });
    await oidcRoutes()('/auth/signup')(ctx);

    assert.lengthOf(redirects, 1);
    assert.isFalse(redirects[0].forward);
    const url = new URL(redirects[0].url);
    assert.equal(url.pathname, '/oidc/auth');
    assert.equal(url.searchParams.get('prompt'), 'create');
    assert.equal(url.searchParams.get('audience'), 'signup');
    assert.isNull(url.searchParams.get('utm_source'), 'only the passthrough params go along');
    const pending = session.store.get('authkit_pkce') as typeof PENDING;
    assert.equal(url.searchParams.get('state'), pending.state);
    assert.equal(url.searchParams.get('nonce'), pending.nonce);
    assert.isString(url.searchParams.get('code_challenge'));
  });

  test('keeps custom passthrough params (gclid, utm_*)', async ({ assert }) => {
    const { ctx, redirects } = fakeHttpCtx({
      manager: manager(),
      session: fakeSession(),
      qs: { gclid: 'g1', utm_campaign: 'c', prompt: 'login' },
    });
    await oidcRoutes({ passthroughParams: ['gclid', 'utm_campaign', 'prompt'] })('/auth/signup')(
      ctx,
    );
    const url = new URL(redirects[0].url);
    assert.equal(url.searchParams.get('gclid'), 'g1');
    assert.equal(url.searchParams.get('utm_campaign'), 'c');
    assert.equal(url.searchParams.get('prompt'), 'create', 'signup always asks for create');
  });

  test('login with ?audience=signup still passes audience through, without prompt', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeHttpCtx({
      manager: manager(),
      session: fakeSession(),
      qs: { audience: 'signup' },
    });
    await oidcRoutes()('/auth/login')(ctx);
    const url = new URL(redirects[0].url);
    assert.equal(url.searchParams.get('audience'), 'signup');
    assert.isNull(url.searchParams.get('prompt'));
  });
});

test.group('registerOidcClient: redirects to the issuer pages', () => {
  /** Manager whose discovery publishes `pages` (or fails, with `null`). */
  function pagesManager(pages: Record<string, string> | null) {
    const m = manager({ discovery: {} });
    (m as any).endpoints = async () => {
      if (pages === null) throw new Error('discovery down');
      return {
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/auth`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksUri: `${ISSUER}/jwks`,
        ...pages,
      };
    };
    return m;
  }

  const HUB = {
    accountUri: 'https://idp.test/conta',
    accountHomeUri: 'https://idp.test/conta/seguranca',
    adminUri: 'https://idp.test/admin',
    forgotPasswordUri: 'https://idp.test/auth/forgot-password',
    resetPasswordUri: 'https://idp.test/auth/reset-password',
  };

  async function follow(
    pattern: string,
    request: { url: string; wildcard?: string[] },
    pages: Record<string, string> | null = HUB,
  ) {
    const { ctx, redirects } = fakeHttpCtx({ manager: pagesManager(pages), ...request });
    await oidcRoutes()(pattern)(ctx);
    return redirects[0];
  }

  test('/account goes to the account home', async ({ assert }) => {
    const r = await follow('/account', { url: '/account' });
    assert.equal(r.url, 'https://idp.test/conta/seguranca');
    assert.isFalse(r.forward);
  });

  test('/account/* keeps the rest of the path and the query', async ({ assert }) => {
    const r = await follow('/account/*', {
      url: '/account/orgs/invitations/abc/accept?x=1&y=a%20b',
      wildcard: ['orgs', 'invitations', 'abc', 'accept'],
    });
    assert.equal(r.url, 'https://idp.test/conta/orgs/invitations/abc/accept?x=1&y=a%20b');
  });

  test('forgot-password keeps the query', async ({ assert }) => {
    const r = await follow('/auth/forgot-password', { url: '/auth/forgot-password?email=a%40b' });
    assert.equal(r.url, 'https://idp.test/auth/forgot-password?email=a%40b');
  });

  test('reset-password keeps the token, in the query or as a path segment', async ({ assert }) => {
    const q = await follow('/auth/reset-password', { url: '/auth/reset-password?token=t0k' });
    assert.equal(q.url, 'https://idp.test/auth/reset-password?token=t0k');
    const p = await follow('/auth/reset-password/*', {
      url: '/auth/reset-password/t0k',
      wildcard: ['t0k'],
    });
    assert.equal(p.url, 'https://idp.test/auth/reset-password/t0k');
  });

  test('admin and admin/* go to the published admin console', async ({ assert }) => {
    const root = await follow('/auth/admin', { url: '/auth/admin' });
    assert.equal(root.url, 'https://idp.test/admin');
    const page = await follow('/auth/admin/*', {
      url: '/auth/admin/users/42?tab=roles',
      wildcard: ['users', '42'],
    });
    assert.equal(page.url, 'https://idp.test/admin/users/42?tab=roles');
  });

  test('falls back to the authkit-server defaults when nothing is published', async ({
    assert,
  }) => {
    const cases: Array<[string, { url: string; wildcard?: string[] }, string]> = [
      ['/account', { url: '/account' }, 'https://idp.test/account/security'],
      [
        '/account/*',
        { url: '/account/tokens', wildcard: ['tokens'] },
        'https://idp.test/account/tokens',
      ],
      [
        '/auth/forgot-password',
        { url: '/auth/forgot-password' },
        'https://idp.test/auth/forgot-password',
      ],
      [
        '/auth/reset-password',
        { url: '/auth/reset-password?token=t' },
        'https://idp.test/auth/reset-password?token=t',
      ],
      [
        '/auth/admin/*',
        { url: '/auth/admin/users', wildcard: ['users'] },
        'https://idp.test/admin/users',
      ],
    ];
    for (const [pattern, request, expected] of cases) {
      assert.equal((await follow(pattern, request, {})).url, expected, pattern);
      assert.equal(
        (await follow(pattern, request, null)).url,
        expected,
        `${pattern} (discovery down)`,
      );
    }
  });

  test('a published page on another origin is ignored', async ({ assert }) => {
    const r = await follow(
      '/auth/admin',
      { url: '/auth/admin' },
      { adminUri: 'https://evil.test/admin' },
    );
    assert.equal(r.url, 'https://idp.test/admin');
  });

  test('the path rest cannot leave the issuer page nor the issuer origin', async ({ assert }) => {
    const dots = await follow('/account/*', {
      url: '/account/../admin',
      wildcard: ['..', 'admin'],
    });
    assert.equal(dots.url, 'https://idp.test/conta/seguranca');

    const hostish = await follow('/account/*', {
      url: '/account//evil.test/x',
      wildcard: ['', 'evil.test', 'x'],
    });
    assert.equal(new URL(hostish.url).origin, 'https://idp.test');
    assert.equal(hostish.url, 'https://idp.test/conta/evil.test/x');

    const encoded = await follow('/account/*', {
      url: '/account/a%2F..%2F..%2Fadmin',
      wildcard: ['a/../../admin'],
    });
    assert.equal(encoded.url, 'https://idp.test/conta/a%2F..%2F..%2Fadmin');

    const backslash = await follow('/account/*', {
      url: '/account/%5C%5Cevil.test',
      wildcard: ['\\\\evil.test'],
    });
    assert.equal(new URL(backslash.url).origin, 'https://idp.test');
  });
});
