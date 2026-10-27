import { execFileSync } from 'node:child_process';
import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { test } from '@japa/runner';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';

/**
 * `ensureAuthkitSchema` against a real Postgres (testcontainers). A host migration
 * runs inside a transaction, and in Postgres one failing statement aborts the whole
 * transaction — which SQLite cannot show. Without Docker the file skips, like the
 * client's third-party IdP suite.
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

function postgresDb(container: StartedTestContainer, searchPath?: string[]) {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          ...(searchPath ? { searchPath } : {}),
          connection: {
            host: container.getHost(),
            port: container.getMappedPort(5432),
            user: 'postgres',
            password: 'pw',
            database: 'postgres',
          },
        },
      },
    },
    new LoggerFactory().create(),
    new EmitterFactory().create(app),
  );
}

test.group('ensureAuthkitSchema | Postgres', (group) => {
  let container: StartedTestContainer;

  group.setup(async () => {
    if (!DOCKER) return;
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
  });

  group.teardown(async () => {
    if (DOCKER) await container.stop();
  });

  group.each.setup(async () => {
    if (!DOCKER) return;
    const db = postgresDb(container);
    await db.connection().rawQuery('drop schema if exists public cascade');
    await db.connection().rawQuery('create schema public');
    await db.connection().rawQuery('drop schema if exists auth cascade');
    await db.manager.closeAll();
  });

  test('inside a migration transaction, a missing account table does not abort it', async ({
    assert,
    cleanup,
  }) => {
    const db = postgresDb(container);
    cleanup(() => db.manager.closeAll());

    await db.connection().transaction(async (trx) => {
      const report = await ensureAuthkitSchema(trx, { accountTable: 'users' });
      assert.include(report.created, 'authkit_oidc_payloads');
      assert.isFalse(report.loginMethods.ensured);
      // Every statement after the check still runs: the transaction is intact.
      const rows = await trx.rawQuery('select 1 as ok');
      assert.equal(rows.rows[0].ok, 1);
    });

    const tables = await db
      .connection()
      .rawQuery("select tablename from pg_tables where schemaname = 'public'");
    assert.includeMembers(
      tables.rows.map((r: any) => r.tablename),
      ['authkit_oidc_payloads', 'auth_settings'],
    );
  })
    .skip(!DOCKER, 'Docker not available')
    .timeout(240_000);

  test('a second run inside a transaction is a no-op and keeps the transaction usable', async ({
    assert,
    cleanup,
  }) => {
    const db = postgresDb(container);
    cleanup(() => db.manager.closeAll());
    await ensureAuthkitSchema(db, { accountTable: 'users' });

    await db.connection().transaction(async (trx) => {
      const report = await ensureAuthkitSchema(trx, { accountTable: 'users' });
      assert.deepEqual(report.created, []);
      assert.deepEqual(report.altered, {});
      assert.isUndefined(report.indexed);
      await trx.rawQuery('select 1');
    });
  })
    .skip(!DOCKER, 'Docker not available')
    .timeout(240_000);

  test('tables in a search_path schema are found through the catalog', async ({
    assert,
    cleanup,
  }) => {
    const admin = postgresDb(container);
    await admin.connection().rawQuery('create schema auth');
    await admin.manager.closeAll();
    const db = postgresDb(container, ['auth']);
    cleanup(() => db.manager.closeAll());

    const first = await ensureAuthkitSchema(db, { accountTable: 'users' });
    assert.include(first.created, 'authkit_oidc_payloads');
    const second = await ensureAuthkitSchema(db, { accountTable: 'users' });
    assert.deepEqual(second.created, []);
    const placed = await db
      .connection()
      .rawQuery("select schemaname from pg_tables where tablename = 'authkit_oidc_payloads'");
    assert.deepEqual(
      placed.rows.map((r: any) => r.schemaname),
      ['auth'],
    );
  })
    .skip(!DOCKER, 'Docker not available')
    .timeout(240_000);
});
