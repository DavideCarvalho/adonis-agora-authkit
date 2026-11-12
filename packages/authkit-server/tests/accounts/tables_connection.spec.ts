import { randomUUID } from 'node:crypto';
import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { compose } from '@adonisjs/core/helpers';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { adapters } from '../../src/adapters/factory.js';
import { defineConfig } from '../../src/define_config.js';
import { RuntimeSettings, resolveRuntimeSettings } from '../../src/host/runtime_settings.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { bindTablesLocation } from '../../src/schema/tables_location.js';

/**
 * Three in-memory SQLite connections, each its own database: `primary` (the default),
 * `users_db` (the account model's connection) and `auth` (`schema.connection`). A row
 * landing on the wrong connection is a row the other connections cannot see.
 */
function threeConnections() {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const sqlite = {
    client: 'better-sqlite3' as const,
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  };
  return new Database(
    {
      connection: 'primary',
      connections: { primary: sqlite, users_db: sqlite, auth: sqlite },
    },
    new LoggerFactory().create(),
    new EmitterFactory().create(app),
  );
}

class UsersDbAccount extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static connection = 'users_db';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @beforeCreate()
  static assignId(row: UsersDbAccount) {
    if (!row.id) row.id = randomUUID();
  }
}

async function createUsersTable(db: Database) {
  await db.connection('users_db').schema.createTable('users', (t: any) => {
    t.string('id').primary();
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

async function tablesOn(db: Database, connection: string): Promise<string[]> {
  const rows = await db
    .connection(connection)
    .rawQuery("select name from sqlite_master where type = 'table'");
  return rows.map((r: any) => r.name);
}

test.group('AuthKit tables | one connection (schema.connection)', (group) => {
  let db: Database;

  group.each.setup(async () => {
    db = threeConnections();
    BaseModel.useAdapter(db.modelAdapter());
    await createUsersTable(db);
    await ensureAuthkitSchema(db, {
      connection: 'auth',
      accountTable: 'users',
      accountConnection: 'users_db',
    });
    return () => db.manager.closeAll();
  });

  test('ensureAuthkitSchema puts the lib tables on `connection` and login_methods on the account connection', async ({
    assert,
  }) => {
    const auth = await tablesOn(db, 'auth');
    assert.includeMembers(auth, [
      'auth_settings',
      'auth_mfa',
      'auth_password_history',
      'auth_organizations',
      'authkit_oidc_payloads',
    ]);
    assert.notInclude(auth, 'users');
    assert.notInclude(await tablesOn(db, 'primary'), 'auth_settings');
    const columns = await db
      .connection('users_db')
      .rawQuery("select name from pragma_table_info('users')");
    assert.include(
      columns.map((c: any) => c.name),
      'login_methods',
    );
  });

  test('a bound store reads and writes auth_mfa, auth_password_history and the org tables on schema.connection', async ({
    assert,
  }) => {
    const store: any = lucidAccountStore(UsersDbAccount, { encrypter: false });
    bindTablesLocation(store, { connection: 'auth' });
    const account = await store.create({ email: 'a@b.com', password: 'Str0ng!Passw0rd#1' });

    await store.startTotpEnrollment(account.id);
    await store.recordPasswordHistory(account.id, 'old-hash');
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: account.id });

    const auth = db.connection('auth');
    assert.exists(await auth.from('auth_mfa').where('account_id', account.id).first());
    assert.exists(await auth.from('auth_password_history').where('account_id', account.id).first());
    assert.exists(await auth.from('auth_organizations').where('id', org.id).first());
    assert.exists(
      await auth.from('auth_organization_members').where('account_id', account.id).first(),
    );
    // …and read back through the store.
    assert.isNotNull(await store.getMfaState(account.id));
    assert.lengthOf(await store.listOrgsForAccount(account.id), 1);
    // The account row stays on the model's connection.
    assert.exists(await db.connection('users_db').from('users').where('id', account.id).first());
  });

  test('defineConfig binds the store to schema.connection', async ({ assert }) => {
    const store: any = lucidAccountStore(UsersDbAccount, { encrypter: false });
    defineConfig({
      issuer: 'http://localhost/oidc',
      adapter: adapters.database(),
      jwks: { source: 'managed' },
      accountStore: store,
      schema: { connection: 'auth' },
    } as any);
    const account = await store.create({ email: 'c@d.com', password: 'Str0ng!Passw0rd#1' });
    await store.startTotpEnrollment(account.id);
    assert.exists(
      await db.connection('auth').from('auth_mfa').where('account_id', account.id).first(),
    );
  });

  test('without schema.connection the lib tables go to the primary connection, not the model connection', async ({
    assert,
  }) => {
    await ensureAuthkitSchema(db, { accountTable: 'users', accountConnection: 'users_db' });
    const store: any = lucidAccountStore(UsersDbAccount, { encrypter: false });
    bindTablesLocation(store, { connection: undefined });
    const account = await store.create({ email: 'e@f.com', password: 'Str0ng!Passw0rd#1' });
    await store.startTotpEnrollment(account.id);
    await store.createOrg({ name: 'Beta', slug: 'beta', ownerAccountId: account.id });
    const primary = db.connection('primary');
    assert.exists(await primary.from('auth_mfa').where('account_id', account.id).first());
    assert.exists(await primary.from('auth_organizations').where('slug', 'beta').first());
    assert.notInclude(await tablesOn(db, 'users_db'), 'auth_mfa');
  });

  test('runtime settings resolve on schema.connection, not the account model connection', async ({
    assert,
  }) => {
    const store = lucidAccountStore(UsersDbAccount, { encrypter: false });
    const service = { config: { accountStore: store, schema: { connection: 'auth' } } };
    const ctx: any = {
      containerResolver: {
        make: async (binding: string) => (binding === 'lucid.db' ? db : service),
      },
    };
    const settings = (await resolveRuntimeSettings(ctx)) as RuntimeSettings;
    await settings.setSetting('notifications', { newDevice: false });
    assert.exists(
      await db.connection('auth').from('auth_settings').where('key', 'notifications').first(),
    );
  });

  test('adapters.database() without a connection uses schema.connection', async ({ assert }) => {
    const app: any = { container: { make: async () => db } };
    const Adapter = await adapters.database().resolver(app, { connection: 'auth' });
    await new Adapter('Session').upsert('s1', { accountId: 'a1' } as any, 60);
    assert.exists(
      await db.connection('auth').from('authkit_oidc_payloads').where('id', 's1').first(),
    );

    const Pinned = await adapters.database({ connection: 'primary' }).resolver(app, {
      connection: 'auth',
    });
    await ensureAuthkitSchema(db, { accountTable: 'users', accountConnection: 'users_db' });
    await new Pinned('Session').upsert('s2', { accountId: 'a1' } as any, 60);
    assert.exists(
      await db.connection('primary').from('authkit_oidc_payloads').where('id', 's2').first(),
    );
  });
});
