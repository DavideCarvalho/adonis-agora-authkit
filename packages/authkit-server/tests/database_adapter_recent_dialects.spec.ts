import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import {
  createAuthkitSessionListIndex,
  dropAuthkitSessionListIndex,
} from '../src/schema/ensure.js';
import { createTestDatabase } from './bootstrap.js';

/**
 * `DatabaseAdapter.listRecent` and the opt-in session list index on each dialect: SQLite always,
 * Postgres / MySQL when `AUTHKIT_TEST_PG_URL` / `AUTHKIT_TEST_MYSQL_URL` name a scratch database
 * (the seek binds `expires_at`, which every dialect stores its own way).
 */
function connect(client: 'pg' | 'mysql2', url: string): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  return new Database(
    { connection: 'main', connections: { main: { client, connection: url } as any } },
    new LoggerFactory().create(),
    new EmitterFactory().create(app),
  );
}

const backends: Array<[string, () => Database]> = [['sqlite', () => createTestDatabase()]];
if (process.env.AUTHKIT_TEST_PG_URL) {
  backends.push(['postgres', () => connect('pg', process.env.AUTHKIT_TEST_PG_URL as string)]);
}
if (process.env.AUTHKIT_TEST_MYSQL_URL) {
  backends.push(['mysql', () => connect('mysql2', process.env.AUTHKIT_TEST_MYSQL_URL as string)]);
}

for (const [name, open] of backends) {
  test.group(`DatabaseAdapter.listRecent (${name})`, (group) => {
    let db: any;
    let realNow: () => number;
    group.each.setup(async () => {
      db = open();
      const schema = db.connection().schema;
      await schema.dropTableIfExists('authkit_oidc_payloads');
      await schema.createTable('authkit_oidc_payloads', (t: any) => {
        t.string('id', 255).notNullable();
        t.string('model_name', 100).notNullable();
        t.text('payload').notNullable();
        t.string('grant_id', 255).nullable();
        t.string('user_code', 255).nullable();
        t.string('uid', 255).nullable();
        t.timestamp('expires_at', { useTz: true }).nullable();
        t.string('account_id', 255).nullable();
        t.primary(['model_name', 'id']);
      });
      realNow = Date.now;
      return async () => {
        Date.now = realNow;
        await db.connection().schema.dropTableIfExists('authkit_oidc_payloads');
        await db.manager.closeAll();
      };
    });

    test('walks every live session once, latest expiry first, through the index', async ({
      assert,
    }) => {
      await createAuthkitSessionListIndex(db);
      await createAuthkitSessionListIndex(db); // already there: a no-op
      const a = new DatabaseAdapter('Session', db);
      const t0 = Math.floor(realNow() / 1000) * 1000;
      for (let n = 0; n < 7; n++) {
        Date.now = () => t0 + Math.floor(n / 3) * 1000;
        await a.upsert(`s${n}`, { accountId: `u${n}` }, 3600);
      }
      Date.now = realNow;
      await new DatabaseAdapter('Grant', db).upsert('g1', { accountId: 'u1' }, 7200);

      const seen: string[] = [];
      let after: { expiresAt: number; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const rows = await a.listRecent({ limit: 3, ...(after ? { after } : {}) });
        seen.push(...rows.map((r) => r.id));
        if (rows.length < 3) break;
        const last = rows.at(-1)!;
        after = { expiresAt: last.expiresAt, id: last.id };
      }
      assert.deepEqual(seen, ['s6', 's5', 's4', 's3', 's2', 's1', 's0']);
      await dropAuthkitSessionListIndex(db);
      await dropAuthkitSessionListIndex(db); // already gone: a no-op
    });
  });
}
