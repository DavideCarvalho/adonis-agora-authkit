import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import AuthorizationServerMetadataController from '../src/controllers/authorization_server_metadata_controller.js';
import ProtectedResourceMetadataController from '../src/controllers/protected_resource_metadata_controller.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { resetAuthHostConfig, setAuthHostConfig } from '../src/host/auth_host_config.js';
import { registerAuthHost } from '../src/host/register_auth_host.js';
import {
  findMcpResource,
  MCP_CLIENT_REDIRECTS,
  mcpClientRegistration,
  protectedResourceMetadataUrl,
  registerOAuthResource,
  resolveMcpOAuth,
  servedProtectedResources,
  withOfflineAccess,
} from '../src/mcp/mcp_oauth.js';
import { fakeAccountStore } from './bootstrap.js';

const ISSUER = 'https://app.example.com/oidc';

async function resolved(extra: Record<string, unknown>) {
  const fakeApp = { container: { make: async () => ({ connection: () => ({}) }) } } as any;
  return (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      ...extra,
    } as any),
  )) as any;
}

/** Router de mentira que só anota as rotas, como em tests/host/logout_asset.spec.ts. */
function recordingRouter() {
  const routes: Array<{ method: string; pattern: string; name?: string }> = [];
  const mk = (method: string) => (pattern: string) => {
    const route: { method: string; pattern: string; name?: string } = { method, pattern };
    routes.push(route);
    const chain: any = {
      as: (n: string) => {
        route.name = n;
        return chain;
      },
      middleware: () => chain,
      use: () => chain,
      where: () => chain,
    };
    return chain;
  };
  const groupChain: any = {
    as: () => groupChain,
    prefix: () => groupChain,
    middleware: () => groupChain,
    use: () => groupChain,
  };
  const router: any = {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    delete: mk('DELETE'),
    put: mk('PUT'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      cb();
      return groupChain;
    },
  };
  return { router, routes };
}

test.group('mcp: config', () => {
  test('off by default: no registration, no MCP resources', async ({ assert }) => {
    const cfg = await resolved({});
    assert.isFalse(cfg.mcp.enabled);
    assert.isFalse(cfg.dynamicRegistration.enabled);
  });

  test('mcp: true opens registration to the known MCP clients only', async ({ assert }) => {
    const cfg = await resolved({ mcp: true });
    assert.isTrue(cfg.dynamicRegistration.enabled);
    assert.isUndefined(cfg.dynamicRegistration.initialAccessToken);
    assert.deepEqual(cfg.dynamicRegistration.redirectUriPolicy.exact, MCP_CLIENT_REDIRECTS.exact);
    assert.isTrue(cfg.dynamicRegistration.redirectUriPolicy.loopback);
    assert.isFalse(cfg.dynamicRegistration.redirectUriPolicy.anyHttps);
  });

  test('a declared dynamicRegistration keeps the last word', async ({ assert }) => {
    const cfg = await resolved({
      mcp: true,
      dynamicRegistration: { enabled: true, initialAccessToken: 'iat' },
    });
    assert.equal(cfg.dynamicRegistration.initialAccessToken, 'iat');
    assert.isNull(cfg.dynamicRegistration.redirectUriPolicy);
  });

  test('extra redirects add to the known ones', ({ assert }) => {
    const mcp = resolveMcpOAuth({
      redirectUris: { exact: ['https://me.example/cb'], appSchemes: ['zed'] },
    });
    assert.includeMembers(mcp.redirectUriPolicy.exact, [
      ...MCP_CLIENT_REDIRECTS.exact,
      'https://me.example/cb',
    ]);
    assert.includeMembers(mcp.redirectUriPolicy.appSchemes, ['cursor', 'zed']);
  });
});

test.group('mcp: resources', () => {
  test('declared, registered by URL, or registered by path on the issuer origin', ({ assert }) => {
    registerOAuthResource({ url: 'https://other.example.com/tools/mcp' });
    registerOAuthResource({ path: 'api/mcp' });
    const mcp = resolveMcpOAuth({ resources: ['https://app.example.com/mcp'] });

    assert.equal(
      findMcpResource('https://app.example.com/mcp/', ISSUER, mcp)?.audience,
      'https://app.example.com/mcp',
    );
    assert.equal(
      findMcpResource('https://other.example.com/tools/mcp', ISSUER, mcp)?.audience,
      'https://other.example.com/tools/mcp',
    );
    assert.equal(
      findMcpResource('https://app.example.com/api/mcp', ISSUER, mcp)?.audience,
      'https://app.example.com/api/mcp',
    );
    assert.include(
      findMcpResource('https://app.example.com/api/mcp', ISSUER, mcp)!.scopes,
      'offline_access',
    );

    // a path only counts on the issuer's own origin, and never with a query
    assert.isNull(findMcpResource('https://evil.example.com/api/mcp', ISSUER, mcp));
    assert.isNull(findMcpResource('https://app.example.com/api/mcp?x=1', ISSUER, mcp));
    assert.isNull(findMcpResource('https://app.example.com/other', ISSUER, mcp));
    // off → nothing matches
    assert.isNull(
      findMcpResource('https://app.example.com/api/mcp', ISSUER, resolveMcpOAuth(false)),
    );
  });

  test('registerOAuthResource needs a url or a path', ({ assert }) => {
    assert.throws(() => registerOAuthResource({}), /url.*path/);
  });
});

test.group('mcp: refresh tokens for MCP clients', () => {
  test('registration asks for offline_access when the client wants refresh tokens', ({
    assert,
  }) => {
    assert.deepEqual(
      mcpClientRegistration({
        scope: 'profile',
        grant_types: ['authorization_code', 'refresh_token'],
      }).scope,
      'profile openid offline_access',
    );
    const noRefresh = { scope: 'profile', grant_types: ['authorization_code'] };
    assert.deepEqual(mcpClientRegistration(noRefresh), noRefresh);
  });

  test('authorize gets offline_access and prompt=consent, dropping prompt=none', ({ assert }) => {
    assert.deepEqual(withOfflineAccess({ scope: 'profile', prompt: 'none' }), {
      scope: 'openid profile offline_access',
      prompt: 'consent',
    });
    assert.isNull(withOfflineAccess({ scope: 'openid offline_access', prompt: 'consent' }));
  });
});

test.group('RFC 8414 metadata at the root', () => {
  test('registered before the provider wildcard, at the issuer path', ({ assert }) => {
    resetAuthHostConfig();
    const { router, routes } = recordingRouter();
    registerAuthHost(router, { mountPath: '/oidc' } as any);
    const metadata = routes.findIndex(
      (r) => r.pattern === '/.well-known/oauth-authorization-server/oidc',
    );
    const wildcard = routes.findIndex((r) => r.name === 'authkit.oidc.wildcard');
    assert.isAbove(metadata, -1);
    assert.isBelow(metadata, wildcard);
  });

  test('the controller hands the request to the provider under its own mount', async ({
    assert,
  }) => {
    const seen: string[] = [];
    const listeners: Record<string, () => void> = {};
    const res: any = { on: (event: string, cb: () => void) => (listeners[event] = cb) };
    const req: any = { url: '/.well-known/oauth-authorization-server/oidc' };
    const service = {
      config: { issuer: ISSUER },
      callback: (r: any) => {
        seen.push(r.url);
        listeners.finish?.();
      },
    };
    await new AuthorizationServerMetadataController().handle({
      containerResolver: { make: async () => service },
      request: { request: req },
      response: { response: res },
    } as any);
    assert.deepEqual(seen, ['/oidc/.well-known/oauth-authorization-server']);
  });
});

const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

/** Roda o grupo com o registro global vazio e o restaura no fim. */
function isolatedRegistry(group: { setup: (fn: () => () => void) => void; each: any }) {
  group.setup(() => {
    const saved = (globalThis as Record<symbol, unknown>)[REGISTRY];
    return () => {
      (globalThis as Record<symbol, unknown>)[REGISTRY] = saved;
    };
  });
  group.each.setup(() => {
    (globalThis as Record<symbol, unknown>)[REGISTRY] = [];
  });
}

test.group('RFC 9728 protected resource metadata', (group) => {
  isolatedRegistry(group);

  async function get(path: string, mcp = resolveMcpOAuth({ resources: [`${ORIGIN}/tools`] })) {
    const headers: Record<string, string> = {};
    let status = 200;
    let body: unknown;
    const response: any = {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
      json: (b: unknown) => {
        body = b;
      },
      notFound: (b: unknown) => {
        status = 404;
        body = b;
      },
    };
    await new ProtectedResourceMetadataController().handle({
      containerResolver: { make: async () => ({ config: { issuer: ISSUER, mcp } }) },
      request: { url: () => path },
      response,
    } as any);
    return { status, body, headers };
  }

  const ORIGIN = 'https://app.example.com';

  test('metadata URL puts the well-known segment between origin and path', ({ assert }) => {
    assert.equal(
      protectedResourceMetadataUrl('https://app.example.com/api/v1/'),
      'https://app.example.com/.well-known/oauth-protected-resource/api/v1',
    );
    assert.equal(
      protectedResourceMetadataUrl('https://api.example.com'),
      'https://api.example.com/.well-known/oauth-protected-resource',
    );
  });

  test('guard resources and same-origin mcp.resources are served; self-serving ones are not', ({
    assert,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' }); // the agent: serves its own document
    registerOAuthResource({
      path: '/api',
      scopes: ['openid', 'read'],
      name: 'API',
      metadata: true,
    });
    registerOAuthResource({ path: '/mcp/agora', metadata: true }); // would collide: dropped
    const served = servedProtectedResources({
      issuer: ISSUER,
      mcpResources: [`${ORIGIN}/tools`, 'https://elsewhere.example.com/mcp', `${ORIGIN}/api`],
    });
    assert.deepEqual(served, [
      { path: '/api', scopes: ['openid', 'read'], name: 'API' },
      {
        path: '/tools',
        url: `${ORIGIN}/tools`,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      },
    ]);
  });

  test('document: resource, issuer, scopes, header bearer, name, CORS', async ({ assert }) => {
    registerOAuthResource({
      path: '/api',
      scopes: ['openid', 'read'],
      name: 'API',
      metadata: true,
    });
    const { status, body, headers } = await get('/.well-known/oauth-protected-resource/api');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      resource: `${ORIGIN}/api`,
      authorization_servers: [ISSUER],
      scopes_supported: ['openid', 'read'],
      bearer_methods_supported: ['header'],
      resource_name: 'API',
    });
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
  });

  test('a guard resource declared by URL keeps that URL as `resource`', async ({ assert }) => {
    registerOAuthResource({ url: 'https://api.example.com', metadata: true });
    const { body } = await get('/.well-known/oauth-protected-resource');
    assert.equal((body as any).resource, 'https://api.example.com');
    assert.notProperty(body as object, 'resource_name');
  });

  test('mcp.resources on the issuer origin are served', async ({ assert }) => {
    const { status, body } = await get('/.well-known/oauth-protected-resource/tools');
    assert.equal(status, 200);
    assert.equal((body as any).resource, `${ORIGIN}/tools`);
  });

  test('unknown or self-served paths → 404 (with CORS)', async ({ assert }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    for (const path of ['/nope', '/mcp/agora']) {
      const { status, headers } = await get(`/.well-known/oauth-protected-resource${path}`);
      assert.equal(status, 404, path);
      assert.equal(headers['Access-Control-Allow-Origin'], '*');
    }
    const off = await get('/.well-known/oauth-protected-resource/tools', resolveMcpOAuth(false));
    assert.equal(off.status, 404);
  });

  test('registerAuthHost mounts one route per served resource, before the provider wildcard', ({
    assert,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    registerOAuthResource({ path: '/api', metadata: true });
    resetAuthHostConfig();
    setAuthHostConfig({
      mountPath: '/oidc',
      issuer: ISSUER,
      mcpResources: [`${ORIGIN}/tools`],
    } as any);
    try {
      const { router, routes } = recordingRouter();
      registerAuthHost(router, { mountPath: '/oidc' } as any);
      const patterns = routes
        .filter((r) => r.pattern.startsWith('/.well-known/oauth-protected-resource'))
        .map((r) => r.pattern);
      assert.deepEqual(patterns, [
        '/.well-known/oauth-protected-resource/api',
        '/.well-known/oauth-protected-resource/tools',
      ]);
      const names = routes
        .map((r) => r.name)
        .filter((n) => n?.startsWith('authkit.oauth_protected'));
      assert.lengthOf(new Set(names), 2);
      const wildcard = routes.findIndex((r) => r.name === 'authkit.oidc.wildcard');
      const last = routes.findIndex(
        (r) => r.pattern === '/.well-known/oauth-protected-resource/tools',
      );
      assert.isBelow(last, wildcard);
    } finally {
      resetAuthHostConfig();
    }
  });

  test('no guard resource and no mcp resources → no route', ({ assert }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    resetAuthHostConfig();
    const { router, routes } = recordingRouter();
    registerAuthHost(router, { mountPath: '/oidc' } as any);
    assert.isFalse(routes.some((r) => r.pattern.includes('oauth-protected-resource')));
  });

  test('issuer accepts a guard resource as RFC 8707 target even with mcp off', ({ assert }) => {
    registerOAuthResource({ path: '/api', scopes: ['openid', 'read'], metadata: true });
    registerOAuthResource({ path: '/mcp/agora' });
    const off = resolveMcpOAuth(false);
    assert.deepEqual(findMcpResource(`${ORIGIN}/api`, ISSUER, off), {
      audience: `${ORIGIN}/api`,
      scopes: ['openid', 'read'],
    });
    assert.isNull(findMcpResource(`${ORIGIN}/mcp/agora`, ISSUER, off));
  });
});
