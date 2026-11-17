import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import { createTestDatabase } from './bootstrap.js';

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

test.group('DatabaseAdapter', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('upsert + find', async ({ assert }) => {
    const a = new DatabaseAdapter('AccessToken', db);
    await a.upsert('t1', { jti: 't1', accountId: 'u1' }, 60);
    assert.deepInclude(await a.find('t1'), { jti: 't1', accountId: 'u1' });
  });

  test('consume seta consumed', async ({ assert }) => {
    const a = new DatabaseAdapter('AuthorizationCode', db);
    await a.upsert('c1', { jti: 'c1' }, 60);
    await a.consume('c1');
    assert.isOk((await a.find('c1'))!.consumed);
  });

  test('revokeByGrantId apaga por grant', async ({ assert }) => {
    const a = new DatabaseAdapter('AccessToken', db);
    await a.upsert('x', { jti: 'x', grantId: 'G' }, 60);
    await a.revokeByGrantId('G');
    assert.isUndefined(await a.find('x'));
  });

  test('find expirado devolve undefined', async ({ assert }) => {
    const a = new DatabaseAdapter('AccessToken', db);
    await a.upsert('e', { jti: 'e' }, -1); // já expirado
    assert.isUndefined(await a.find('e'));
  });
});

test.group('DatabaseAdapter.listRecent', (group) => {
  let db: any;
  let realNow: () => number;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    realNow = Date.now;
    return async () => {
      Date.now = realNow;
      await db.manager.closeAll();
    };
  });

  test('walks the live sessions once, latest expiry first, across ties', async ({ assert }) => {
    const a = new DatabaseAdapter('Session', db);
    const t0 = realNow();
    // Nine sessions written at three instants (same TTL), so most tie on expires_at.
    for (let n = 0; n < 9; n++) {
      Date.now = () => t0 + Math.floor(n / 3) * 1000;
      await a.upsert(`s${n}`, { accountId: `u${n}` }, 3600);
    }
    Date.now = realNow;
    await a.upsert('gone', { accountId: 'x' }, -1); // expired: never listed

    const seen: string[] = [];
    let after: { expiresAt: number; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const rows = await a.listRecent({ limit: 2, ...(after ? { after } : {}) });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows.at(-1)!;
      after = { expiresAt: last.expiresAt, id: last.id };
    }
    assert.deepEqual(seen, ['s8', 's7', 's6', 's5', 's4', 's3', 's2', 's1', 's0']);
  });

  test('reads only the page it was asked for', async ({ assert }) => {
    const a = new DatabaseAdapter('Session', db);
    for (let n = 0; n < 5; n++) await a.upsert(`s${n}`, { accountId: 'u' }, 3600 + n);
    const rows = await a.listRecent({ limit: 3 });
    assert.deepEqual(
      rows.map((r) => r.id),
      ['s4', 's3', 's2'],
    );
    assert.deepEqual(rows[0]!.payload, { accountId: 'u' });
  });
});
