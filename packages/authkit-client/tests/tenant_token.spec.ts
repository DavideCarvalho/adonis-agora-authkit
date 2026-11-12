import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  adapters,
  authkitTenantVerifier,
  defineConfig as defineServer,
  OidcService,
  type ResolvedServerConfig,
  type TenantTokenIssuer,
} from '@adonis-agora/authkit-server';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { decodeJwt } from 'jose';
import { AuthkitTenantToken, authkitTenantToken, TenantTokenError } from '../src/tenant_token.js';

const TOKEN_ENDPOINT = 'https://idp.example.com/token';
const SECRET = 'super-secret-value';

/** A fake token endpoint: counts calls, answers from `respond`. */
function fakeEndpoint(respond: (call: number) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // Yield so concurrent callers really overlap.
    await new Promise((r) => setTimeout(r, 5));
    const { status, body } = respond(calls.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const base = {
  issuer: 'https://idp.example.com',
  clientId: 'worker-acme',
  clientSecret: SECRET,
  resource: 'urn:agora:durable',
  tokenEndpoint: TOKEN_ENDPOINT,
};

test.group('authkitTenantToken (unit)', () => {
  test('sends client_credentials with the resource and caches the token', async ({ assert }) => {
    const ep = fakeEndpoint((n) => ({
      status: 200,
      body: { access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 600 },
    }));
    const token = authkitTenantToken({ ...base, fetch: ep.fetchImpl });
    assert.equal(await token(), 'tok-1');
    assert.equal(await token.token(), 'tok-1');
    assert.lengthOf(ep.calls, 1);

    const { url, init } = ep.calls[0];
    assert.equal(url, TOKEN_ENDPOINT);
    const body = new URLSearchParams(init.body as string);
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('resource'), 'urn:agora:durable');
    const auth = (init.headers as Record<string, string>).authorization;
    assert.equal(auth, `Basic ${Buffer.from(`worker-acme:${SECRET}`).toString('base64')}`);
  });

  test('concurrent callers share one request', async ({ assert }) => {
    const ep = fakeEndpoint(() => ({
      status: 200,
      body: { access_token: 'tok', expires_in: 600 },
    }));
    const source = new AuthkitTenantToken({ ...base, fetch: ep.fetchImpl });
    const results = await Promise.all(Array.from({ length: 20 }, () => source.token()));
    assert.lengthOf(ep.calls, 1);
    assert.isTrue(results.every((t) => t === 'tok'));
  });

  test('refreshes before expiry', async ({ assert, cleanup }) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    cleanup(() => {
      Date.now = realNow;
    });
    const ep = fakeEndpoint((n) => ({
      status: 200,
      body: { access_token: `tok-${n}`, expires_in: 600 },
    }));
    const token = authkitTenantToken({ ...base, fetch: ep.fetchImpl, refreshSkewSec: 60 });
    assert.equal(await token(), 'tok-1');
    now += 530_000; // 70 s before expiry: still fresh
    assert.equal(await token(), 'tok-1');
    now += 20_000; // 50 s before expiry: inside the skew
    assert.equal(await token(), 'tok-2');
    assert.lengthOf(ep.calls, 2);
  });

  test('a failed early refresh keeps serving the still-valid token', async ({
    assert,
    cleanup,
  }) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    cleanup(() => {
      Date.now = realNow;
    });
    const ep = fakeEndpoint((n) =>
      n === 1
        ? { status: 200, body: { access_token: 'tok-1', expires_in: 600 } }
        : { status: 503, body: { error: 'temporarily_unavailable' } },
    );
    const token = authkitTenantToken({ ...base, fetch: ep.fetchImpl });
    assert.equal(await token(), 'tok-1');
    now += 560_000;
    assert.equal(await token(), 'tok-1');
    // Backoff: no new request right away.
    assert.equal(await token(), 'tok-1');
    assert.lengthOf(ep.calls, 2);
  });

  test('backs off after a failure and never leaks the secret', async ({ assert, cleanup }) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    cleanup(() => {
      Date.now = realNow;
    });
    const ep = fakeEndpoint((n) =>
      n <= 2
        ? { status: 401, body: { error: 'invalid_client', error_description: 'client is invalid' } }
        : { status: 200, body: { access_token: 'tok', expires_in: 600 } },
    );
    const token = authkitTenantToken({ ...base, fetch: ep.fetchImpl });

    const first = await token().catch((e) => e);
    assert.instanceOf(first, TenantTokenError);
    assert.equal(first.status, 401);
    assert.equal(first.code, 'invalid_client');
    assert.notInclude(String(first.message), SECRET);
    assert.notInclude(JSON.stringify(first), SECRET);

    // Within the backoff: the same error, no request.
    assert.strictEqual(await token().catch((e) => e), first);
    assert.lengthOf(ep.calls, 1);

    now += 600; // past the first backoff (500 ms)
    await token().catch(() => {});
    assert.lengthOf(ep.calls, 2);
    now += 600; // second backoff is 1 s: still waiting
    await token().catch(() => {});
    assert.lengthOf(ep.calls, 2);
    now += 600;
    assert.equal(await token(), 'tok');
    assert.lengthOf(ep.calls, 3);
  });

  test('callers joining a failed early refresh also get the still-valid token', async ({
    assert,
    cleanup,
  }) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    cleanup(() => {
      Date.now = realNow;
    });
    const ep = fakeEndpoint((n) =>
      n === 1
        ? { status: 200, body: { access_token: 'tok-1', expires_in: 600 } }
        : { status: 503, body: { error: 'temporarily_unavailable' } },
    );
    const source = new AuthkitTenantToken({ ...base, fetch: ep.fetchImpl });
    assert.equal(await source.token(), 'tok-1');
    now += 560_000;
    const results = await Promise.all(Array.from({ length: 5 }, () => source.token()));
    assert.deepEqual(results, ['tok-1', 'tok-1', 'tok-1', 'tok-1', 'tok-1']);
    assert.lengthOf(ep.calls, 2);
  });

  test('reset() during a fetch: the stale result is not cached', async ({ assert }) => {
    const ep = fakeEndpoint((n) => ({
      status: 200,
      body: { access_token: `tok-${n}`, expires_in: 600 },
    }));
    const source = new AuthkitTenantToken({ ...base, fetch: ep.fetchImpl });
    const stale = source.token();
    source.reset();
    assert.equal(await stale, 'tok-1');
    assert.equal(await source.token(), 'tok-2');
    assert.equal(await source.token(), 'tok-2');
    assert.lengthOf(ep.calls, 2);
  });

  test('requires issuer, clientId and clientSecret', ({ assert }) => {
    assert.throws(() => authkitTenantToken({ ...base, clientSecret: '' }), /required/);
  });
});

test.group('authkitTenantToken against authkit-server', (group) => {
  let server: Server;
  let service: OidcService;
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
        serviceTenants: { resources: { 'urn:agora:durable': { expiresIn: 300 } } },
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
      'tenant-e2e',
      {
        client_id: 'tenant-e2e',
        client_secret: 'tenant-secret',
        redirect_uris: [],
        post_logout_redirect_uris: [],
        grant_types: ['client_credentials'],
        response_types: [],
        token_endpoint_auth_method: 'client_secret_basic',
        authkit_service_tenant: { partition: 'acme', capabilities: ['reports'] },
      },
      0,
    );
    service = new OidcService(cfg, 'a'.repeat(32));
    handler = service.callback;
    return () => new Promise<void>((r) => server.close(() => r()));
  });

  test('discovers the token endpoint, gets a JWT, and the control plane verifies it', async ({
    assert,
  }) => {
    const token = authkitTenantToken({
      issuer,
      clientId: 'tenant-e2e',
      clientSecret: 'tenant-secret',
      resource: 'urn:agora:durable',
    });
    const jwt = await token();
    const claims = decodeJwt(jwt);
    assert.equal(claims.aud, 'urn:agora:durable');
    assert.equal(claims.partition, 'acme');
    assert.equal(claims.exp! - claims.iat!, 300);

    const verify = authkitTenantVerifier({
      issuer: () => service as unknown as TenantTokenIssuer,
    });
    assert.deepEqual(await verify.verify({ token: jwt }), {
      tenant: 'acme',
      capabilities: ['reports'],
    });
  });

  test('a wrong secret is an invalid_client error', async ({ assert }) => {
    const token = authkitTenantToken({
      issuer,
      clientId: 'tenant-e2e',
      clientSecret: 'wrong',
      resource: 'urn:agora:durable',
    });
    const error = await token().catch((e) => e);
    assert.instanceOf(error, TenantTokenError);
    assert.equal(error.code, 'invalid_client');
  });
});
