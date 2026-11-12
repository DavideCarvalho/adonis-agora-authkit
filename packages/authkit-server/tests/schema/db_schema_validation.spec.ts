import { test } from '@japa/runner';
import { adapters } from '../../src/adapters/factory.js';
import { defineConfig } from '../../src/define_config.js';
import { LucidKeystoreVault } from '../../src/keys/keystore_vault.js';
import { ensureAuthkitSchema, ensureAuthkitTables } from '../../src/schema/ensure.js';
import {
  AuthkitSchemaError,
  authkitTable,
  validateSchemaName,
} from '../../src/schema/tables_location.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

test.group('schema.name | validation and SQLite', () => {
  test('names are validated', ({ assert }) => {
    assert.equal(validateSchemaName('auth'), 'auth');
    assert.equal(validateSchemaName('_a$1'), '_a$1');
    assert.isUndefined(validateSchemaName(undefined));
    for (const bad of ['', '1auth', 'auth.x', 'au th', '"auth"', 'a'.repeat(64), 42]) {
      assert.throws(() => validateSchemaName(bad), AuthkitSchemaError as any);
    }
  });

  test('table names are qualified only with a schema', ({ assert }) => {
    assert.equal(authkitTable({ schema: 'auth' }, 'auth_settings'), 'auth.auth_settings');
    assert.equal(authkitTable({}, 'auth_settings'), 'auth_settings');
    assert.equal(authkitTable(undefined, 'auth_settings'), 'auth_settings');
  });

  test('defineConfig rejects an invalid schema.name', ({ assert }) => {
    assert.throws(
      () =>
        defineConfig({
          issuer: 'http://localhost/oidc',
          adapter: adapters.database(),
          jwks: { source: 'managed' },
          accountStore: fakeAccountStore(),
          schema: { name: 'auth;drop' },
        } as any),
      /schema\.name must match/,
    );
  });

  test('SQLite + schema: ensure, extension tables, adapter and keystore fail with the message', async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());

    await assert.rejects(
      () => ensureAuthkitSchema(db, { schema: 'auth' }),
      /schema\.name "auth" is set, but the connection uses better-sqlite3, which has no schemas/,
    );
    await assert.rejects(
      () => ensureAuthkitTables(db, [], { schema: 'auth' }),
      /which has no schemas/,
    );
    const app: any = { container: { make: async () => db } };
    await assert.rejects(
      () => adapters.database().resolver(app, { schema: 'auth' }),
      /which has no schemas/,
    );
    const vault = new LucidKeystoreVault(async () => db.connection(), undefined, undefined, 'auth');
    await assert.rejects(() => vault.write('x'), /which has no schemas/);
    // Nothing was created anywhere.
    const tables = await db
      .connection()
      .rawQuery("select name from sqlite_master where type = 'table'");
    assert.deepEqual(tables, []);
  });

  test('SQLite + schema: resolving the config fails (the provider fails the boot with it)', async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    const provider: any = defineConfig({
      issuer: 'http://localhost/oidc',
      adapter: adapters.database(),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      schema: { name: 'auth' },
    } as any);
    const app: any = { container: { make: async () => db } };
    await assert.rejects(() => provider.resolver(app), /which has no schemas/);
  });

  test('SQLite without schema: unchanged', async ({ assert, cleanup }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    const report = await ensureAuthkitSchema(db);
    assert.include(report.created, 'auth_settings');
  });
});

test.group('schema.name | other dialects', () => {
  test('a dialect other than Postgres/MySQL is refused before any DDL', async ({ assert }) => {
    const { assertSchemaSupported, createDbSchema } = await import(
      '../../src/schema/tables_location.js'
    );
    const mssql = {
      dialect: { name: 'mssql' },
      rawQuery: async () => {
        throw new Error('must not run');
      },
    };
    assert.throws(() => assertSchemaSupported(mssql, 'auth'), /supports Postgres and MySQL/);
    await assert.rejects(() => createDbSchema(mssql, 'auth'), /supports Postgres and MySQL/);
    assert.doesNotThrow(() => assertSchemaSupported({ dialect: { name: 'postgres' } }, 'auth'));
    assert.throws(() => assertSchemaSupported({}, 'auth'), /an unknown dialect/);
    assert.doesNotThrow(() => assertSchemaSupported({ dialect: { name: 'mssql' } }, undefined));
  });
});
