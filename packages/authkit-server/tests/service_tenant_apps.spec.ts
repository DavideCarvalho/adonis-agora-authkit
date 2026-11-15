import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { decodeJwt } from 'jose';
import type { AuditEvent, AuditSink } from '../src/audit/audit_sink.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../src/define_config.js';
import { AdminClientsService, type ClientInput } from '../src/host/admin_clients_service.js';
import { ClientMetadataError } from '../src/host/client_metadata.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { SERVICE_TENANT_KEY, serviceTenantOf } from '../src/service_tenants/client_metadata.js';
import { appResourceName, resolveServiceTenants } from '../src/service_tenants/config.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

const DURABLE = 'urn:agora:durable';
const BILLING = 'urn:agora:app:billing';

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

interface Started {
  issuer: string;
  clients: AdminClientsService;
  audit: AuditEvent[];
  close: () => Promise<void>;
}

async function start(db: any, serviceTenants: unknown): Promise<Started> {
  let handler: (req: any, res: any) => void = (_req, res) => res.end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const issuer = `http://localhost:${(server.address() as AddressInfo).port}`;
  const audit: AuditEvent[] = [];
  const sink = { record: async (e: AuditEvent) => void audit.push(e) } as AuditSink;
  const cfg = (await configProvider.resolve(
    { container: { make: async () => db } } as any,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      audit: sink,
      serviceTenants: serviceTenants as any,
    }),
  )) as ResolvedServerConfig;
  const service = new OidcService(cfg, 'a'.repeat(32));
  handler = service.callback;
  return {
    issuer,
    clients: new AdminClientsService(service),
    audit,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const orders = (
  overrides: Partial<NonNullable<ClientInput['serviceTenant']>> = {},
): ClientInput => ({
  clientId: 'orders',
  redirectUris: [],
  postLogoutRedirectUris: [],
  grantTypes: ['client_credentials'],
  tokenEndpointAuthMethod: 'client_secret_basic',
  serviceTenant: {
    partition: 'orders',
    capabilities: ['durable:enqueue'],
    apps: { billing: ['invoices:read'] },
    ...overrides,
  },
});

async function requestToken(issuer: string, clientId: string, secret: string, resource?: string) {
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      ...(resource ? { resource } : {}),
    }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test.group('calls between apps: config', () => {
  test('on by default with service tenants, 5-minute tokens; `apps: false` turns it off', ({
    assert,
  }) => {
    const on = resolveServiceTenants({ resources: { [DURABLE]: {} } });
    assert.deepEqual(on.apps, { expiresIn: 300 });
    assert.isUndefined(resolveServiceTenants({ resources: { [DURABLE]: {} }, apps: false }).apps);
    assert.deepEqual(resolveServiceTenants({ apps: { expiresIn: 60 } }).apps, { expiresIn: 60 });
    // Only calls between apps: still enabled (the client_credentials grant is on).
    assert.isTrue(resolveServiceTenants({}).enabled);
    assert.isFalse(resolveServiceTenants({ apps: false }).enabled);
    assert.isFalse(resolveServiceTenants(undefined).enabled);
  });

  test('app resources are granted per client, never declared', ({ assert }) => {
    assert.throws(
      () => resolveServiceTenants({ resources: { [BILLING]: {} } }),
      /granted per client/,
    );
    assert.throws(() => resolveServiceTenants({}, { [BILLING]: {} }), /app resource/);
    assert.throws(() => resolveServiceTenants({ apps: { expiresIn: 0 } }), /positive integer/);
  });

  test('appResourceName', ({ assert }) => {
    assert.equal(appResourceName(BILLING), 'billing');
    assert.isNull(appResourceName('urn:agora:app:'));
    assert.isNull(appResourceName('urn:agora:app:a/b'));
    assert.isNull(appResourceName(DURABLE));
  });
});

test.group('calls between apps: stored grants', () => {
  test('a corrupted grant is dropped whole, never narrowed (fail closed)', ({ assert }) => {
    const read = serviceTenantOf({
      [SERVICE_TENANT_KEY]: {
        partition: 'orders',
        capabilities: [],
        apps: {
          billing: ['invoices:read'],
          'bad name': ['x'],
          reports: ['ok', 42],
          shipping: 'labels',
        },
      },
    });
    assert.deepEqual(read?.apps, { billing: ['invoices:read'] });
  });
});

test.group('calls between apps: issuance', (group) => {
  let db: any;
  let s: Started;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    s = await start(db, { resources: { [DURABLE]: {} } });
    return async () => {
      await s.close();
      await db.manager.closeAll();
    };
  });

  test('a granted app: JWT for urn:agora:app:<name>, caller as partition, grant as capabilities', async ({
    assert,
  }) => {
    const { clientSecret } = await s.clients.create(orders({ environment: 'production' }));
    const { status, body } = await requestToken(s.issuer, 'orders', clientSecret!, BILLING);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.expires_in, 300);
    const claims = decodeJwt(body.access_token);
    assert.equal(claims.aud, BILLING);
    assert.equal(claims.sub, 'orders');
    assert.equal(claims.client_id, 'orders');
    assert.equal(claims.partition, 'orders');
    assert.equal(claims.environment, 'production');
    assert.deepEqual(claims.capabilities, ['invoices:read']);

    const issued = s.audit.find(
      (e) => e.type === 'service_tenant.token_issued' && e.metadata?.app === 'billing',
    );
    assert.equal(issued?.metadata?.resource, BILLING);

    // The product resource keeps the client's own capabilities.
    const durable = await requestToken(s.issuer, 'orders', clientSecret!, DURABLE);
    assert.deepEqual(decodeJwt(durable.body.access_token).capabilities, ['durable:enqueue']);
  });

  test('a granted app without capabilities: no capabilities claim', async ({ assert }) => {
    const { clientSecret } = await s.clients.create(orders({ apps: { billing: [] } }));
    const { body } = await requestToken(s.issuer, 'orders', clientSecret!, BILLING);
    assert.notProperty(decodeJwt(body.access_token), 'capabilities');
  });

  test('an app not granted, a regular client and a bad name are refused (invalid_target)', async ({
    assert,
  }) => {
    const { clientSecret } = await s.clients.create(orders());
    const other = await requestToken(s.issuer, 'orders', clientSecret!, 'urn:agora:app:reports');
    assert.equal(other.status, 400);
    assert.equal(other.body.error, 'invalid_target');

    const plain = await s.clients.create({
      clientId: 'plain',
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: ['client_credentials'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    const refused = await requestToken(s.issuer, 'plain', plain.clientSecret!, BILLING);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'invalid_target');

    await assert.rejects(
      () => s.clients.create(orders({ apps: { 'bad name': [] } })),
      ClientMetadataError,
    );
    await assert.rejects(
      () => s.clients.create(orders({ apps: { billing: ['bad cap'] } })),
      ClientMetadataError,
    );
  });

  test('setAppGrant grants, changes and takes away, applying to the next token', async ({
    assert,
  }) => {
    const { clientSecret } = await s.clients.create(orders({ apps: {} }));
    assert.equal((await requestToken(s.issuer, 'orders', clientSecret!, BILLING)).status, 400);

    let client = await s.clients.setAppGrant('orders', 'billing', ['invoices:write']);
    assert.deepEqual(client?.serviceTenant?.apps, { billing: ['invoices:write'] });
    // The rest of the service tenant is kept.
    assert.equal(client?.serviceTenant?.partition, 'orders');
    assert.deepEqual(client?.serviceTenant?.capabilities, ['durable:enqueue']);
    const granted = await requestToken(s.issuer, 'orders', clientSecret!, BILLING);
    assert.deepEqual(decodeJwt(granted.body.access_token).capabilities, ['invoices:write']);

    client = await s.clients.setAppGrant('orders', 'billing', null);
    assert.notProperty(client!.serviceTenant!, 'apps');
    assert.equal((await requestToken(s.issuer, 'orders', clientSecret!, BILLING)).status, 400);

    assert.isUndefined(await s.clients.setAppGrant('nope', 'billing', []));
  });

  test('setAppGrant refuses a client that is not a service tenant', async ({ assert }) => {
    await s.clients.create({
      clientId: 'web',
      redirectUris: ['https://app.example.com/cb'],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    await assert.rejects(() => s.clients.setAppGrant('web', 'billing', []), /not a service tenant/);
  });
});

test.group('calls between apps: off', () => {
  test('`apps: false`: an app resource is not a known resource', async ({ assert }) => {
    const db = createTestDatabase();
    await migrate(db);
    const s = await start(db, { resources: { [DURABLE]: {} }, apps: false });
    try {
      const { clientSecret } = await s.clients.create(orders());
      const { status, body } = await requestToken(s.issuer, 'orders', clientSecret!, BILLING);
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_target');
    } finally {
      await s.close();
      await db.manager.closeAll();
    }
  });

  test('only calls between apps (`serviceTenants: {}`): a token needs the resource', async ({
    assert,
  }) => {
    const db = createTestDatabase();
    await migrate(db);
    const s = await start(db, {});
    try {
      const { clientSecret } = await s.clients.create(orders());
      assert.equal((await requestToken(s.issuer, 'orders', clientSecret!, BILLING)).status, 200);
      const none = await requestToken(s.issuer, 'orders', clientSecret!);
      assert.equal(none.status, 400);
      assert.equal(none.body.error, 'invalid_target');
    } finally {
      await s.close();
      await db.manager.closeAll();
    }
  });
});
