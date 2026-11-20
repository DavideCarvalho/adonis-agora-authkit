import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import type { DateTime } from 'luxon';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { userDto } from '../../src/host/admin_api/dto.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { createTestDatabase } from '../bootstrap.js';

class StampedAccount extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'stamped_users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;
  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
  @beforeCreate()
  static assignId(row: StampedAccount) {
    if (!row.id) row.id = randomUUID();
  }
}

test.group('account createdAt / updatedAt', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('stamped_users', (t: any) => {
      t.string('id').primary();
      t.string('email').notNullable();
      t.string('password').notNullable();
      t.string('full_name').nullable();
      t.string('avatar_url').nullable();
      t.timestamp('disabled_at').nullable();
      t.text('global_roles').nullable();
      t.timestamp('email_verified_at').nullable();
      t.timestamp('created_at').nullable();
      t.timestamp('updated_at').nullable();
    });
    return async () => db.manager.closeAll();
  });

  test('the Lucid store reads created_at / updated_at; updatedAt moves, createdAt stays', async ({
    assert,
  }) => {
    const store = lucidAccountStore(StampedAccount);
    const created = await store.create({ email: 'ts@example.com', password: 'Xk9pQ!mZr7nL' });
    assert.instanceOf(created.createdAt, Date);
    assert.instanceOf(created.updatedAt, Date);

    // Age the row so an update made now is clearly later.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    await db
      .connection()
      .from('stamped_users')
      .where('id', created.id)
      .update({ created_at: threeDaysAgo, updated_at: threeDaysAgo });
    const before = (await store.findById(created.id))!;

    await store.setGlobalRoles(created.id, ['EDITOR']);
    const after = (await store.findById(created.id))!;

    assert.equal(after.createdAt!.getTime(), before.createdAt!.getTime());
    assert.isAbove(after.updatedAt!.getTime(), before.updatedAt!.getTime());
  });

  test('the admin DTO sends ISO strings, or null when the store does not keep them', ({
    assert,
  }) => {
    const at = new Date('2026-11-20T12:00:00.000Z');
    const stamped = userDto({ id: '1', email: 'a@b.c', createdAt: at, updatedAt: at });
    assert.equal(stamped.createdAt, '2026-11-20T12:00:00.000Z');
    assert.equal(stamped.updatedAt, '2026-11-20T12:00:00.000Z');

    const bare = userDto({ id: '2', email: 'd@e.f' });
    assert.isNull(bare.createdAt);
    assert.isNull(bare.updatedAt);
  });
});
