import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { decodeJwt, decodeProtectedHeader, importJWK, SignJWT } from 'jose';
import type { AuditEvent, AuditSink } from '../src/audit/audit_sink.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../src/define_config.js';
import { inProcessAccessTokenVerifier } from '../src/host/access_token_verifier.js';
import { AdminClientsService, type ClientInput } from '../src/host/admin_clients_service.js';
import { ClientMetadataError } from '../src/host/client_metadata.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { resolveServiceTenants } from '../src/service_tenants/config.js';
import {
  authkitTenantVerifier,
  type TenantTokenIssuer,
} from '../src/service_tenants/tenant_verifier.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';
import { seedClients } from './helpers/seed_clients.js';

const RESOURCE = 'urn:agora:durable';
const USER_API = 'https://api.example.com';

async function migrate(db: any) {
  await db.connection().schema.createTable('authkit_oidc_payloads', (t: any) => {
    t.string('id').notNullable();
    t.string('model_name').notNullable();
    t.text('payload').notNullable();
    t.string('grant_id').nullable();
    t.string('user_code').nullable();
    t.string('uid').nullable();
    t.timestamp('expires_at').nullable();
    t.primary(['model_name', 'id']);
  });
}

function memoryAudit(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(event: AuditEvent) {
      events.push(event);
    },
  } as AuditSink & { events: AuditEvent[] };
}

interface Started {
  issuer: string;
  service: OidcService;
  clients: AdminClientsService;
  audit: ReturnType<typeof memoryAudit>;
  close: () => Promise<void>;
}

async function start(db: any, overrides: Record<string, unknown> = {}): Promise<Started> {
  // Listen first so the issuer carries the real port.
  let handler: (req: any, res: any) => void = (_req, res) => res.end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://localhost:${port}`;
  const audit = memoryAudit();
  const fakeApp = { container: { make: async () => db } } as any;
  const cfg = (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      audit,
      serviceTenants: { resources: { [RESOURCE]: {} } },
      accessTokens: { resources: { [USER_API]: { format: 'jwt' } } },
      ...overrides,
    }),
  )) as ResolvedServerConfig;
  await seedClients(cfg, [
    {
      clientId: 'plain-cc',
      clientSecret: 'plain-secret',
      redirectUris: [],
      grants: ['client_credentials'],
    },
  ]);
  const service = new OidcService(cfg, 'a'.repeat(32));
  handler = service.callback;
  return {
    issuer,
    service,
    clients: new AdminClientsService(service),
    audit,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const tenantInput = (overrides: Partial<ClientInput> = {}): ClientInput => ({
  clientId: 'worker-acme',
  redirectUris: [],
  postLogoutRedirectUris: [],
  grantTypes: ['client_credentials'],
  tokenEndpointAuthMethod: 'client_secret_basic',
  serviceTenant: { partition: 'acme', capabilities: ['reports', 'billing'] },
  ...overrides,
});

async function requestToken(
  issuer: string,
  clientId: string,
  secret: string,
  params: Record<string, string> = { resource: RESOURCE },
) {
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...params }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test.group('service tenants: config', () => {
  test('resolves resources with a 10-minute default lifetime', ({ assert }) => {
    const r = resolveServiceTenants({
      resources: { [RESOURCE]: {}, 'https://cp/': { expiresIn: 60 } },
    });
    assert.isTrue(r.enabled);
    assert.deepEqual(r.resources[RESOURCE], { audience: RESOURCE, expiresIn: 600, scopes: [] });
    assert.equal(r.resources['https://cp/'].expiresIn, 60);
    assert.isFalse(resolveServiceTenants(undefined).enabled);
  });

  test('refuses a resource shared with accessTokens, a relative URI and a bad lifetime', ({
    assert,
  }) => {
    assert.throws(
      () => resolveServiceTenants({ resources: { [RESOURCE]: {} } }, { [RESOURCE]: {} }),
      /both accessTokens.resources and serviceTenants.resources/,
    );
    assert.throws(() => resolveServiceTenants({ resources: { durable: {} } }), /absolute URI/);
    assert.throws(
      () => resolveServiceTenants({ resources: { [RESOURCE]: { expiresIn: 0 } } }),
      /positive integer/,
    );
  });
});

test.group('service tenants: issuance', (group) => {
  let db: any;
  let s: Started;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    s = await start(db);
    return async () => {
      await s.close();
      await db.manager.closeAll();
    };
  });

  test('issues a JWT with partition and capabilities for the resource', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    const { status, body } = await requestToken(s.issuer, 'worker-acme', clientSecret!);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 600);

    assert.equal(decodeProtectedHeader(body.access_token).typ, 'at+jwt');
    const claims = decodeJwt(body.access_token);
    assert.equal(claims.iss, s.issuer);
    assert.equal(claims.aud, RESOURCE);
    assert.equal(claims.sub, 'worker-acme');
    assert.equal(claims.client_id, 'worker-acme');
    assert.equal(claims.partition, 'acme');
    assert.deepEqual(claims.capabilities, ['reports', 'billing']);
    assert.equal(claims.exp! - claims.iat!, 600);

    const issued = s.audit.events.find((e) => e.type === 'service_tenant.token_issued');
    assert.equal(issued?.clientId, 'worker-acme');
    assert.equal(issued?.metadata?.partition, 'acme');
    assert.equal(issued?.metadata?.resource, RESOURCE);
  });

  test('defaults to the only declared resource when none is sent', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(
      tenantInput({ serviceTenant: { partition: 'acme' } }),
    );
    const { status, body } = await requestToken(s.issuer, 'worker-acme', clientSecret!, {});
    assert.equal(status, 200, JSON.stringify(body));
    const claims = decodeJwt(body.access_token);
    assert.equal(claims.aud, RESOURCE);
    assert.equal(claims.partition, 'acme');
    assert.notProperty(claims, 'capabilities');
  });

  test('a regular client_credentials client cannot get a service-tenant token', async ({
    assert,
  }) => {
    const { status, body } = await requestToken(s.issuer, 'plain-cc', 'plain-secret');
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_target');
  });

  test('a service tenant cannot get a token for a user API', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    const { status, body } = await requestToken(s.issuer, 'worker-acme', clientSecret!, {
      resource: USER_API,
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_target');
  });

  test('its token never authenticates an account', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    const { body } = await requestToken(s.issuer, 'worker-acme', clientSecret!);
    const verifier = inProcessAccessTokenVerifier(async () => s.service);
    assert.isNull(await verifier.verify(body.access_token));
  });

  test('the client must be confidential, client_credentials only, without redirects', async ({
    assert,
  }) => {
    const bad: Array<Partial<ClientInput>> = [
      { tokenEndpointAuthMethod: 'none' },
      { grantTypes: ['client_credentials', 'authorization_code'] },
      { redirectUris: ['https://app/cb'] },
      { serviceTenant: { partition: 'has spaces' } },
      { serviceTenant: { partition: 'acme', capabilities: ['bad cap'] } },
    ];
    for (const overrides of bad) {
      await assert.rejects(
        () => s.clients.create(tenantInput({ clientId: undefined, ...overrides })),
        ClientMetadataError,
      );
    }
  });

  test('edits apply to the next token', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    await s.clients.update('worker-acme', {
      serviceTenant: { partition: 'globex', capabilities: [] },
    });
    const { body } = await requestToken(s.issuer, 'worker-acme', clientSecret!);
    const claims = decodeJwt(body.access_token);
    assert.equal(claims.partition, 'globex');
    assert.notProperty(claims, 'capabilities');
    const listed = await s.clients.find('worker-acme');
    assert.deepEqual(listed?.serviceTenant, { partition: 'globex', capabilities: [] });
  });

  test('disabling the client stops issuance immediately; enabling restores it', async ({
    assert,
  }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    assert.equal((await requestToken(s.issuer, 'worker-acme', clientSecret!)).status, 200);

    await s.clients.setDisabled('worker-acme', true);
    const refused = await requestToken(s.issuer, 'worker-acme', clientSecret!);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error, 'invalid_client');
    assert.isTrue((await s.clients.find('worker-acme'))?.disabled);

    // An edit keeps it disabled.
    await s.clients.update('worker-acme', { clientName: 'Acme worker' });
    assert.equal((await requestToken(s.issuer, 'worker-acme', clientSecret!)).status, 401);

    await s.clients.setDisabled('worker-acme', false);
    assert.equal((await requestToken(s.issuer, 'worker-acme', clientSecret!)).status, 200);
  });

  test('rotating the secret invalidates the old one', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(tenantInput());
    const rotated = await s.clients.regenerateSecret('worker-acme');
    const old = await requestToken(s.issuer, 'worker-acme', clientSecret!);
    assert.equal(old.status, 401);
    assert.equal(old.body.error, 'invalid_client');
    const fresh = await requestToken(s.issuer, 'worker-acme', rotated);
    assert.equal(fresh.status, 200);
    assert.equal(decodeJwt(fresh.body.access_token).partition, 'acme');
  });
});

test.group('service tenants: disabled', () => {
  test('without serviceTenants, a service-tenant client cannot be created', async ({ assert }) => {
    const db = createTestDatabase();
    await migrate(db);
    const s = await start(db, { serviceTenants: undefined });
    try {
      await assert.rejects(() => s.clients.create(tenantInput()), /not enabled/);
    } finally {
      await s.close();
      await db.manager.closeAll();
    }
  });
});

test.group('service tenants: authkitTenantVerifier', (group) => {
  let db: any;
  let s: Started;
  let secret: string;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    s = await start(db);
    secret = (await s.clients.create(tenantInput())).clientSecret!;
    return async () => {
      await s.close();
      await db.manager.closeAll();
    };
  });

  const issuerOf = (svc: OidcService) => () => svc as unknown as TenantTokenIssuer;

  /** Signs `claims` with the provider's own signing key (same `kid` as the JWKS). */
  async function forge(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> {
    const jwk = s.service.signingJwks.keys[0];
    const key = await importJWK(jwk as any, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: s.issuer,
      aud: RESOURCE,
      sub: 'worker-acme',
      client_id: 'worker-acme',
      iat: now,
      exp: now + 600,
      partition: 'acme',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid, ...header })
      .sign(key);
  }

  test('returns the tenant and capabilities of a real token', async ({ assert }) => {
    const { body } = await requestToken(s.issuer, 'worker-acme', secret);
    const verify = authkitTenantVerifier({ issuer: issuerOf(s.service) });
    assert.deepEqual(await verify({ token: body.access_token }), {
      tenant: 'acme',
      capabilities: ['reports', 'billing'],
    });
    // Same result through the object form (durable's TenantVerifierContract).
    assert.deepEqual(await verify.verify({ token: body.access_token, tenant: 'other' }), {
      tenant: 'acme',
      capabilities: ['reports', 'billing'],
    });
  });

  test('rejects a missing token, a wrong audience and a wrong issuer', async ({ assert }) => {
    const { body } = await requestToken(s.issuer, 'worker-acme', secret);
    const verify = authkitTenantVerifier({ issuer: issuerOf(s.service) });
    assert.isNull(await verify({}));
    assert.isNull(await verify({ token: 'not-a-jwt' }));
    assert.isNull(
      await authkitTenantVerifier({ issuer: issuerOf(s.service), audience: 'urn:other' })({
        token: body.access_token,
      }),
    );
    const otherIssuer = () =>
      ({
        publicJwks: s.service.publicJwks,
        config: { ...s.service.config, issuer: 'https://evil.example.com' },
      }) as TenantTokenIssuer;
    assert.isNull(
      await authkitTenantVerifier({ issuer: otherIssuer })({ token: body.access_token }),
    );
  });

  test('rejects an expired token, a missing partition and a user token', async ({ assert }) => {
    const verify = authkitTenantVerifier({ issuer: issuerOf(s.service) });
    assert.isNotNull(await verify({ token: await forge({}) }));
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.isNull(await verify({ token: await forge({ iat: past - 600, exp: past }) }));
    assert.isNull(await verify({ token: await forge({ partition: undefined }) }));
    assert.isNull(await verify({ token: await forge({ sub: 'user-1' }) }));
    assert.isNull(await verify({ token: await forge({ capabilities: 'reports' }) }));
  });

  test('rejects alg none, HS256 and a tampered signature', async ({ assert }) => {
    const verify = authkitTenantVerifier({ issuer: issuerOf(s.service) });
    const good = await forge({});
    const [h, p] = good.split('.');
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'at+jwt' })}.${p}.`;
    assert.isNull(await verify({ token: none }));
    const hs = await new SignJWT(decodeJwt(good) as any)
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    assert.isNull(await verify({ token: hs }));
    const tamperedPayload = b64({ ...decodeJwt(good), partition: 'globex' });
    assert.isNull(await verify({ token: `${h}.${tamperedPayload}.${good.split('.')[2]}` }));
  });

  test('follows a signing-key rotation', async ({ assert }) => {
    const { body } = await requestToken(s.issuer, 'worker-acme', secret);
    let current: TenantTokenIssuer = s.service as unknown as TenantTokenIssuer;
    const verify = authkitTenantVerifier({ issuer: () => current });
    assert.isNotNull(await verify({ token: body.access_token }));

    // A fresh issuer with other keys: the old token no longer verifies.
    const db2 = createTestDatabase();
    await migrate(db2);
    const other = await start(db2, { issuer: s.issuer });
    try {
      current = other.service as unknown as TenantTokenIssuer;
      assert.isNull(await verify({ token: body.access_token }));
      // Keys published side by side (rotation window): both verify.
      current = {
        publicJwks: {
          keys: [...other.service.publicJwks.keys, ...s.service.publicJwks.keys],
        },
        config: s.service.config,
      };
      assert.isNotNull(await verify({ token: body.access_token }));
    } finally {
      await other.close();
      await db2.manager.closeAll();
    }
  });

  test('without an explicit audience, several resources need one', async ({ assert }) => {
    const multi = {
      publicJwks: s.service.publicJwks,
      config: {
        issuer: s.issuer,
        serviceTenants: resolveServiceTenants({
          resources: { [RESOURCE]: {}, 'urn:agora:flags': {} },
        }),
      },
    };
    await assert.rejects(
      async () => authkitTenantVerifier({ issuer: () => multi })({ token: await forge({}) }),
      /pass \{ audience \}/,
    );
    assert.isNotNull(
      await authkitTenantVerifier({ issuer: () => multi, audience: RESOURCE })({
        token: await forge({}),
      }),
    );
  });
});
