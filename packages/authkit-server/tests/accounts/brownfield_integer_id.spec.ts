/**
 * Adoção brownfield: a tabela de usuários que o host já tinha quase sempre usa
 * `id` INTEGER auto-increment, não uuid. O `AuthAccount.id` é tipado `string` e
 * vira o claim `sub` — que a spec OIDC (RFC 7519 §4.1.2 / OIDC Core 2) exige que
 * seja string. Se o id inteiro do banco vazar como número, o `sub` sai como
 * number no JSON do token e clientes estritos rejeitam.
 */
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { createTestDatabase } from '../bootstrap.js';

class LegacyUser extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'legacy_users';
  @column({ isPrimary: true })
  declare id: number;
  @column()
  declare fullName: string | null;
}

async function setup() {
  const db = createTestDatabase();
  LegacyUser.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('legacy_users', (t) => {
    t.increments('id').primary();
    t.string('email').notNullable();
    t.string('password').nullable();
    t.text('global_roles').nullable();
    t.string('full_name').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
  return db;
}

test.group('brownfield — tabela legada com id INTEGER', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = await setup();
    return async () => await db.manager.closeAll();
  });

  test('findById devolve o id como string (o sub do token exige string)', async ({ assert }) => {
    const store = lucidAccountStore(LegacyUser);
    await LegacyUser.create({ email: 'legado@acme.com', password: 'segredo-forte-123' });

    const account = await store.findById('1');

    assert.isNotNull(account);
    assert.strictEqual(account!.id, '1');
  });

  test('verifyCredentials também devolve id string', async ({ assert }) => {
    const store = lucidAccountStore(LegacyUser);
    await LegacyUser.create({ email: 'legado@acme.com', password: 'segredo-forte-123' });

    const account = await store.verifyCredentials('legado@acme.com', 'segredo-forte-123');

    assert.isNotNull(account);
    assert.strictEqual(account!.id, '1');
  });

  test('findByEmail também devolve id string', async ({ assert }) => {
    const store = lucidAccountStore(LegacyUser);
    await LegacyUser.create({ email: 'legado@acme.com', password: 'segredo-forte-123' });

    const account = await store.findByEmail('legado@acme.com');

    assert.strictEqual(account!.id, '1');
  });
});
