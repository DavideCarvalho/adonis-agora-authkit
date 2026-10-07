import { BaseModel, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import {
  lucidAccountStore,
  lucidAccountStoreAsync,
} from '../../src/accounts/lucid_account_store.js';
import { createTestDatabase } from '../bootstrap.js';

class PhoneAccount extends BaseModel {
  static table = 'phone_users';
  @column({ isPrimary: true }) declare id: string;
  @column() declare email: string;
  @column() declare phone: string | null;
  @column.dateTime() declare phoneVerifiedAt: DateTime | null;
}

test.group('Lucid verified phone identity', (group) => {
  let db: ReturnType<typeof createTestDatabase>;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('phone_users', (table) => {
      table.string('id').primary();
      table.string('email').notNullable();
      table.string('phone').nullable();
      table.timestamp('phone_verified_at').nullable();
    });
  });
  group.each.teardown(async () => {
    await db.manager.closeAll();
  });

  for (const factory of [lucidAccountStore, lucidAccountStoreAsync]) {
    test(`${factory.name} exposes only a verified phone`, async ({ assert }) => {
      await PhoneAccount.create({
        id: 'verified',
        email: '',
        phone: '5511999999999',
        phoneVerifiedAt: DateTime.now(),
      });
      const store = await factory(PhoneAccount);
      const account = await store.findById('verified');
      assert.propertyVal(account, 'phone', '5511999999999');
      assert.propertyVal(account, 'email', '');
    });

    test(`${factory.name} omits an unverified phone`, async ({ assert }) => {
      await PhoneAccount.create({
        id: 'unverified',
        email: '',
        phone: '5511999999999',
        phoneVerifiedAt: null,
      });
      const store = await factory(PhoneAccount);
      const account = await store.findById('unverified');
      assert.notProperty(account, 'phone');
    });

    test(`${factory.name} omits a missing phone even with a verification timestamp`, async ({
      assert,
    }) => {
      await PhoneAccount.create({
        id: 'missing',
        email: 'a@b.com',
        phone: null,
        phoneVerifiedAt: DateTime.now(),
      });
      const store = await factory(PhoneAccount);
      const account = await store.findById('missing');
      assert.notProperty(account, 'phone');
    });
  }
});
