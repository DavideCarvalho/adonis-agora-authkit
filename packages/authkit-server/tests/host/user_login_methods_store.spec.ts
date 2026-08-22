import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { supportsLoginMethodsPreference } from '../../src/accounts/account_store.js';
import { jsonColumn } from '../../src/mixins/json_column.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { createTestDatabase } from '../bootstrap.js';

class AccountWithPref extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @column(jsonColumn<Record<string, unknown> | null>({ fallback: null }))
  declare loginMethods: Record<string, unknown> | null;
  @beforeCreate()
  static assignId(row: AccountWithPref) {
    if (!row.id) row.id = randomUUID();
  }
}

class AccountWithoutPref extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: AccountWithoutPref) {
    if (!row.id) row.id = randomUUID();
  }
}

test.group('lucidAccountStore — login methods preference', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('users', (t: any) => {
      t.string('id').primary();
      t.string('email').notNullable();
      t.string('password').notNullable();
      t.string('full_name').nullable();
      t.text('global_roles').nullable();
      t.timestamp('email_verified_at').nullable();
      t.string('email_verification_token').nullable();
      t.string('password_reset_token').nullable();
      t.timestamp('password_reset_expires_at').nullable();
      t.string('login_methods').nullable(); // JSONB no Postgres; text/JSON em sqlite
    });
    return async () => db.manager.closeAll();
  });

  test('model COM a coluna expõe a capacidade; model SEM não expõe', ({ assert }) => {
    assert.isTrue(supportsLoginMethodsPreference(lucidAccountStore(AccountWithPref)));
    assert.isFalse(supportsLoginMethodsPreference(lucidAccountStore(AccountWithoutPref)));
  });

  test('set + get round-trip da preferência', async ({ assert }) => {
    const store = lucidAccountStore(AccountWithPref) as any;
    const acc = await store.create({ email: 'pref@test.com', password: 'Xk9pQ!mZr7nL' });

    await store.setLoginMethods(acc.id, { magicLink: false, social: false });
    const pref = await store.getLoginMethods(acc.id);
    assert.deepEqual(pref, { magicLink: false, social: false });
  });

  test('conta sem preferência → null', async ({ assert }) => {
    const store = lucidAccountStore(AccountWithPref) as any;
    const acc = await store.create({ email: 'clean@test.com', password: 'Xk9pQ!mZr7nL' });
    assert.isNull(await store.getLoginMethods(acc.id));
  });

  test('objeto vazio/null remove a preferência', async ({ assert }) => {
    const store = lucidAccountStore(AccountWithPref) as any;
    const acc = await store.create({ email: 'reset@test.com', password: 'Xk9pQ!mZr7nL' });
    await store.setLoginMethods(acc.id, { passkey: false });
    await store.setLoginMethods(acc.id, {});
    assert.isNull(await store.getLoginMethods(acc.id));
    await store.setLoginMethods(acc.id, { passkey: false });
    await store.setLoginMethods(acc.id, null);
    assert.isNull(await store.getLoginMethods(acc.id));
  });

  test('conta inexistente → get null, set no-op', async ({ assert }) => {
    const store = lucidAccountStore(AccountWithPref) as any;
    assert.isNull(await store.getLoginMethods('nope'));
    await store.setLoginMethods('nope', { password: false }); // não lança
    assert.isNull(await store.getLoginMethods('nope'));
  });

  test('valor cru inválido na coluna → normalizado para null', async ({ assert }) => {
    const store = lucidAccountStore(AccountWithPref) as any;
    const acc = await store.create({ email: 'junk@test.com', password: 'Xk9pQ!mZr7nL' });
    await db.connection().from('users').where('id', acc.id).update({
      login_methods: JSON.stringify({ whatever: 'x', password: 'not-boolean' }),
    });
    assert.isNull(await store.getLoginMethods(acc.id));
  });
});
