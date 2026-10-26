import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import { AdminSessionsService } from '../src/host/admin_sessions_service.js';
import { ensureAuthkitSchema } from '../src/schema/ensure.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

const TABLE = 'authkit_oidc_payloads';

/** Shape of the table before `account_id` existed. */
async function createLegacyTable(db: any) {
  await db.connection().schema.createTable(TABLE, (t: any) => {
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

async function indexNames(db: any): Promise<string[]> {
  const rows = await db.connection().rawQuery(`PRAGMA index_list('${TABLE}')`);
  return rows.map((r: any) => r.name);
}

/** Counts the rows the database hands back for every SELECT on the payload table. */
function countRowsRead(db: any): { rows: number } {
  const counter = { rows: 0 };
  const knex = db.connection().getWriteClient();
  knex.on('query-response', (response: unknown, query: { sql: string }) => {
    if (/^select/i.test(query.sql) && query.sql.includes(TABLE) && Array.isArray(response)) {
      counter.rows += response.length;
    }
  });
  return counter;
}

class NoRevocationRow extends AdminSessionsService {
  protected async recordSubRevocation(): Promise<void> {}
}

function sessionsService(db: any) {
  const AdapterClass = class extends DatabaseAdapter {
    constructor(name: string) {
      super(name, db);
    }
  };
  return new NoRevocationRow({
    config: {
      AdapterClass,
      SessionAdapterClass: AdapterClass,
      accountStore: fakeAccountStore(),
      schema: { autoManage: true },
    },
  } as any);
}

async function seedAccount(db: any, accountId: string, sessions = 1) {
  const p = accountId;
  for (let i = 0; i < sessions; i++) {
    await new DatabaseAdapter('Session', db).upsert(
      `sess${i}-${p}`,
      { accountId, loginTs: 1700000000 + i } as any,
      3600,
    );
  }
  await new DatabaseAdapter('Grant', db).upsert(`grant-${p}`, { accountId, clientId: 'c1' }, 3600);
  for (const model of ['AccessToken', 'RefreshToken']) {
    await new DatabaseAdapter(model, db).upsert(
      `${model}-${p}`,
      { accountId, clientId: 'c1', grantId: `grant-${p}` },
      3600,
    );
  }
}

test.group('authkit_oidc_payloads — account index', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    return async () => db.manager.closeAll();
  });

  test('ensureAuthkitSchema creates account_id with the account and expiry indexes', async ({
    assert,
  }) => {
    await ensureAuthkitSchema(db);
    const names = await indexNames(db);
    assert.include(names, 'authkit_oidc_payloads_account_idx');
    assert.include(names, 'authkit_oidc_payloads_expires_idx');
    await db.connection().from(TABLE).select('account_id').limit(1);
  });

  test('ensureAuthkitSchema adds account_id and both indexes to an existing table', async ({
    assert,
  }) => {
    await createLegacyTable(db);
    const report = await ensureAuthkitSchema(db);
    assert.include(report.altered[TABLE] ?? [], 'account_id');
    const names = await indexNames(db);
    assert.include(names, 'authkit_oidc_payloads_account_idx');
    assert.include(names, 'authkit_oidc_payloads_expires_idx');
  });

  test('ensureAuthkitSchema creates the indexes when account_id was added by hand', async ({
    assert,
  }) => {
    await createLegacyTable(db);
    await db.connection().schema.alterTable(TABLE, (t: any) => {
      t.string('account_id', 255).nullable();
    });

    const report = await ensureAuthkitSchema(db);
    assert.notInclude(report.altered[TABLE] ?? [], 'account_id');
    assert.deepEqual(report.indexed?.[TABLE], [
      'authkit_oidc_payloads_account_idx',
      'authkit_oidc_payloads_expires_idx',
    ]);
    const names = await indexNames(db);
    assert.include(names, 'authkit_oidc_payloads_account_idx');
    assert.include(names, 'authkit_oidc_payloads_expires_idx');

    const second = await ensureAuthkitSchema(db);
    assert.isUndefined(second.indexed);
  });

  test('ensureAuthkitSchema leaves an index the host already built alone', async ({ assert }) => {
    await createLegacyTable(db);
    await db.connection().schema.alterTable(TABLE, (t: any) => {
      t.string('account_id', 255).nullable();
      t.index(['model_name', 'account_id'], 'authkit_oidc_payloads_account_idx');
    });

    const report = await ensureAuthkitSchema(db);
    assert.deepEqual(report.indexed?.[TABLE], ['authkit_oidc_payloads_expires_idx']);
  });

  test('the per-account query uses the account index', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const plan = await db
      .connection()
      .rawQuery(
        `EXPLAIN QUERY PLAN SELECT * FROM ${TABLE} WHERE model_name = 'Session' AND (account_id = 'a' OR account_id IS NULL)`,
      );
    assert.match(JSON.stringify(plan), /authkit_oidc_payloads_account_idx/);
  });

  test('upsert fills account_id from the payload', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    await new DatabaseAdapter('Session', db).upsert('s1', { accountId: 'acc-1' }, 60);
    await new DatabaseAdapter('Session', db).upsert('s2', { uid: 'anon' }, 60);
    const rows = await db.connection().from(TABLE).select('id', 'account_id').orderBy('id');
    assert.deepEqual(
      rows.map((r: any) => [r.id, r.account_id]),
      [
        ['s1', 'acc-1'],
        ['s2', null],
      ],
    );
  });

  test('revokeAllExcept reads only the account rows on login', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    for (let i = 0; i < 100; i++) await seedAccount(db, `other-${i}`);
    await seedAccount(db, 'acc-1', 3);

    const counter = countRowsRead(db);
    const result = await sessionsService(db).revokeAllExcept('acc-1', 'sess2-acc-1');

    assert.deepEqual(result, { sessions: 2, grants: 1, accessTokens: 1, refreshTokens: 1 });
    // 3 sessions + 1 grant + 1 AT + 1 RT for the account; the 500 rows of the
    // other accounts are never read.
    assert.isAtMost(counter.rows, 10);
  });

  test('revokeAllExcept keeps the preserved session and leaves other accounts intact', async ({
    assert,
  }) => {
    await ensureAuthkitSchema(db);
    await seedAccount(db, 'acc-1', 3);
    await seedAccount(db, 'acc-2', 2);
    const service = sessionsService(db);

    await service.revokeAllExcept('acc-1', 'sess1-acc-1');

    assert.deepEqual(
      (await service.listSessions('acc-1')).map((s) => s.id),
      ['sess1-acc-1'],
    );
    assert.deepEqual(await service.listGrants('acc-1'), []);
    assert.isUndefined(await new DatabaseAdapter('AccessToken', db).find('AccessToken-acc-1'));
    assert.isUndefined(await new DatabaseAdapter('RefreshToken', db).find('RefreshToken-acc-1'));
    assert.lengthOf(await service.listSessions('acc-2'), 2);
    assert.deepEqual(
      (await service.listGrants('acc-2')).map((g) => [g.id, g.accessTokens, g.refreshTokens]),
      [['grant-acc-2', 1, 1]],
    );
  });

  test('listByAccount skips expired rows', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const sessions = new DatabaseAdapter('Session', db);
    await sessions.upsert('live', { accountId: 'acc-1' }, 3600);
    await sessions.upsert('dead', { accountId: 'acc-1' }, 3600);
    await db
      .connection()
      .from(TABLE)
      .where('id', 'dead')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    assert.deepEqual(
      (await sessions.listByAccount('acc-1')).map((r) => r.id),
      ['live'],
    );
  });

  test('rows written without account_id are still found, then classified', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const expires = new Date(Date.now() + 3600_000).toISOString();
    await db
      .connection()
      .table(TABLE)
      .multiInsert([
        {
          id: 'legacy-1',
          model_name: 'Session',
          payload: JSON.stringify({ accountId: 'acc-1' }),
          expires_at: expires,
        },
        {
          id: 'legacy-2',
          model_name: 'Session',
          payload: JSON.stringify({ accountId: 'acc-2' }),
          expires_at: expires,
        },
      ]);
    const sessions = new DatabaseAdapter('Session', db);

    assert.deepEqual(
      (await sessions.listByAccount('acc-1')).map((r) => r.id),
      ['legacy-1'],
    );
    const rows = await db.connection().from(TABLE).select('id', 'account_id').orderBy('id');
    assert.deepEqual(
      rows.map((r: any) => [r.id, r.account_id]),
      [
        ['legacy-1', 'acc-1'],
        ['legacy-2', 'acc-2'],
      ],
    );
    assert.deepEqual(
      (await sessions.listByAccount('acc-2')).map((r) => r.id),
      ['legacy-2'],
    );
  });

  test('listByAccount works on a table without account_id', async ({ assert }) => {
    await createLegacyTable(db);
    const sessions = new DatabaseAdapter('Session', db);
    await sessions.upsert('s1', { accountId: 'acc-1' }, 3600);
    await sessions.upsert('s2', { accountId: 'acc-2' }, 3600);
    assert.deepEqual(
      (await sessions.listByAccount('acc-1')).map((r) => r.id),
      ['s1'],
    );
  });

  test('listByGrantIds returns only live tokens of the given grants', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const at = new DatabaseAdapter('AccessToken', db);
    await at.upsert('t1', { grantId: 'g1' }, 3600);
    await at.upsert('t2', { grantId: 'g2' }, 3600);
    await at.upsert('t3', { grantId: 'g1' }, 3600);
    await db
      .connection()
      .from(TABLE)
      .where('id', 't3')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(
      (await at.listByGrantIds(['g1'])).map((r) => r.id),
      ['t1'],
    );
  });

  test('expired rows are pruned', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const past = new Date(Date.now() - 1000).toISOString();
    await db
      .connection()
      .table(TABLE)
      .multiInsert(
        Array.from({ length: 20 }, (_, i) => ({
          id: `old-${i}`,
          model_name: i % 2 ? 'Session' : 'AccessToken',
          payload: '{}',
          expires_at: past,
        })),
      );

    await new DatabaseAdapter('Session', db).upsert('fresh', { accountId: 'acc-1' }, 3600);

    let remaining: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      remaining = (await db.connection().from(TABLE).select('id')).map((r: any) => r.id);
      if (remaining.length === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(remaining, ['fresh']);
  });
});
