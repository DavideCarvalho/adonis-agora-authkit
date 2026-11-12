import { configProvider } from '@adonisjs/core';
import { Kernel, Parser } from '@adonisjs/core/ace';
import { AppFactory } from '@adonisjs/core/factories/app';
import { test } from '@japa/runner';
import AuthkitClientsCreate from '../../commands/clients_create.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { AdminClientsService } from '../../src/host/admin_clients_service.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

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

test.group('authkit:clients:create --partition', (group) => {
  let db: any;
  let service: OidcService;
  let kernel: Kernel;
  let app: any;

  /** Builds the command the way ace does (parse → validate → hydrate). */
  async function create(argv: string[]) {
    await AuthkitClientsCreate.boot();
    const parsed = new Parser(AuthkitClientsCreate.getParserOptions()).parse(argv);
    AuthkitClientsCreate.validate(parsed);
    const command = new AuthkitClientsCreate(app, kernel, parsed, kernel.ui, kernel.prompt);
    command.hydrate();
    return command;
  }

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    const cfg = (await configProvider.resolve(
      { container: { make: async () => db } } as any,
      defineConfig({
        issuer: 'http://localhost:1',
        adapter: adapters.database({}),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
        serviceTenants: { resources: { 'urn:agora:durable': {} } },
      }),
    )) as ResolvedServerConfig;
    service = new OidcService(cfg, 'a'.repeat(32));
    app = new AppFactory().create(new URL('../', import.meta.url), () => {});
    await app.init();
    app.container.singleton('authkit.server' as any, async () => service);
    kernel = new Kernel(app);
    kernel.ui.switchMode('raw');
    return () => db.manager.closeAll();
  });

  test('creates a service tenant and prints its secret once', async ({ assert }) => {
    const command = await create([
      '--client-id=worker-acme',
      '--partition=acme',
      '--capability=reports',
      '--capability=billing',
    ]);
    await command.exec();
    assert.equal(command.exitCode, 0);

    const client = await new AdminClientsService(service).find('worker-acme');
    assert.deepEqual(client?.grantTypes, ['client_credentials']);
    assert.isTrue(client?.confidential);
    assert.deepEqual(client?.serviceTenant, {
      partition: 'acme',
      capabilities: ['reports', 'billing'],
    });
    const logs = kernel.ui.logger.getLogs().map((l) => l.message);
    assert.isTrue(logs.some((m) => m.includes('Service tenant created: worker-acme')));
  });

  test('refuses --partition with --redirect-uri, and --capability alone', async ({ assert }) => {
    const withRedirect = await create(['--partition=acme', '--redirect-uri=https://app/cb']);
    await withRedirect.exec();
    assert.equal(withRedirect.exitCode, 1);

    const capabilityOnly = await create(['--capability=reports']);
    await capabilityOnly.exec();
    assert.equal(capabilityOnly.exitCode, 1);
  });
});
