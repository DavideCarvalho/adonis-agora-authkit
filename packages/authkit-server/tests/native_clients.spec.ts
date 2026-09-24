/**
 * Clients nativos (RFC 8252 — OAuth 2.0 for Native Apps).
 *
 *   - regras de redirect por `application_type` (esquema privado, https claimed,
 *     loopback) e a recusa desses redirects em client web;
 *   - client nativo é sempre público (sem secret, sem client_credentials);
 *   - `AdminClientsService` persiste `application_type: 'native'` e o oidc-provider
 *     aceita a metadata gravada (incluindo loopback com QUALQUER porta);
 *   - validator Vine da Admin API/console e o import de clients estáticos.
 */
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import AuthkitClientsCreate from '../commands/clients_create.js';
import { importClients } from '../src/commands/import_clients.js';
import type { ResolvedServerConfig } from '../src/define_config.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { AdminClientsService } from '../src/host/admin_clients_service.js';
import {
  clientCreateInput,
  clientInputValidator,
  clientPartialInput,
} from '../src/host/admin_validators.js';
import {
  assertClientMetadata,
  ClientMetadataError,
  redirectUriProblem,
} from '../src/host/client_metadata.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

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

async function startService(db: any) {
  const server: Server = createServer((req, res) => service.callback(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const cfg = await configProvider.resolve<ResolvedServerConfig>(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  return { service, server };
}

test.group('client_metadata — redirect URIs por application_type', () => {
  test('native aceita esquema privado, https claimed e loopback http', ({ assert }) => {
    for (const uri of [
      'com.example.app:/oauth',
      'myapp://auth',
      'exp://192.168.0.10:8081/--/auth',
      'https://app.example.com/oauth/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:53123/callback',
      'http://[::1]:8080/cb',
      'http://localhost:3000/cb',
    ]) {
      assert.isNull(redirectUriProblem(uri, 'native'), uri);
    }
  });

  test('native recusa http fora de loopback e https em loopback', ({ assert }) => {
    assert.match(redirectUriProblem('http://example.com/cb', 'native')!, /loopback/);
    assert.match(redirectUriProblem('https://127.0.0.1/cb', 'native')!, /loopback/);
  });

  test('web recusa esquema privado (continua só http/https)', ({ assert }) => {
    assert.match(redirectUriProblem('com.example.app:/oauth', 'web')!, /http\/https/);
    assert.match(redirectUriProblem('myapp://auth', 'web')!, /http\/https/);
    assert.isNull(redirectUriProblem('https://app.example.com/cb', 'web'));
    assert.isNull(redirectUriProblem('http://localhost:3000/cb', 'web'));
  });

  test('qualquer tipo recusa esquema perigoso, fragmento e URI relativa', ({ assert }) => {
    for (const type of ['web', 'native', undefined] as const) {
      assert.isNotNull(redirectUriProblem('javascript:alert(1)', type));
      assert.isNotNull(redirectUriProblem('data:text/html,x', type));
      assert.isNotNull(redirectUriProblem('myapp://auth#frag', type));
      assert.isNotNull(redirectUriProblem('/oauth/callback', type));
    }
  });

  test('client nativo precisa ser público e não usa client_credentials', ({ assert }) => {
    const base = {
      applicationType: 'native' as const,
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: ['com.example.app:/oauth'],
      postLogoutRedirectUris: [],
    };
    assert.doesNotThrow(() => assertClientMetadata({ ...base, tokenEndpointAuthMethod: 'none' }));
    assert.throws(
      () => assertClientMetadata({ ...base, tokenEndpointAuthMethod: 'client_secret_basic' }),
      /público/,
    );
    assert.throws(
      () =>
        assertClientMetadata({
          ...base,
          tokenEndpointAuthMethod: 'none',
          grantTypes: ['client_credentials'],
        }),
      /client_credentials/,
    );
  });
});

test.group('admin_validators — applicationType', () => {
  test('native com esquema privado passa; default de auth vira none', async ({ assert }) => {
    const v = await clientInputValidator.validate({
      applicationType: 'native',
      redirectUris: ['com.example.app:/oauth', 'http://127.0.0.1/cb'],
    });
    const input = clientCreateInput(v);
    assert.equal(input.applicationType, 'native');
    assert.equal(input.tokenEndpointAuthMethod, 'none');
  });

  test('web explícito com esquema privado → 422 no validator', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({
        applicationType: 'web',
        redirectUris: ['com.example.app:/oauth'],
      }),
    );
  });

  test('applicationType desconhecido → 422', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({ applicationType: 'desktop', redirectUris: [] }),
    );
  });

  test('create sem applicationType continua web/confidencial (default de sempre)', async ({
    assert,
  }) => {
    const input = clientCreateInput(
      await clientInputValidator.validate({ redirectUris: ['https://app1/cb'] }),
    );
    assert.equal(input.applicationType, 'web');
    assert.equal(input.tokenEndpointAuthMethod, 'client_secret_basic');
  });

  test('PATCH parcial só leva applicationType quando enviado', async ({ assert }) => {
    const partial = clientPartialInput(
      await clientInputValidator.validate({ redirectUris: ['myapp://auth'] }),
    );
    assert.notProperty(partial, 'applicationType');
    assert.deepEqual(partial.redirectUris, ['myapp://auth']);
  });
});

test.group('AdminClientsService — clients nativos', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('cria client nativo público: payload com application_type e sem secret', async ({
    assert,
    cleanup,
  }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const svc = new AdminClientsService(service);

    const created = await svc.create({
      clientId: 'mobile',
      applicationType: 'native',
      redirectUris: ['com.example.app:/oauth', 'http://127.0.0.1/callback'],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
    });
    assert.isUndefined(created.clientSecret);

    const presented = await svc.find('mobile');
    assert.equal(presented!.applicationType, 'native');
    assert.isFalse(presented!.confidential);

    // O oidc-provider aceita a metadata gravada (valida no `Client.find`).
    const client: any = await service.provider.Client.find('mobile');
    assert.isOk(client, 'o provider precisa montar o client nativo');
    assert.equal(client.applicationType, 'native');
    assert.equal(client.clientAuthMethod, 'none');
    assert.isTrue(client.redirectUriAllowed('com.example.app:/oauth'));
    // RFC 8252 §7.3: loopback registrado sem porta casa com QUALQUER porta.
    assert.isTrue(client.redirectUriAllowed('http://127.0.0.1:53123/callback'));
    assert.isFalse(client.redirectUriAllowed('http://127.0.0.1:53123/outro'));
  });

  test('client web continua sem application_type no payload', async ({ assert, cleanup }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const svc = new AdminClientsService(service);
    await svc.create({
      clientId: 'webapp',
      redirectUris: ['https://app.example.com/cb'],
      postLogoutRedirectUris: [],
      grantTypes: [],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    const row = await db.from('authkit_oidc_payloads').where('id', 'webapp').first();
    assert.notProperty(JSON.parse(row.payload), 'application_type');
    assert.equal((await svc.find('webapp'))!.applicationType, 'web');
  });

  test('recusa esquema privado em client web e secret em client nativo', async ({
    assert,
    cleanup,
  }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const svc = new AdminClientsService(service);

    await assert.rejects(
      () =>
        svc.create({
          clientId: 'bad-web',
          redirectUris: ['com.example.app:/oauth'],
          postLogoutRedirectUris: [],
          grantTypes: [],
          tokenEndpointAuthMethod: 'none',
        }),
      ClientMetadataError,
    );
    await assert.rejects(
      () =>
        svc.create({
          clientId: 'bad-native',
          applicationType: 'native',
          redirectUris: ['com.example.app:/oauth'],
          postLogoutRedirectUris: [],
          grantTypes: [],
          tokenEndpointAuthMethod: 'client_secret_basic',
        }),
      ClientMetadataError,
    );
    assert.isUndefined(await svc.find('bad-web'));
    assert.isUndefined(await svc.find('bad-native'));
  });

  test('update preserva o tipo nativo e valida contra ele', async ({ assert, cleanup }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const svc = new AdminClientsService(service);
    await svc.create({
      clientId: 'mobile',
      applicationType: 'native',
      redirectUris: ['com.example.app:/oauth'],
      postLogoutRedirectUris: [],
      grantTypes: [],
      tokenEndpointAuthMethod: 'none',
    });

    // PATCH sem applicationType: o tipo efetivo (native) vale para os redirects.
    await svc.update('mobile', { redirectUris: ['myapp://auth'] });
    const after = await svc.find('mobile');
    assert.equal(after!.applicationType, 'native');
    assert.deepEqual(after!.redirectUris, ['myapp://auth']);

    // Virar confidencial continua proibido para nativo.
    await assert.rejects(
      () => svc.update('mobile', { tokenEndpointAuthMethod: 'client_secret_basic' }),
      ClientMetadataError,
    );
  });

  test('importClients leva o applicationType do config estático', async ({ assert, cleanup }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const svc = new AdminClientsService(service);
    const report = await importClients(
      [
        {
          clientId: 'static-mobile',
          applicationType: 'native',
          redirectUris: ['com.example.app:/oauth'],
        },
      ],
      svc,
    );
    assert.equal(report.created, 1);
    const found = await svc.find('static-mobile');
    assert.equal(found!.applicationType, 'native');
    assert.equal(found!.tokenEndpointAuthMethod, 'none');
  });
});

/**
 * Roda o `authkit:clients:create` com um app/logger falsos: o container só
 * precisa entregar o `authkit.server` e o logger registra as linhas.
 */
async function runClientsCreate(service: OidcService, flags: Record<string, unknown>) {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const ui: any = { logger: { info: log, success: log, logError: log, error: log, warning: log } };
  const app: any = { container: { make: async () => service } };
  const cmd: any = new AuthkitClientsCreate(app, {} as any, {} as any, ui, {} as any);
  Object.assign(cmd, flags);
  await cmd.run();
  return { lines, exitCode: cmd.exitCode as number | undefined };
}

test.group('authkit:clients:create --native', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('--native cria client nativo público (implica --public)', async ({ assert, cleanup }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const { lines, exitCode } = await runClientsCreate(service, {
      clientId: 'expo-app',
      native: true,
      redirectUri: ['com.example.app:/oauth'],
      json: true,
    });
    assert.notEqual(exitCode, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.applicationType, 'native');
    assert.equal(out.tokenEndpointAuthMethod, 'none');
    assert.isFalse(out.confidential);
    assert.notProperty(out, 'clientSecret');

    const found = await new AdminClientsService(service).find('expo-app');
    assert.equal(found!.applicationType, 'native');
  });

  test('sem --native, redirect de esquema privado é recusado (exit 1)', async ({
    assert,
    cleanup,
  }) => {
    const { service, server } = await startService(db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const { lines, exitCode } = await runClientsCreate(service, {
      clientId: 'oops',
      public: true,
      redirectUri: ['com.example.app:/oauth'],
    });
    assert.equal(exitCode, 1);
    assert.match(lines.join('\n'), /http\/https/);
    assert.isUndefined(await new AdminClientsService(service).find('oops'));
  });
});
