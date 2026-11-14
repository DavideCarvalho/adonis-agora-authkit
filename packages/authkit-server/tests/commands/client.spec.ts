import { configProvider } from '@adonisjs/core';
import { Kernel, Parser } from '@adonisjs/core/ace';
import { AppFactory } from '@adonisjs/core/factories/app';
import { test } from '@japa/runner';
import AuthkitClient from '../../commands/client.js';
import AuthkitKey from '../../commands/key.js';
import AuthkitPurge from '../../commands/purge.js';
import { DatabaseAdapter } from '../../src/adapters/database_adapter.js';
import type { AuditEvent } from '../../src/audit/audit_sink.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { AdminClientsService } from '../../src/host/admin_clients_service.js';
import { parseOlderThan } from '../../src/host/purge_service.js';
import { toProviderJwks } from '../../src/keys/keystore.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';
import { KeystoreManager } from '../../src/keys/keystore_manager.js';
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

/** Keystore em memória (o cofre de um `jwks.store`). */
function memoryKeystore() {
  let blob: string | null = null;
  const vault = {
    read: async () => blob,
    write: async (value: string) => {
      blob = value;
    },
  };
  return new KeystoreManager(vault as any, new KeystoreCodec({ encrypt: false }), 'RS256');
}

interface Harness {
  db: any;
  service: OidcService;
  kernel: Kernel;
  app: any;
  audit: AuditEvent[];
  /** Builds and runs a command the way ace does (parse → validate → hydrate → exec). */
  run(Command: any, argv: string[]): Promise<{ exitCode: number | undefined; logs: string[] }>;
}

async function harness(
  options: { keystore?: KeystoreManager; serviceTenants?: boolean } = {},
): Promise<Harness> {
  const db = createTestDatabase();
  await migrate(db);
  const audit: AuditEvent[] = [];
  const cfg = (await configProvider.resolve(
    { container: { make: async () => db } } as any,
    defineConfig({
      issuer: 'http://localhost:1',
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      audit: { record: async (e: AuditEvent) => void audit.push(e) },
      ...(options.serviceTenants
        ? { serviceTenants: { resources: { 'urn:agora:durable': {} } } }
        : {}),
    }),
  )) as ResolvedServerConfig;
  const keystore = options.keystore;
  const service = new OidcService(
    keystore ? { ...cfg, jwks: toProviderJwks(await keystore.ensure()) } : cfg,
    'a'.repeat(32),
    undefined,
    keystore
      ? {
          keystoreManager: async () => keystore,
          jwksLoader: async () => toProviderJwks(await keystore.ensure()),
        }
      : {},
  );
  const app: any = new AppFactory().create(new URL('../', import.meta.url), () => {});
  await app.init();
  app.container.singleton('authkit.server' as any, async () => service);
  const kernel = new Kernel(app);
  kernel.ui.switchMode('raw');
  return {
    db,
    service,
    kernel,
    app,
    audit,
    async run(Command, argv) {
      await Command.boot();
      const parsed = new Parser(Command.getParserOptions()).parse(argv);
      Command.validate(parsed);
      const command = new Command(app, kernel, parsed, kernel.ui, kernel.prompt);
      command.hydrate();
      const before = kernel.ui.logger.getLogs().length;
      await command.exec();
      return {
        exitCode: command.exitCode,
        logs: kernel.ui.logger
          .getLogs()
          .slice(before)
          .map((l) => l.message),
      };
    },
  };
}

/** The JSON a `--json` command printed (its last log line). */
function json(logs: string[]): any {
  // Raw mode prefixes each line with its level: `[ blue(info) ] …`.
  return JSON.parse(logs.at(-1)!.replace(/^\[ [^\]]*\] /, ''));
}

/** A client that registered itself through `/reg`, `days` ago. */
async function seedDynamicClient(db: any, clientId: string, days: number) {
  await new DatabaseAdapter('Client', db).upsert(
    clientId,
    {
      client_id: clientId,
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      client_id_issued_at: Math.floor(Date.now() / 1000) - days * 86_400,
    },
    0,
  );
}

async function seedGrant(db: any, grantId: string, clientId: string) {
  await new DatabaseAdapter('Grant', db).upsert(
    grantId,
    { jti: grantId, kind: 'Grant', clientId, accountId: 'u1' },
    3600,
  );
  await new DatabaseAdapter('AccessToken', db).upsert(
    `at-${grantId}`,
    { jti: `at-${grantId}`, kind: 'AccessToken', grantId, clientId, accountId: 'u1' },
    3600,
  );
}

test.group('authkit:client', (group) => {
  group.each.timeout(15_000);
  let h: Harness;
  group.each.setup(async () => {
    h = await harness({ serviceTenants: true });
    return () => h.db.manager.closeAll();
  });

  test('create: a confidential client prints its secret once and is audited', async ({
    assert,
  }) => {
    const { exitCode, logs } = await h.run(AuthkitClient, [
      'create',
      '--client-id=my-api',
      '--name=My API',
      '--redirect-uri=https://api.example.com/cb',
      '--scope=openid',
      '--scope=email',
    ]);
    assert.equal(exitCode, 0);
    assert.isTrue(logs.some((m) => m.includes('CLIENT SECRET')));
    const client = await new AdminClientsService(h.service).find('my-api');
    assert.isTrue(client?.confidential);
    assert.equal(client?.clientName, 'My API');
    assert.equal(client?.scope, 'openid email');
    assert.equal(h.audit.at(-1)?.type, 'client.created');
    assert.match(h.audit.at(-1)!.actorId!, /^cli/);
  });

  test('create --public --json: no secret; refusals exit 1', async ({ assert }) => {
    const created = await h.run(AuthkitClient, [
      'create',
      '--client-id=my-spa',
      '--redirect-uri=https://app.example.com/cb',
      '--public',
      '--json',
    ]);
    assert.equal(created.exitCode, 0);
    assert.isNull(json(created.logs).clientSecret);
    assert.isFalse(json(created.logs).confidential);

    assert.equal((await h.run(AuthkitClient, ['create', '--client-id=x'])).exitCode, 1);
    assert.equal(
      (
        await h.run(AuthkitClient, [
          'create',
          '--redirect-uri=https://a/cb',
          '--public',
          '--client-secret=s',
        ])
      ).exitCode,
      1,
    );
    assert.equal((await h.run(AuthkitClient, ['frobnicate'])).exitCode, 1);
    assert.equal((await h.run(AuthkitClient, ['show'])).exitCode, 1);
  });

  test('create a service tenant; refuses --partition with --redirect-uri, and --capability alone', async ({
    assert,
  }) => {
    const { exitCode, logs } = await h.run(AuthkitClient, [
      'create',
      '--client-id=worker-acme',
      '--partition=acme',
      '--capability=reports',
      '--capability=billing',
    ]);
    assert.equal(exitCode, 0);
    const client = await new AdminClientsService(h.service).find('worker-acme');
    assert.deepEqual(client?.grantTypes, ['client_credentials']);
    assert.deepEqual(client?.serviceTenant, {
      partition: 'acme',
      capabilities: ['reports', 'billing'],
    });
    assert.isTrue(logs.some((m) => m.includes('Service tenant created: worker-acme')));

    const withRedirect = await h.run(AuthkitClient, [
      'create',
      '--partition=acme',
      '--redirect-uri=https://app/cb',
    ]);
    assert.equal(withRedirect.exitCode, 1);
    assert.equal((await h.run(AuthkitClient, ['create', '--capability=reports'])).exitCode, 1);
  });

  test('list --json, list --mcp (dynamic + metadata-document clients with grants)', async ({
    assert,
  }) => {
    await h.run(AuthkitClient, ['create', '--client-id=manual', '--redirect-uri=https://a/cb']);
    await seedDynamicClient(h.db, 'dcr-1', 1);
    await seedGrant(h.db, 'g-cimd', 'https://claude.ai/oauth/claude-code-client-metadata');

    const all = json((await h.run(AuthkitClient, ['list', '--json'])).logs);
    assert.sameMembers(
      all.map((c: any) => c.clientId),
      ['manual', 'dcr-1'],
    );
    const mcp = json((await h.run(AuthkitClient, ['list', '--mcp', '--json'])).logs);
    assert.deepEqual(
      mcp.map((c: any) => [c.clientId, c.kind]),
      [
        ['dcr-1', 'dynamic'],
        ['https://claude.ai/oauth/claude-code-client-metadata', 'metadata-document'],
      ],
    );
    const table = await h.run(AuthkitClient, ['list']);
    assert.equal(table.exitCode, 0);
  });

  test('show and update', async ({ assert }) => {
    await h.run(AuthkitClient, ['create', '--client-id=app', '--redirect-uri=https://a/cb']);
    const shown = json((await h.run(AuthkitClient, ['show', 'app', '--json'])).logs);
    assert.equal(shown.clientId, 'app');
    assert.equal((await h.run(AuthkitClient, ['show', 'nope'])).exitCode, 1);

    const updated = await h.run(AuthkitClient, [
      'update',
      'app',
      '--name=Renamed',
      '--redirect-uri=https://a/cb2',
      '--json',
    ]);
    assert.equal(updated.exitCode, 0);
    assert.equal(json(updated.logs).clientName, 'Renamed');
    assert.deepEqual(json(updated.logs).redirectUris, ['https://a/cb2']);
    assert.isTrue(json(updated.logs).confidential, 'unchanged fields are kept');
    assert.equal((await h.run(AuthkitClient, ['update', 'app'])).exitCode, 1, 'nothing to update');
  });

  test('update keeps a dynamically registered client dynamic', async ({ assert }) => {
    await seedDynamicClient(h.db, 'dcr-1', 1);
    await h.run(AuthkitClient, ['update', 'dcr-1', '--name=Renamed']);
    const client = await new AdminClientsService(h.service).find('dcr-1');
    assert.isTrue(client?.dynamicallyRegistered);
    assert.equal(client?.clientName, 'Renamed');
  });

  test('rotate-secret: refuses without --force (non-interactive), prints the new one once', async ({
    assert,
  }) => {
    await h.run(AuthkitClient, [
      'create',
      '--client-id=app',
      '--redirect-uri=https://a/cb',
      '--json',
    ]);
    const svc = new AdminClientsService(h.service);
    h.kernel.prompt.trap('Rotate the secret of app? The current one stops working.').reject();
    const refused = await h.run(AuthkitClient, ['rotate-secret', 'app']);
    assert.equal(refused.exitCode, 1);

    const rotated = await h.run(AuthkitClient, ['rotate-secret', 'app', '--force', '--json']);
    assert.equal(rotated.exitCode, 0);
    assert.isString(json(rotated.logs).clientSecret);
    assert.isTrue((await svc.find('app'))?.confidential);
    assert.equal(h.audit.at(-1)?.type, 'client.secret_regenerated');

    await h.run(AuthkitClient, [
      'create',
      '--client-id=spa',
      '--redirect-uri=https://a/cb',
      '--public',
    ]);
    assert.equal((await h.run(AuthkitClient, ['rotate-secret', 'spa', '--force'])).exitCode, 1);
  });

  test('revoke: disables the client and cuts its grants and tokens', async ({ assert }) => {
    await seedDynamicClient(h.db, 'dcr-1', 1);
    await seedGrant(h.db, 'g1', 'dcr-1');
    const { exitCode, logs } = await h.run(AuthkitClient, ['revoke', 'dcr-1', '--force', '--json']);
    assert.equal(exitCode, 0);
    const result = json(logs);
    assert.isTrue(result.stored);
    assert.equal(result.grants, 1);
    assert.equal(result.accessTokens, 1);
    assert.isTrue((await new AdminClientsService(h.service).find('dcr-1'))?.disabled);
    assert.isUndefined(await new DatabaseAdapter('Grant', h.db).find('g1'));
    assert.equal(h.audit.at(-1)?.type, 'client.revoked');
  });

  test('delete', async ({ assert }) => {
    await h.run(AuthkitClient, ['create', '--client-id=app', '--redirect-uri=https://a/cb']);
    assert.equal((await h.run(AuthkitClient, ['delete', 'app', '--force'])).exitCode, 0);
    assert.isUndefined(await new AdminClientsService(h.service).find('app'));
    assert.equal(h.audit.at(-1)?.type, 'client.deleted');
    assert.equal((await h.run(AuthkitClient, ['delete', 'app', '--force'])).exitCode, 1);
  });
});

test.group('authkit:key', (group) => {
  // Generates RSA/EC keys and rebuilds the provider on every change.
  group.each.timeout(30_000);
  test('list, generate (staged), rotate promotes it, retire an old key', async ({
    assert,
    cleanup,
  }) => {
    const keystore = memoryKeystore();
    const h = await harness({ keystore });
    cleanup(() => h.db.manager.closeAll());

    const listed = json((await h.run(AuthkitKey, ['list', '--json'])).logs);
    assert.equal(listed.source, 'managed (persisted store)');
    assert.lengthOf(listed.keys, 1);
    const first = listed.keys[0].kid;
    assert.equal(listed.keys[0].status, 'active');

    const generated = json((await h.run(AuthkitKey, ['generate', '--alg=ES256', '--json'])).logs);
    const staged = generated.kid;
    let keys = json((await h.run(AuthkitKey, ['list', '--json'])).logs).keys;
    assert.deepEqual(
      keys.map((k: any) => [k.kid, k.status]),
      [
        [first, 'active'],
        [staged, 'staged'],
      ],
    );
    assert.notInclude(
      JSON.stringify(h.service.publicJwks),
      '"staged"',
      'internal markers never reach the JWKS',
    );
    assert.include(
      h.service.publicJwks.keys.map((k) => k.kid),
      staged,
      'the staged key is published',
    );

    const plan = json((await h.run(AuthkitKey, ['rotate', '--dry-run', '--json'])).logs);
    assert.deepEqual(plan.keptKids, [staged, first]);
    assert.equal(json((await h.run(AuthkitKey, ['list', '--json'])).logs).keys[0].kid, first);

    const rotated = json((await h.run(AuthkitKey, ['rotate', '--json'])).logs);
    assert.equal(rotated.newKid, staged);
    keys = json((await h.run(AuthkitKey, ['list', '--json'])).logs).keys;
    assert.deepEqual(
      keys.map((k: any) => [k.kid, k.status]),
      [
        [staged, 'active'],
        [first, 'verification'],
      ],
    );

    assert.equal((await h.run(AuthkitKey, ['retire', staged, '--force'])).exitCode, 1, 'active');
    assert.equal((await h.run(AuthkitKey, ['retire', 'nope', '--force'])).exitCode, 1);
    assert.equal((await h.run(AuthkitKey, ['retire', first, '--force'])).exitCode, 0);
    keys = json((await h.run(AuthkitKey, ['list', '--json'])).logs).keys;
    assert.deepEqual(
      keys.map((k: any) => k.kid),
      [staged],
    );
    assert.includeMembers(
      h.audit.map((e) => e.type),
      ['keys.generated', 'keys.rotated', 'keys.retired'],
    );
    assert.isTrue(
      h.audit.filter((e) => e.type.startsWith('keys.')).every((e) => /^cli/.test(e.actorId!)),
    );
  });

  test('ephemeral keystore: list says so, changes are refused', async ({ assert, cleanup }) => {
    const h = await harness();
    cleanup(() => h.db.manager.closeAll());
    const listed = json((await h.run(AuthkitKey, ['list', '--json'])).logs);
    assert.match(listed.source, /ephemeral/);
    assert.lengthOf(listed.keys, 1);
    const generated = await h.run(AuthkitKey, ['generate']);
    assert.equal(generated.exitCode, 1);
    assert.isTrue(generated.logs.some((m) => m.includes('ephemeral')));
    assert.equal((await h.run(AuthkitKey, ['rotate'])).exitCode, 1);
  });
});

test.group('authkit:purge', (group) => {
  group.each.timeout(15_000);
  let h: Harness;
  group.each.setup(async () => {
    h = await harness();
    return () => h.db.manager.closeAll();
  });

  async function seed() {
    const at = new DatabaseAdapter('AccessToken', h.db);
    await at.upsert('live', { jti: 'live', kind: 'AccessToken' }, 3600);
    await at.upsert('old', { jti: 'old', kind: 'AccessToken' }, 3600);
    await h.db
      .from('authkit_oidc_payloads')
      .where('id', 'old')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() });
    const codes = new DatabaseAdapter('AuthorizationCode', h.db);
    await codes.upsert('used', { jti: 'used', kind: 'AuthorizationCode' }, 600);
    await codes.consume('used');
    await seedDynamicClient(h.db, 'stale', 90);
    await seedDynamicClient(h.db, 'stale-in-use', 90);
    await seedGrant(h.db, 'g1', 'stale-in-use');
    await seedDynamicClient(h.db, 'recent', 1);
  }

  test('--dry-run counts and deletes nothing', async ({ assert }) => {
    await seed();
    const { exitCode, logs } = await h.run(AuthkitPurge, ['--dry-run', '--json']);
    assert.equal(exitCode, 0);
    const report = json(logs);
    assert.isTrue(report.dryRun);
    assert.equal(report.expired.tokens, 1);
    assert.equal(report.consumed.tokens, 1);
    assert.deepEqual(report.clients, ['stale']);
    assert.isOk(await new AdminClientsService(h.service).find('stale'));
    assert.isFalse(h.audit.some((e) => e.type === 'oidc.purged'));
  });

  test('deletes expired/consumed artifacts and unused dynamic clients, never live ones', async ({
    assert,
  }) => {
    await seed();
    const { logs } = await h.run(AuthkitPurge, ['--json']);
    const report = json(logs);
    assert.equal(report.total, 3);
    const svc = new AdminClientsService(h.service);
    assert.isUndefined(await svc.find('stale'));
    assert.isOk(await svc.find('stale-in-use'));
    assert.isOk(await svc.find('recent'));
    assert.isOk(await new DatabaseAdapter('AccessToken', h.db).find('live'));
    const rows = await h.db.from('authkit_oidc_payloads').whereIn('id', ['old', 'used']);
    assert.lengthOf(rows, 0);
    assert.equal(h.audit.at(-1)?.type, 'oidc.purged');
  });

  test('per-kind flags and --older-than', async ({ assert }) => {
    await seed();
    const onlyTokens = json((await h.run(AuthkitPurge, ['--tokens', '--dry-run', '--json'])).logs);
    assert.deepEqual(onlyTokens.clients, []);
    assert.equal(onlyTokens.expired.tokens, 1);
    const longAgo = json(
      (await h.run(AuthkitPurge, ['--clients', '--older-than=120d', '--dry-run', '--json'])).logs,
    );
    assert.deepEqual(longAgo.clients, []);
    assert.equal((await h.run(AuthkitPurge, ['--older-than=soon'])).exitCode, 1);
    assert.equal(parseOlderThan('2w'), 14);
    assert.equal(parseOlderThan('12h'), 0.5);
  });
});
