import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { adapters, defineConfig } from '../src/define_config.js';
import { AdminClientsService } from '../src/host/admin_clients_service.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

/** Cria a tabela OIDC no SQLite em memória. */
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

/** Sobe um OidcService com SQLite em memória. */
async function startService(port: number, db: any) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

test.group('boot sem clients estáticos', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('servidor sobe normalmente sem nenhum client no config (clients omitido)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9930;
    // clients omitido — sempre array vazio (clients são 100% runtime).
    const issuer = `http://localhost:${port}`;
    const fakeApp = { container: { make: async () => db } } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer,
        adapter: adapters.database({}),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
      }),
    );

    assert.isOk(cfg, 'config deve resolver mesmo sem clients');
    assert.deepEqual(cfg!.clients, [], 'clients deve ser array vazio quando omitido');

    // Sobe o serviço — não deve lançar.
    const service = new OidcService(cfg!, 'a'.repeat(32));
    const server: Server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(port, r));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    assert.isOk(service.provider);
    assert.equal(service.provider.issuer, issuer);
  });

  test('servidor sobe normalmente com clients explicitamente vazio (equivalente)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9931;
    const issuer = `http://localhost:${port}`;
    const fakeApp = { container: { make: async () => db } } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer,
        adapter: adapters.database({}),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
      }),
    );

    assert.deepEqual(cfg!.clients, []);
    const service = new OidcService(cfg!, 'a'.repeat(32));
    const server: Server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(port, r));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Discovery deve funcionar.
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.issuer, issuer);
  });

  test('client criado via AdminClientsService após boot é localizável pelo provider', async ({
    assert,
    cleanup,
  }) => {
    const port = 9932;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const svc = new AdminClientsService(service);
    const created = await svc.create({
      redirectUris: [`http://localhost:${port}/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });

    assert.isString(created.clientId);
    const found = await (service.provider as any).Client.find(created.clientId);
    assert.isOk(found, 'client criado via console deve ser localizável pelo provider');
  });
});
