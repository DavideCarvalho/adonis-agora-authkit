import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { adapters, defineConfig } from '../src/define_config.js';
import { AdminClientsService } from '../src/host/admin_clients_service.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

/**
 * Cria a tabela única usada pelo DatabaseAdapter (mesmo schema da migration do host).
 */
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

/**
 * Sobe um OidcService sobre o DatabaseAdapter (sqlite em memória), com o issuer
 * na raiz (endpoint de registro dinâmico em `/reg`). O MESMO `db` é compartilhado
 * entre o provider e o AdminClientsService — provando que ambos leem/gravam o
 * mesmo store de artefatos `Client`.
 */
async function startService(port: number, db: any) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'static1',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code', 'refresh_token'],
        },
      ],
      accountStore: fakeAccountStore(),
      dynamicRegistration: { enabled: true, initialAccessToken: 'iat', management: true },
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

test.group('AdminClientsService (CRUD de clients OIDC adapter-backed)', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('listClients enumera o que o registro dinâmico (RFC 7591) persistiu', async ({
    assert,
    cleanup,
  }) => {
    const port = 9841;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Registra um client via o endpoint dinâmico do provider.
    const res = await fetch(`${issuer}/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer iat' },
      body: JSON.stringify({
        redirect_uris: [`${issuer}/dyn/cb`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    const admin = new AdminClientsService(service);
    assert.isTrue(admin.canList);
    const list = await admin.list();
    const found = list.find((c) => c.clientId === body.client_id);
    assert.isOk(found, 'o client registrado dinamicamente deve aparecer em listClients');
    assert.deepEqual(found!.redirectUris, [`${issuer}/dyn/cb`]);
    assert.isTrue(found!.confidential);
  });

  test('create persiste um client encontrável pelo provider (forma de payload correta)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9842;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const admin = new AdminClientsService(service);
    const created = await admin.create({
      redirectUris: [`${issuer}/app/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    assert.isString(created.clientId);
    assert.isString(created.clientSecret);

    // Prova de forma de payload: o provider constrói o Client a partir do payload gravado.
    const found = await (service.provider as any).Client.find(created.clientId);
    assert.isOk(found);
    assert.deepEqual(found.metadata().redirect_uris, [`${issuer}/app/cb`]);
  });

  test('update invalida o cache: find devolve a metadata NOVA', async ({ assert, cleanup }) => {
    const port = 9843;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const admin = new AdminClientsService(service);
    const created = await admin.create({
      redirectUris: [`${issuer}/old/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });

    // Carrega (e cacheia) o client com a metadata ANTIGA.
    const before = await (service.provider as any).Client.find(created.clientId);
    assert.deepEqual(before.metadata().redirect_uris, [`${issuer}/old/cb`]);

    // Atualiza via admin (dispara evictDynamicClientCache).
    await admin.update(created.clientId, {
      clientId: created.clientId,
      redirectUris: [`${issuer}/new/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });

    const after = await (service.provider as any).Client.find(created.clientId);
    assert.deepEqual(
      after.metadata().redirect_uris,
      [`${issuer}/new/cb`],
      'após a invalidação o provider deve servir a metadata atualizada',
    );
  });

  test('regenerateSecret troca o secret preservando o resto da metadata', async ({
    assert,
    cleanup,
  }) => {
    const port = 9844;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const admin = new AdminClientsService(service);
    const created = await admin.create({
      redirectUris: [`${issuer}/app/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    const newSecret = await admin.regenerateSecret(created.clientId);
    assert.isString(newSecret);
    assert.notEqual(newSecret, created.clientSecret);

    const found = await (service.provider as any).Client.find(created.clientId);
    assert.deepEqual(found.metadata().redirect_uris, [`${issuer}/app/cb`]);
  });

  test('delete remove o client: find devolve undefined', async ({ assert, cleanup }) => {
    const port = 9845;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const admin = new AdminClientsService(service);
    const created = await admin.create({
      redirectUris: [`${issuer}/app/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    // garante que está carregado/cacheado
    assert.isOk(await (service.provider as any).Client.find(created.clientId));

    await admin.delete(created.clientId);
    assert.isUndefined(await admin.find(created.clientId));
    assert.isUndefined(await (service.provider as any).Client.find(created.clientId));
  });

  test('public client (auth method none) não recebe secret', async ({ assert, cleanup }) => {
    const port = 9846;
    const { issuer, service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const admin = new AdminClientsService(service);
    const created = await admin.create({
      redirectUris: [`${issuer}/spa/cb`],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
    });
    assert.isUndefined(created.clientSecret);
    const found = await admin.find(created.clientId);
    assert.isFalse(found!.confidential);
  });
});
