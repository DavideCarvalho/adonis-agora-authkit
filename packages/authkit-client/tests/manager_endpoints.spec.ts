import { Container } from '@adonisjs/core/container';
import { test } from '@japa/runner';
import AuthkitClientProvider, {
  AuthkitClientManager,
} from '../providers/authkit_client_provider.js';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';
import { __clearDiscoveryCacheForTests, OidcDiscoveryError } from '../src/discovery.js';
import { signIdToken, testKeys } from './helpers/id_tokens.js';

const ISSUER = 'https://kc.test/realms/acme';
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
};

function config(over: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    issuer: ISSUER,
    clientId: 'app1',
    redirectUri: 'http://app/cb',
    resolverFactory: { resolver: async () => ({ resolve: async () => null }) },
    sessionKey: 'authkit',
    scopes: ['openid'],
    globalRolesClaim: 'roles',
    discovery: {},
    ...over,
  };
}

function docFetch(state: { up: boolean; calls: string[] }) {
  return (async (url: any) => {
    state.calls.push(String(url));
    if (!state.up) return { ok: false, status: 503, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => DOC } as Response;
  }) as typeof fetch;
}

function sessionCtx(initial: unknown) {
  const store = new Map<string, unknown>([['authkit', initial]]);
  return {
    ctx: {
      session: {
        get: (k: string) => store.get(k),
        put: (k: string, v: unknown) => store.set(k, v),
      },
    } as any,
    store,
  };
}

test.group('AuthkitClientManager | endpoints', (group) => {
  group.each.setup(() => __clearDiscoveryCacheForTests());

  test('discovers once and applies overrides', async ({ assert }) => {
    const state = { up: true, calls: [] as string[] };
    const m = new AuthkitClientManager(
      config({ endpoints: { tokenEndpoint: 'https://proxy/token' } }),
      { fetchImpl: docFetch(state) },
    );
    const a = await m.endpoints();
    await m.endpoints();
    assert.equal(a.authorizationEndpoint, DOC.authorization_endpoint);
    assert.equal(a.tokenEndpoint, 'https://proxy/token');
    assert.lengthOf(state.calls, 1);
  });

  test('discovery failure throws and is retried on the next call', async ({ assert }) => {
    const state = { up: false, calls: [] as string[] };
    const m = new AuthkitClientManager(config(), { fetchImpl: docFetch(state) });
    await assert.rejects(() => m.endpoints(), OidcDiscoveryError);
    state.up = true;
    assert.equal((await m.endpoints()).jwksUri, DOC.jwks_uri);
  });

  test('discovery: false uses the convention plus overrides, without network', async ({
    assert,
  }) => {
    const state = { up: true, calls: [] as string[] };
    const m = new AuthkitClientManager(
      config({ issuer: 'http://idp', discovery: false, endpoints: { jwksUri: 'http://keys' } }),
      { fetchImpl: docFetch(state) },
    );
    const endpoints = await m.endpoints();
    assert.equal(endpoints.tokenEndpoint, 'http://idp/token');
    assert.equal(endpoints.jwksUri, 'http://keys');
    assert.lengthOf(state.calls, 0);
  });
});

test.group('AuthkitClientManager | refresh against a third-party IdP', (group) => {
  group.each.setup(() => __clearDiscoveryCacheForTests());

  test('refresh posts to the discovered token endpoint', async ({ assert }) => {
    const posted: string[] = [];
    const docState = { up: true, calls: [] as string[] };
    const m = new AuthkitClientManager(config(), { fetchImpl: docFetch(docState), keys: testKeys });
    const { ctx, store } = sessionCtx({
      idToken: '',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
    });
    await m.maybeRefresh(ctx, {
      now: () => 1_000,
      fetchImpl: (async (url: any) => {
        posted.push(String(url));
        return { ok: true, json: async () => ({ access_token: 'a2', expires_in: 60 }) } as Response;
      }) as typeof fetch,
    });
    assert.deepEqual(posted, [DOC.token_endpoint]);
    assert.equal((store.get('authkit') as any).accessToken, 'a2');
  });

  test('a refreshed id_token about another user is discarded and logged', async ({ assert }) => {
    const warnings: string[] = [];
    const m = new AuthkitClientManager(config({ discovery: false, issuer: 'http://idp' }), {
      keys: testKeys,
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });
    const original = {
      idToken: await signIdToken({ sub: 'u1' }),
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
    };
    const { ctx, store } = sessionCtx(original);
    const other = await signIdToken({ sub: 'u2' });
    await m.maybeRefresh(ctx, {
      now: () => 1_000,
      fetchImpl: (async () =>
        ({
          ok: true,
          json: async () => ({ access_token: 'a2', id_token: other, refresh_token: 'r2' }),
        }) as Response) as typeof fetch,
    });
    assert.deepEqual(store.get('authkit'), original);
    assert.lengthOf(warnings, 1);
  });

  test('a failing refresh is logged instead of swallowed', async ({ assert }) => {
    const warnings: string[] = [];
    const m = new AuthkitClientManager(config({ discovery: false, issuer: 'http://idp' }), {
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });
    const { ctx } = sessionCtx({ idToken: '', accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    await m.maybeRefresh(ctx, {
      now: () => 1_000,
      fetchImpl: (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch,
    });
    assert.lengthOf(warnings, 1);
  });
});

test.group('AuthkitClientProvider | container', () => {
  test('binds the manager by class (for @inject) and keeps the string alias', async ({
    assert,
  }) => {
    const container = new Container<any>();
    container.bindValue('logger', { warn: () => {} });
    const app = {
      container,
      config: {
        get: () =>
          defineConfig({
            issuer: 'http://idp',
            clientId: 'app1',
            redirectUri: 'http://app/cb',
            resolver: resolvers.jwt(),
            discovery: false,
          }),
      },
    } as any;
    new AuthkitClientProvider(app).register();

    const byClass = await container.make(AuthkitClientManager);
    const byAlias = await container.make('authkit.client');
    assert.instanceOf(byClass, AuthkitClientManager);
    assert.strictEqual(byAlias, byClass);
  });
});

test.group('AuthkitClientManager | IdP down at boot', (group) => {
  group.each.setup(() => __clearDiscoveryCacheForTests());

  test('requests resolve to no identity while discovery fails, then recover', async ({
    assert,
  }) => {
    const state = { up: false, calls: [] as string[] };
    const m = new AuthkitClientManager(config({ resolverFactory: resolvers.jwt() }), {
      fetchImpl: docFetch(state),
    });
    const ctx = { session: { get: () => ({ idToken: 'x', accessToken: 'y' }) } } as any;

    const auth = await m.createAuthenticator(ctx);
    assert.isNull(await auth.getIdentity());

    state.up = true;
    await (await m.createAuthenticator(ctx)).getIdentity();
    // The resolver retried discovery on the next request instead of caching the failure.
    assert.isAbove(state.calls.length, 1);
  });
});
