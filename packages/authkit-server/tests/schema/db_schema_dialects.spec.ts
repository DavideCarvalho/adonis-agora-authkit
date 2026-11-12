import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { compose } from '@adonisjs/core/helpers';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { adapters } from '../../src/adapters/factory.js';
import { DelegationStore } from '../../src/agents/delegation_store.js';
import { AgentRegistryStore } from '../../src/agents/registry_store.js';
import { dbSchemaResults } from '../../src/doctor/db_schema_check.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';
import { LucidKeystoreVault } from '../../src/keys/keystore_vault.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { AUTHKIT_TABLE_NAMES, ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { authkitTable, bindTablesLocation } from '../../src/schema/tables_location.js';

/**
 * `schema.name` against real Postgres and MySQL (testcontainers): the connection's default
 * stays `public` / the `app` database, AuthKit's tables go to `auth`, and nothing AuthKit
 * owns may land in the default schema — a statement that ran unqualified would put it there
 * (or fail, the table not existing there). Without Docker the file skips.
 */
function dockerAvailable(): boolean {
  if (process.env.AUTHKIT_SKIP_CONTAINERS) return false;
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
const SCHEMA = 'auth';

interface Dialect {
  name: 'postgres' | 'mysql';
  start(): Promise<StartedTestContainer>;
  connection(c: StartedTestContainer): Record<string, unknown>;
  /** The default schema of the connection (where an unqualified statement would go). */
  defaultSchema: string;
  reset(db: Database): Promise<void>;
}

const dialects: Dialect[] = [
  {
    name: 'postgres',
    defaultSchema: 'public',
    start: () =>
      new GenericContainer('postgres:16-alpine')
        .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
    connection: (c) => ({
      client: 'pg',
      connection: {
        host: c.getHost(),
        port: c.getMappedPort(5432),
        user: 'postgres',
        password: 'pw',
        database: 'postgres',
      },
    }),
    async reset(db) {
      const conn = db.connection();
      await conn.rawQuery('drop schema if exists public cascade');
      await conn.rawQuery('create schema public');
      await conn.rawQuery('drop schema if exists auth cascade');
      await conn.rawQuery('drop schema if exists auth_b cascade');
    },
  },
  {
    name: 'mysql',
    defaultSchema: 'app',
    start: () =>
      new GenericContainer('mysql:8.4')
        .withEnvironment({ MYSQL_ROOT_PASSWORD: 'pw', MYSQL_DATABASE: 'app' })
        .withExposedPorts(3306)
        .withWaitStrategy(Wait.forLogMessage(/ready for connections.*port: 3306/))
        .withStartupTimeout(180_000)
        .start(),
    connection: (c) => ({
      client: 'mysql2',
      connection: {
        host: c.getHost(),
        port: c.getMappedPort(3306),
        user: 'root',
        password: 'pw',
        database: 'app',
      },
    }),
    async reset(db) {
      const conn = db.connection();
      await conn.rawQuery('drop database if exists app');
      await conn.rawQuery('create database app');
      await conn.rawQuery('drop database if exists auth');
      await conn.rawQuery('drop database if exists auth_b');
    },
  },
];

function makeDb(dialect: Dialect, container: StartedTestContainer) {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  return new Database(
    { connection: 'main', connections: { main: dialect.connection(container) as any } },
    new LoggerFactory().create(),
    new EmitterFactory().create(app),
  );
}

class AppUser extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @beforeCreate()
  static assignId(row: AppUser) {
    if (!row.id) row.id = randomUUID();
  }
}

async function createUsersTable(db: Database) {
  await db.connection().schema.createTable('users', (t: any) => {
    t.string('id', 64).primary();
    t.string('email').notNullable();
    t.string('password').notNullable();
    t.string('full_name').nullable();
    t.text('global_roles').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
}

async function tablesIn(db: Database, schema: string): Promise<string[]> {
  const result: any = await db
    .connection()
    .rawQuery('select table_name as name from information_schema.tables where table_schema = ?', [
      schema,
    ]);
  const rows = Array.isArray(result) ? result[0] : result.rows;
  return rows.map((r: any) => String(r.name ?? r.NAME ?? r.TABLE_NAME));
}

for (const dialect of dialects) {
  test.group(`schema.name | ${dialect.name}`, (group) => {
    let container: StartedTestContainer;
    let db: Database;

    group.setup(async () => {
      if (!DOCKER) return;
      container = await dialect.start();
    });

    group.teardown(async () => {
      if (DOCKER) await container.stop();
    });

    group.each.setup(async () => {
      if (!DOCKER) return;
      db = makeDb(dialect, container);
      await dialect.reset(db);
      await db.manager.closeAll();
      db = makeDb(dialect, container);
      BaseModel.useAdapter(db.modelAdapter());
      await createUsersTable(db);
    });

    group.each.teardown(async () => {
      if (DOCKER) await db.manager.closeAll();
    });

    /** Nothing AuthKit owns ended up in the connection's default schema. */
    async function assertDefaultSchemaClean(assert: any) {
      const leaked = (await tablesIn(db, dialect.defaultSchema)).filter(
        (name) => name.startsWith('auth_') || name.startsWith('authkit_'),
      );
      assert.deepEqual(leaked, []);
    }

    test('boot DDL creates the schema and every table in it; login_methods stays on the app table', async ({
      assert,
    }) => {
      const first = await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      assert.sameMembers(first.created, [...AUTHKIT_TABLE_NAMES]);
      assert.isTrue(first.loginMethods.ensured);
      assert.includeMembers(await tablesIn(db, SCHEMA), [...AUTHKIT_TABLE_NAMES]);
      await assertDefaultSchemaClean(assert);

      // Self-repair: a dropped column and a dropped index come back, in the schema.
      const payloads = authkitTable({ schema: SCHEMA }, 'authkit_oidc_payloads');
      if (dialect.name === 'postgres') {
        await db
          .connection()
          .rawQuery(`drop index "${SCHEMA}"."authkit_oidc_payloads_expires_idx"`);
      } else {
        await db
          .connection()
          .rawQuery(
            `drop index authkit_oidc_payloads_expires_idx on \`${SCHEMA}\`.authkit_oidc_payloads`,
          );
      }
      await db
        .connection()
        .schema.withSchema(SCHEMA)
        .alterTable('auth_settings', (t: any) => {
          t.dropColumn('updated_by');
        });
      const repair = await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      assert.deepEqual(repair.created, []);
      assert.deepEqual(repair.altered.auth_settings, ['updated_by']);
      assert.deepEqual(repair.indexed?.authkit_oidc_payloads, [
        'authkit_oidc_payloads_expires_idx',
      ]);
      // …and a third run is a no-op.
      const again = await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      assert.deepEqual(again.created, []);
      assert.deepEqual(again.altered, {});
      assert.isUndefined(again.indexed);
      await db.connection().from(payloads).limit(1);
      await assertDefaultSchemaClean(assert);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(300_000);

    test('inside the app transaction (a migration) the schema is created and used', async ({
      assert,
    }) => {
      await db.connection().transaction(async (trx) => {
        const report = await ensureAuthkitSchema(trx, { schema: SCHEMA, accountTable: 'users' });
        assert.include(report.created, 'auth_settings');
        await new RuntimeSettings(trx, { schema: SCHEMA }).setSetting('notifications', {
          newDevice: false,
        });
      });
      const row = await db
        .connection()
        .from(authkitTable({ schema: SCHEMA }, 'auth_settings'))
        .where('key', 'notifications')
        .first();
      assert.exists(row);
      await assertDefaultSchemaClean(assert);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(300_000);

    test('account store, settings, adapter, keystore and agent stores read and write in the schema', async ({
      assert,
    }) => {
      await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      const auth = (name: string) => authkitTable({ schema: SCHEMA }, name);

      // Account store: the account row in the app table, its MFA/history/orgs in the schema.
      const store: any = lucidAccountStore(AppUser, { encrypter: false });
      bindTablesLocation(store, { schema: SCHEMA });
      const account = await store.create({ email: 'a@b.com', password: 'Str0ng!Passw0rd#1' });
      await store.startTotpEnrollment(account.id);
      await store.recordPasswordHistory(account.id, 'old-hash');
      assert.isFalse(await store.isPasswordReused(account.id, 'x', 5, async () => false));
      const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: account.id });
      await store.addOrgMember?.(org.id, randomUUID(), 'member');
      assert.lengthOf(await store.listOrgsForAccount(account.id), 1);
      assert.isNotNull(await store.getMfaState(account.id));
      assert.exists(
        await db.connection().from(auth('auth_mfa')).where('account_id', account.id).first(),
      );
      assert.exists(
        await db
          .connection()
          .from(auth('auth_password_history'))
          .where('account_id', account.id)
          .first(),
      );
      assert.exists(
        await db.connection().from(auth('auth_organizations')).where('id', org.id).first(),
      );
      await store.deleteOrg(org.id);
      assert.notExists(
        await db.connection().from(auth('auth_organizations')).where('id', org.id).first(),
      );
      await store.disableMfa(account.id);
      assert.notExists(
        await db.connection().from(auth('auth_mfa')).where('account_id', account.id).first(),
      );

      // Runtime settings: write, read back, update, delete.
      const settings = new RuntimeSettings(db, { schema: SCHEMA });
      assert.isTrue(await settings.isTablePresent());
      await settings.setSetting('notifications', { newDevice: false });
      settings.invalidate();
      assert.deepEqual(await settings.getSetting('notifications'), { newDevice: false });
      await settings.setSetting('notifications', { newDevice: true });
      settings.invalidate();
      assert.deepEqual(await settings.getSetting('notifications'), { newDevice: true });
      await settings.deleteSetting('notifications');
      assert.lengthOf(await settings.listSettings(), 0);

      // OIDC adapter.
      const app: any = { container: { make: async () => db } };
      const Adapter = await adapters.database().resolver(app, { schema: SCHEMA });
      const sessions = new Adapter('Session');
      await sessions.upsert('s1', { accountId: account.id, grantId: 'g1' } as any, 60);
      assert.equal((await sessions.find('s1'))?.accountId, account.id);
      await sessions.revokeByGrantId('g1');
      await sessions.destroy('s1');
      assert.isUndefined(await sessions.find('s1'));

      // Keystore (creates its own table, on demand, in the schema).
      const vault = new LucidKeystoreVault(
        async () => db.connection(),
        undefined,
        undefined,
        SCHEMA,
      );
      assert.isNull(await vault.read());
      await vault.write('blob-1');
      await vault.write('blob-2');
      assert.equal(await vault.read(), 'blob-2');
      assert.isNotNull(await vault.head());
      assert.include(await tablesIn(db, SCHEMA), 'authkit_keystore');

      // Personal-agent stores.
      const conn = () => db.connection();
      const registry = new AgentRegistryStore(conn, { table: auth });
      await registry.upsert({ protocol: 'pact', identifier: 'https://agent', status: 'allowed' });
      assert.lengthOf(await registry.list(), 1);
      const delegation = new DelegationStore(conn, auth);
      const now = new Date();
      await delegation.insertGrant({
        id: 'grant-1',
        accountId: account.id,
        clientId: 'https://agent',
        agentSub: 'u1',
        scope: 'read',
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      });
      assert.lengthOf(await delegation.listGrants(account.id), 1);
      assert.equal(await delegation.revokeAllGrants(account.id, new Date()), 1);

      await assertDefaultSchemaClean(assert);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(300_000);

    test('two installs in two schemas of one database do not see each other', async ({
      assert,
    }) => {
      await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      await ensureAuthkitSchema(db, { schema: 'auth_b', accountTable: 'users' });
      const a = new RuntimeSettings(db, { schema: SCHEMA });
      const b = new RuntimeSettings(db, { schema: 'auth_b' });
      await a.setSetting('notifications', { newDevice: false });
      assert.deepEqual(await a.getSetting('notifications'), { newDevice: false });
      assert.isNull(await b.getSetting('notifications'));
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(300_000);

    test('agora:doctor: missing schema, missing tables, then ok', async ({ assert }) => {
      const config = { schema: { name: SCHEMA } };
      const run = () => dbSchemaResults(config, async () => db, 'https://docs');
      const [missing] = await run();
      assert.equal(missing.status, 'error');
      assert.include(missing.message, 'does not exist');

      await db
        .connection()
        .rawQuery(dialect.name === 'mysql' ? 'create database auth' : 'create schema auth');
      const [noTables] = await run();
      assert.equal(noTables.status, 'error');
      assert.include(noTables.message, 'auth_settings');

      await ensureAuthkitSchema(db, { schema: SCHEMA, accountTable: 'users' });
      const [ok] = await run();
      assert.equal(ok.status, 'ok');
      // The write probe rolled back.
      assert.notExists(
        await db
          .connection()
          .from(authkitTable({ schema: SCHEMA }, 'auth_settings'))
          .where('key', '__authkit_doctor_probe')
          .first(),
      );
      assert.deepEqual(await dbSchemaResults({ schema: {} }, async () => db, 'x'), []);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(300_000);
  });
}
