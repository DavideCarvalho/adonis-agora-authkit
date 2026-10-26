import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { withPersonalAccessToken } from '../../src/mixins/with_personal_access_token.js';
import { lucidPatStore } from '../../src/pat/lucid_pat_store.js';
import { createTestDatabase } from '../bootstrap.js';

class TestPat extends compose(BaseModel, withPersonalAccessToken()) {
  static table = 'personal_access_tokens';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: TestPat) {
    if (!row.id) row.id = randomUUID();
  }
}

test.group('lucidPatStore', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('personal_access_tokens', (t: any) => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      t.string('name').notNullable();
      t.string('token_hash').notNullable();
      t.text('scopes').nullable();
      t.string('audience').nullable();
      t.timestamp('expires_at').nullable();
      t.timestamp('last_used_at').nullable();
      t.timestamp('created_at').nullable();
      t.timestamp('updated_at').nullable();
    });
    return async () => db.manager.closeAll();
  });

  test('issue retorna token cru "pat_..." e persiste só o hash', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    const { token, pat } = await store.issue({ accountId: 'u1', name: 'CI' });
    assert.isTrue(token.startsWith('pat_'));
    assert.equal(pat.name, 'CI');
    const row = await TestPat.find(pat.id);
    assert.notEqual(row!.tokenHash, token); // só o hash, nunca o token cru
  });

  test('listForAccount retorna só os tokens da conta', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    await store.issue({ accountId: 'u1', name: 'A' });
    await store.issue({ accountId: 'u2', name: 'B' });
    const list = await store.listForAccount('u1');
    assert.lengthOf(list, 1);
    assert.equal(list[0].name, 'A');
  });

  test('revoke só funciona pro dono', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    const { pat } = await store.issue({ accountId: 'u1', name: 'A' });
    assert.isFalse(await store.revoke('u2', pat.id)); // não-dono
    assert.lengthOf(await store.listForAccount('u1'), 1);
    assert.isTrue(await store.revoke('u1', pat.id)); // dono
    assert.lengthOf(await store.listForAccount('u1'), 0);
  });

  test('findActiveByToken: válido retorna metadados e atualiza lastUsed', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    const { token, pat } = await store.issue({
      accountId: 'u1',
      name: 'A',
      scopes: ['read'],
      audience: 'aud1',
    });
    const meta = await store.findActiveByToken(token);
    assert.equal(meta!.accountId, 'u1');
    assert.deepEqual(meta!.scopes, ['read']);
    assert.equal(meta!.audience, 'aud1');
    const row = await TestPat.find(pat.id);
    assert.isNotNull(row!.lastUsedAt);
  });

  test('findActiveByToken: token desconhecido → null', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    assert.isNull(await store.findActiveByToken('pat_unknown'));
  });

  test('findActiveByToken: expirado → null', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    const { token, pat } = await store.issue({ accountId: 'u1', name: 'A', expiresInDays: 1 });
    const row = await TestPat.find(pat.id);
    row!.expiresAt = DateTime.now().minus({ days: 2 });
    await row!.save();
    assert.isNull(await store.findActiveByToken(token));
  });

  test('findActiveByToken regrava lastUsedAt no máximo uma vez por minuto', async ({ assert }) => {
    const store = lucidPatStore(TestPat);
    const { token, pat } = await store.issue({ accountId: 'u1', name: 'A' });
    const updates: string[] = [];
    db.connection()
      .getWriteClient()
      .on('query', (q: { sql: string }) => {
        if (/^update/i.test(q.sql) && q.sql.includes('personal_access_tokens')) updates.push(q.sql);
      });

    for (let i = 0; i < 5; i++) assert.isNotNull(await store.findActiveByToken(token));
    assert.lengthOf(updates, 1);

    const row = await TestPat.find(pat.id);
    row!.lastUsedAt = DateTime.now().minus({ minutes: 2 });
    await row!.save();
    updates.length = 0;

    await store.findActiveByToken(token);
    assert.lengthOf(updates, 1);
    const refreshed = await TestPat.find(pat.id);
    assert.isAbove(
      refreshed!.lastUsedAt!.toMillis(),
      DateTime.now().minus({ minutes: 1 }).toMillis(),
    );
  });
});
