import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import AuthorizationServerMetadataController from '../src/controllers/authorization_server_metadata_controller.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { resetAuthHostConfig } from '../src/host/auth_host_config.js';
import { registerAuthHost } from '../src/host/register_auth_host.js';
import {
  findMcpResource,
  MCP_CLIENT_REDIRECTS,
  mcpClientRegistration,
  registerOAuthResource,
  resolveMcpOAuth,
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
      clients: [],
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
