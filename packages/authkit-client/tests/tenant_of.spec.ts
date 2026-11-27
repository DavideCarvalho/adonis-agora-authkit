import { Container } from '@adonisjs/core/container';
import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { AppCallsConfigError, resolveAppCalls } from '../src/app_calls/config.js';
import { __clearControlPlaneThrottleForTests } from '../src/control_planes.js';
import type { ResolvedClientConfig } from '../src/define_config.js';
import { __clearDiscoveryCacheForTests } from '../src/discovery.js';
import { TenantOfConfigError } from '../src/tenant_of.js';

const ISSUER = 'https://auth.example.com';
const TELESCOPE = 'urn:agora:telescope';
const DURABLE = 'urn:agora:durable';

const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  agora_control_planes: {
    [TELESCOPE]: 'https://telescope.example.com',
    [DURABLE]: 'https://durable.example.com',
  },
};

/** A fake issuer: discovery document + token endpoint (`tok-<n>`, expires in `expiresIn`). */
function fakeIssuer(opts: { expiresIn?: number; doc?: () => unknown } = {}) {
  const discovery: string[] = [];
  const tokens: Array<{ url: string; auth: string; body: URLSearchParams }> = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      discovery.push(url);
      return Response.json(opts.doc ? opts.doc() : DOC);
    }
    const headers = init.headers as Record<string, string>;
    tokens.push({
      url,
      auth: headers.authorization,
      body: new URLSearchParams(String(init.body)),
    });
    return Response.json({
      access_token: `tok-${tokens.length}`,
      token_type: 'Bearer',
      expires_in: opts.expiresIn ?? 600,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, discovery, tokens };
}

function config(
  service: Parameters<typeof resolveAppCalls>[0],
  over: Partial<ResolvedClientConfig> = {},
): ResolvedClientConfig {
  const appCalls = resolveAppCalls(service, undefined);
  return {
    issuer: ISSUER,
    clientId: 'login-client',
    redirectUri: 'http://app/cb',
    resolverFactory: { resolver: async () => ({ resolve: async () => null }) },
    sessionKey: 'authkit',
    scopes: ['openid'],
    globalRolesClaim: 'roles',
    discovery: {},
    ...(appCalls ? { appCalls } : {}),
    ...over,
  };
}

const SERVICE = { name: 'shop', clientId: 'shop-svc', clientSecret: 'shop-secret' };

test.group('tenantOf', (group) => {
  group.each.setup(() => {
    __clearDiscoveryCacheForTests();
    __clearControlPlaneThrottleForTests();
  });

  test('url is discovered from the issuer per resource, and refresh() refetches', async ({
    assert,
  }) => {
    let planes: Record<string, string> = { [TELESCOPE]: 'https://telescope.example.com' };
    const issuer = fakeIssuer({ doc: () => ({ ...DOC, agora_control_planes: planes }) });
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: issuer.fetch });

    const tenant = m.tenantOf(TELESCOPE);
    assert.lengthOf(issuer.discovery, 0, 'nothing is fetched until called');
    assert.equal(await tenant.url(), 'https://telescope.example.com');
    assert.equal(await tenant.url(), 'https://telescope.example.com');
    assert.deepEqual(issuer.discovery, [`${ISSUER}/.well-known/openid-configuration`]);

    planes = { [TELESCOPE]: 'https://telescope-2.example.com' };
    assert.equal(await tenant.url.refresh(), 'https://telescope-2.example.com');
    assert.equal(await tenant.url(), 'https://telescope-2.example.com');
  });

  test('token: client credentials of `service`, audience = the resource, cached', async ({
    assert,
  }) => {
    const issuer = fakeIssuer();
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: issuer.fetch });

    const telescope = m.tenantOf(TELESCOPE);
    assert.equal(await telescope.token(), 'tok-1');
    assert.equal(await telescope.token(), 'tok-1');
    assert.lengthOf(issuer.tokens, 1);

    const call = issuer.tokens[0];
    assert.equal(call.url, `${ISSUER}/token`);
    assert.equal(call.body.get('grant_type'), 'client_credentials');
    assert.equal(call.body.get('resource'), TELESCOPE);
    assert.equal(call.auth, `Basic ${Buffer.from('shop-svc:shop-secret').toString('base64')}`);

    // Another resource gets its own token (its own audience and cache).
    assert.equal(await m.tenantOf(DURABLE).token(), 'tok-2');
    assert.equal(issuer.tokens[1].body.get('resource'), DURABLE);
    assert.equal(await telescope.token(), 'tok-1');
  });

  test('token is refreshed near expiry', async ({ assert }) => {
    // expires_in 1 s: the refresh skew (min(60 s, half the lifetime)) makes every call refetch.
    const issuer = fakeIssuer({ expiresIn: 1 });
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: issuer.fetch });
    const tenant = m.tenantOf(TELESCOPE);
    assert.equal(await tenant.token(), 'tok-1');
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(await tenant.token(), 'tok-2');
  });

  test('token.reset() drops the cached token', async ({ assert }) => {
    const issuer = fakeIssuer();
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: issuer.fetch });
    const tenant = m.tenantOf(TELESCOPE);
    assert.equal(await tenant.token(), 'tok-1');
    assert.isFunction(tenant.token.reset);
    tenant.token.reset();
    assert.equal(await tenant.token(), 'tok-2');
  });

  test('the same resource gives the same tenant (one token cache)', async ({ assert }) => {
    const issuer = fakeIssuer();
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: issuer.fetch });
    assert.strictEqual(m.tenantOf(TELESCOPE), m.tenantOf(TELESCOPE));
    await m.tenantOf(TELESCOPE).token();
    await m.tenantOf(TELESCOPE).token();
    assert.lengthOf(issuer.tokens, 1);
  });

  test('uses the token endpoint override', async ({ assert }) => {
    const issuer = fakeIssuer();
    const m = new AuthkitClientManager(
      config(SERVICE, { endpoints: { tokenEndpoint: 'https://proxy.example.com/token' } }),
      { fetchImpl: issuer.fetch },
    );
    await m.tenantOf(TELESCOPE).token();
    assert.equal(issuer.tokens[0].url, 'https://proxy.example.com/token');
  });

  test('partition is service.partition, else service.name', ({ assert }) => {
    const byName = new AuthkitClientManager(config(SERVICE));
    assert.equal(byName.tenantOf(TELESCOPE).partition, 'shop');
    const explicit = new AuthkitClientManager(config({ ...SERVICE, partition: 'acme' }));
    assert.equal(explicit.tenantOf(TELESCOPE).partition, 'acme');
  });

  test('an empty service.partition fails the config', ({ assert }) => {
    assert.throws(
      () => resolveAppCalls({ ...SERVICE, partition: ' ' }, undefined),
      AppCallsConfigError as any,
    );
  });

  test('throws a clear error without `service`', ({ assert }) => {
    const m = new AuthkitClientManager(config(undefined));
    try {
      m.tenantOf(TELESCOPE);
      assert.fail('expected tenantOf to throw');
    } catch (error) {
      assert.instanceOf(error, TenantOfConfigError);
      assert.equal((error as TenantOfConfigError).code, 'E_AUTHKIT_SERVICE_NOT_CONFIGURED');
      const message = (error as Error).message;
      assert.include(message, 'urn:agora:telescope');
      assert.include(message, 'config/authkit_client.ts');
      assert.include(
        message,
        "service: { name: '<this app>', clientId: env.get('AUTHKIT_SERVICE_CLIENT_ID'), clientSecret: env.get('AUTHKIT_SERVICE_CLIENT_SECRET') }",
      );
    }
  });

  test('throws without the service credentials', ({ assert }) => {
    const m = new AuthkitClientManager(config({ name: 'shop' }));
    assert.throws(() => m.tenantOf(TELESCOPE), /service\.clientId and service\.clientSecret/);
  });

  test('the manager without `service` still works for login (tenantOf is lazy)', async ({
    assert,
  }) => {
    const m = new AuthkitClientManager(config(undefined));
    assert.isUndefined(m.appCallsConfig());
    assert.isFunction(m.tenantOf);
  });

  test('libs find it structurally on the authkit.client binding', async ({ assert }) => {
    const container = new Container<any>();
    const m = new AuthkitClientManager(config(SERVICE), { fetchImpl: fakeIssuer().fetch });
    container.singleton('authkit.client', () => m);
    assert.isTrue(container.hasBinding('authkit.client'));
    const client = (await container.make('authkit.client')) as { tenantOf?: unknown };
    assert.equal(typeof client.tenantOf, 'function');
    const tenant = (client as AuthkitClientManager).tenantOf(DURABLE);
    assert.equal(await tenant.url(), 'https://durable.example.com');
    assert.equal(tenant.partition, 'shop');
  });
});
