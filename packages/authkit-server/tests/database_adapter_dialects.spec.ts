import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import { createTestDatabase } from './bootstrap.js';

/** MySQL `DATETIME`/`TIMESTAMP` literal as mysql2 serializes a `Date`. */
const MYSQL_DATETIME = /'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}'/;
const ISO_WITH_Z = /'\d{4}-\d{2}-\d{2}T[^']*Z'/;

/**
 * A mysql2 Lucid connection that never reaches a server: every statement the
 * adapter awaits is compiled by the real mysql2 knex client and recorded instead
 * of being sent.
 */
function compilingMysqlDb() {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const db = new Database(
    {
      connection: 'mysql',
      connections: {
        mysql: {
          client: 'mysql2',
          connection: { host: '127.0.0.1', port: 1, user: 'u', password: 'p', database: 'd' },
        },
      },
    },
    new LoggerFactory().create(),
    new EmitterFactory().create(app),
  );
  const client: any = db.connection('mysql');
  const sql: string[] = [];

  const wrap = (builder: any): any => {
    const proxy: any = new Proxy(builder, {
      get(target, prop) {
        if (prop === 'then') {
          return (resolve: any, reject: any) => {
            sql.push(target.toQuery());
            return Promise.resolve([]).then(resolve, reject);
          };
        }
        if (prop === 'first') {
          return async () => {
            target.limit(1);
            sql.push(target.toQuery());
            return null;
          };
        }
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  };

  const fake = {
    dialect: client.dialect,
    query: () => wrap(client.query()),
    table: (name: string) => wrap(client.insertQuery().table(name)),
  };
  return { db, fake, sql };
}

test.group('DatabaseAdapter — expires_at per dialect', () => {
  test('MySQL: expires_at is written as a DATETIME literal, not ISO-8601 with Z', async ({
    assert,
    cleanup,
  }) => {
    const { db, fake, sql } = compilingMysqlDb();
    cleanup(() => db.manager.closeAll());

    await new DatabaseAdapter('Session', fake as any).upsert('s1', { accountId: 'a1' }, 3600);

    const insert = sql.find((q) => q.startsWith('insert'));
    assert.isDefined(insert);
    assert.match(insert!, MYSQL_DATETIME);
    assert.notMatch(insert!, ISO_WITH_Z);
  });

  test('MySQL: the expiry comparisons bind DATETIME literals', async ({ assert, cleanup }) => {
    const { db, fake, sql } = compilingMysqlDb();
    cleanup(() => db.manager.closeAll());

    const sessions = new DatabaseAdapter('Session', fake as any);
    await sessions.list();
    await sessions.listByGrantIds(['g1']);

    const reads = sql.filter((q) => q.startsWith('select') && q.includes('expires_at'));
    assert.isNotEmpty(reads);
    for (const q of reads) {
      assert.match(q, MYSQL_DATETIME);
      assert.notMatch(q, ISO_WITH_Z);
    }
  });

  test('SQLite: expires_at keeps the ISO-8601 text already stored', async ({ assert, cleanup }) => {
    const db: any = createTestDatabase();
    cleanup(() => db.manager.closeAll());
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
    const legacyExpiry = new Date(Date.now() + 3600_000).toISOString();
    await db
      .connection()
      .table('authkit_oidc_payloads')
      .insert({
        id: 'old',
        model_name: 'Session',
        payload: JSON.stringify({ accountId: 'a1' }),
        expires_at: legacyExpiry,
      });

    const sessions = new DatabaseAdapter('Session', db);
    await sessions.upsert('new', { accountId: 'a1' }, 3600);

    const stored = await db.connection().from('authkit_oidc_payloads').where('id', 'new').first();
    assert.isString(stored.expires_at);
    assert.match(stored.expires_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.deepEqual(
      (await sessions.list()).map((r) => r.id),
      ['new', 'old'],
    );
  });
});
