import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import { RedisAdapter } from '../src/adapters/redis_adapter.js';
import { createTestDatabase } from './bootstrap.js';

for (const backend of ['database', 'redis'] as const) {
  test.group(`${backend} remembered session renewal`, (group) => {
    let db: ReturnType<typeof createTestDatabase>;
    let adapter: DatabaseAdapter | RedisAdapter;
    group.each.setup(async () => {
      db = createTestDatabase();
      await db.connection().schema.createTable('authkit_oidc_payloads', (t) => {
        t.string('id');
        t.string('model_name');
        t.text('payload');
        t.string('grant_id').nullable();
        t.string('user_code').nullable();
        t.string('uid').nullable();
        t.timestamp('expires_at').nullable();
        t.primary(['id', 'model_name']);
      });
      adapter =
        backend === 'database'
          ? new DatabaseAdapter('Session', db)
          : new RedisAdapter('Session', new RedisMock(), `renew:${Math.random()}`);
    });
    group.each.teardown(async () => {
      await db.manager.closeAll();
    });

    test('extends remembered payload expiry and preserves lookup by uid', async ({ assert }) => {
      const before = Math.floor(Date.now() / 1000) + 60;
      await adapter.upsert('s1', { accountId: 'u1', uid: 'uid1', exp: before }, 60);
      assert.isFunction((adapter as unknown as { renewSession?: unknown }).renewSession);
      assert.isTrue(await adapter.renewSession('s1', 3600));
      const renewed = await adapter.findByUid('uid1');
      assert.propertyVal(renewed, 'accountId', 'u1');
      assert.isAbove(Number(renewed?.exp), before);
    });

    test('never restores a deleted session', async ({ assert }) => {
      await adapter.upsert('s1', { accountId: 'u1', uid: 'uid1', exp: Date.now() / 1000 + 60 }, 60);
      await adapter.destroy('s1');
      assert.isFunction((adapter as unknown as { renewSession?: unknown }).renewSession);
      assert.isFalse(await adapter.renewSession('s1', 3600));
      assert.isUndefined(await adapter.find('s1'));
    });

    for (const payload of [{ transient: true, exp: Date.now() / 1000 + 60 }, { exp: 1 }]) {
      test(`rejects a transient or expired session: ${JSON.stringify(payload)}`, async ({
        assert,
      }) => {
        await adapter.upsert('s1', payload, 60);
        assert.isFunction((adapter as unknown as { renewSession?: unknown }).renewSession);
        assert.isFalse(await adapter.renewSession('s1', 3600));
      });
    }
  });
}
