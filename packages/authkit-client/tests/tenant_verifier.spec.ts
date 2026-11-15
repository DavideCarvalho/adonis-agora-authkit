import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  adapters,
  defineConfig as defineServer,
  OidcService,
  type ResolvedServerConfig,
} from '@adonis-agora/authkit-server';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { decodeJwt } from 'jose';
import { __clearDiscoveryCacheForTests } from '../src/discovery.js';
import { authkitTenantToken, TenantTokenError } from '../src/tenant_token.js';
import { AuthkitTenantVerifier, authkitTenantVerifier } from '../src/tenant_verifier.js';
import { type MemoryIssuer, startMemoryIssuer } from './helpers/memory_issuer.js';

const RESOURCE = 'urn:agora:flags';

const tenantClaims = (overrides: Record<string, unknown> = {}) => ({
  aud: RESOURCE,
  sub: 'app-acme',
  client_id: 'app-acme',
  partition: 'acme',
  capabilities: ['flags:ruleset:read'],
  ...overrides,
});

test.group('authkitTenantVerifier (in-memory issuer)', (group) => {
  let idp: MemoryIssuer;
  group.setup(async () => {
    idp = await startMemoryIssuer();
    return () => idp.close();
  });

  test('verifies against the discovered JWKS and reads the claims', async ({ assert }) => {
    const verify = authkitTenantVerifier({ issuer: idp.issuer, resource: RESOURCE });
    const token = await idp.sign(tenantClaims({ environment: 'production' }));
    const result = await verify({ token, partition: 'someone-else' });
    assert.deepInclude(result!, {
      partition: 'acme',
      environment: 'production',
      capabilities: ['flags:ruleset:read'],
      clientId: 'app-acme',
    });
    assert.isAbove(result!.expiresAt, Date.now());
    // The class form answers the same.
    assert.deepEqual(await verify.verify({ token }), result);
  });

  test('capabilities default to [] and the environment option fills a missing claim', async ({
    assert,
  }) => {
    const verify = authkitTenantVerifier({
      issuer: idp.issuer,
      resource: RESOURCE,
      environment: 'staging',
    });
    const token = await idp.sign(tenantClaims({ capabilities: undefined }));
    assert.deepInclude((await verify({ token }))!, {
      partition: 'acme',
      environment: 'staging',
      capabilities: [],
    });
  });

  test('rejects a token for another environment', async ({ assert }) => {
    const verify = authkitTenantVerifier({
      issuer: idp.issuer,
      resource: RESOURCE,
      environment: 'production',
    });
    assert.isNull(await verify({ token: await idp.sign(tenantClaims({ environment: 'dev' })) }));
  });

  test('rejects what does not verify', async ({ assert }) => {
    const verify = authkitTenantVerifier({ issuer: idp.issuer, resource: RESOURCE });
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, Promise<string>> = {
      'other resource': idp.sign(tenantClaims({ aud: 'urn:agora:durable' })),
      'not at+jwt': idp.sign(tenantClaims(), { typ: 'JWT' }),
      'foreign key': idp.sign(tenantClaims(), { key: 'foreign' }),
      'other issuer': idp.sign(tenantClaims({ iss: 'https://evil.example' })),
      expired: idp.sign(tenantClaims({ iat: now - 7200, exp: now - 3600 })),
      'a user token (sub is not the client)': idp.sign(tenantClaims({ sub: 'user-1' })),
      'no partition': idp.sign(tenantClaims({ partition: undefined })),
      'capabilities not a string[]': idp.sign(tenantClaims({ capabilities: 'all' })),
    };
    for (const [name, token] of Object.entries(cases)) {
      assert.isNull(await verify({ token: await token }), name);
    }
    assert.isNull(await verify({}));
    assert.isNull(await verify({ token: 'not-a-jwt' }));
  });

  test('requires issuer and resource', ({ assert }) => {
    assert.throws(() => new AuthkitTenantVerifier({ issuer: '', resource: RESOURCE }));
    assert.throws(() => authkitTenantVerifier({ issuer: idp.issuer, resource: '' }));
  });
});

test.group('authkitTenantVerifier / authkitTenantToken: discovery only', (group) => {
  group.each.setup(() => __clearDiscoveryCacheForTests());

  test('the tenant token goes to the discovered token endpoint, not a guessed path', async ({
    assert,
    cleanup,
  }) => {
    const idp = await startMemoryIssuer();
    cleanup(() => idp.close());
    idp.tokenResponse = () => ({
      status: 200,
      body: { access_token: 'tok', token_type: 'Bearer', expires_in: 300 },
    });
    const token = authkitTenantToken({
      issuer: idp.issuer,
      clientId: 'app-acme',
      clientSecret: 's3cret',
      resource: RESOURCE,
    });
    assert.equal(await token(), 'tok');
    assert.lengthOf(idp.tokenRequests, 1);
    assert.equal(idp.tokenRequests[0].body.get('resource'), RESOURCE);
  });

  test('without a discovery document there is no token and no verification', async ({
    assert,
    cleanup,
  }) => {
    const idp = await startMemoryIssuer();
    cleanup(() => idp.close());
    idp.discoveryStatus = 503;
    const token = authkitTenantToken({
      issuer: idp.issuer,
      clientId: 'app-acme',
      clientSecret: 's3cret',
    });
    const error = await token().catch((e) => e);
    assert.instanceOf(error, TenantTokenError);
    assert.lengthOf(idp.tokenRequests, 0);

    const verify = authkitTenantVerifier({ issuer: idp.issuer, resource: RESOURCE });
    await assert.rejects(async () => verify({ token: await idp.sign(tenantClaims()) }));
  });
});

test.group(
  'service tenant with several urn:agora resources (authkit-server in-process)',
  (group) => {
    let server: Server;
    let issuer: string;

    group.setup(async () => {
      let handler: (req: any, res: any) => void = (_req, res) => res.end();
      server = createServer((req, res) => handler(req, res));
      await new Promise<void>((r) => server.listen(0, r));
      issuer = `http://localhost:${(server.address() as AddressInfo).port}`;
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
      } as any;
      const cfg = (await configProvider.resolve<ResolvedServerConfig>(
        fakeApp,
        defineServer({
          issuer,
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed' },
          serviceTenants: {
            resources: {
              'urn:agora:durable': {},
              'urn:agora:flags': { expiresIn: 120 },
              'urn:agora:config': {},
            },
          },
          accountStore: {
            findById: async () => null,
            verifyCredentials: async () => null,
            findByEmail: async () => null,
            create: async () => {
              throw new Error('not used');
            },
            listAccounts: async () => {
              throw new Error('not used');
            },
            setGlobalRoles: async () => {
              throw new Error('not used');
            },
            issuePasswordResetToken: async () => null,
            consumePasswordResetToken: async () => false,
            issueEmailVerificationToken: async () => null,
            consumeEmailVerificationToken: async () => false,
          },
        }),
      )) as ResolvedServerConfig;
      await new cfg.AdapterClass('Client').upsert(
        'app-acme',
        {
          client_id: 'app-acme',
          client_secret: 'acme-secret',
          redirect_uris: [],
          post_logout_redirect_uris: [],
          grant_types: ['client_credentials'],
          response_types: [],
          token_endpoint_auth_method: 'client_secret_basic',
          authkit_service_tenant: {
            partition: 'acme',
            capabilities: ['flags:ruleset:read', 'config:read'],
            environment: 'production',
          },
        },
        0,
      );
      const service = new OidcService(cfg, 'a'.repeat(32));
      handler = service.callback;
      return () => new Promise<void>((r) => server.close(() => r()));
    });

    const credentials = () => ({ issuer, clientId: 'app-acme', clientSecret: 'acme-secret' });

    test('one client gets a token per resource; each control plane verifies its own', async ({
      assert,
    }) => {
      for (const resource of ['urn:agora:durable', 'urn:agora:flags', 'urn:agora:config']) {
        const jwt = await authkitTenantToken({ ...credentials(), resource })();
        const claims = decodeJwt(jwt);
        assert.equal(claims.aud, resource);
        assert.equal(claims.partition, 'acme');
        assert.equal(claims.environment, 'production');
        assert.deepEqual(claims.capabilities, ['flags:ruleset:read', 'config:read']);

        const verified = await authkitTenantVerifier({ issuer, resource })({ token: jwt });
        assert.deepInclude(verified!, {
          partition: 'acme',
          environment: 'production',
          capabilities: ['flags:ruleset:read', 'config:read'],
          clientId: 'app-acme',
        });
      }
    });

    test('a token for one product is refused by another', async ({ assert }) => {
      const flagsToken = await authkitTenantToken({
        ...credentials(),
        resource: 'urn:agora:flags',
      })();
      assert.equal(decodeJwt(flagsToken).exp! - decodeJwt(flagsToken).iat!, 120);
      const durable = authkitTenantVerifier({ issuer, resource: 'urn:agora:durable' });
      assert.isNull(await durable({ token: flagsToken }));
    });

    test('several resources declared: the client must name one', async ({ assert }) => {
      const error = await authkitTenantToken(credentials())().catch((e) => e);
      assert.instanceOf(error, TenantTokenError);
      assert.equal(error.code, 'invalid_target');
    });

    test('a staging control plane refuses a production token', async ({ assert }) => {
      const jwt = await authkitTenantToken({ ...credentials(), resource: 'urn:agora:config' })();
      const staging = authkitTenantVerifier({
        issuer,
        resource: 'urn:agora:config',
        environment: 'staging',
      });
      assert.isNull(await staging({ token: jwt }));
    });
  },
);
