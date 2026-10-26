import { test } from '@japa/runner';
import { RuntimeSettings, resolveRuntimeSettings } from '../../src/host/runtime_settings.js';
import { resolveEffectiveSessionPolicy } from '../../src/host/runtime_toggles.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

/** Counts the SQL statements that touch `auth_settings`. */
function countSettingsQueries(db: any): { queries: number } {
  const counter = { queries: 0 };
  db.connection()
    .getWriteClient()
    .on('query', (query: { sql: string }) => {
      if (query.sql.includes('auth_settings')) counter.queries++;
    });
  return counter;
}

/** One HttpContext per request, as the guards receive them. */
function requestCtx(db: any) {
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'lucid.db') return db;
        if (key === 'authkit.server') return { config: { accountStore: {} } };
        throw new Error(`unknown key: ${key}`);
      },
    },
  } as any;
}

test.group('RuntimeSettings — cache shared across requests', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    return async () => db.manager.closeAll();
  });

  test('the idle-timeout policy hits auth_settings once across many requests', async ({
    assert,
  }) => {
    await ensureAuthkitSchema(db);
    await db
      .connection()
      .table('auth_settings')
      .insert({ key: 'session_policy', value: JSON.stringify({ idleTimeoutMinutes: 30 }) });
    const counter = countSettingsQueries(db);

    for (let request = 0; request < 20; request++) {
      const settings = await resolveRuntimeSettings(requestCtx(db));
      const policy = await resolveEffectiveSessionPolicy(settings!);
      assert.equal(policy.idleTimeoutMinutes, 30);
    }

    // One table probe + one read of `session_policy`.
    assert.equal(counter.queries, 2);
  });

  test('a write through one instance is seen by the next request', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const reader = await resolveRuntimeSettings(requestCtx(db));
    assert.isNull(await reader!.getSetting('bot_protection'));

    const writer = new RuntimeSettings(db);
    await writer.setSetting('bot_protection', { enabled: true });

    const next = await resolveRuntimeSettings(requestCtx(db));
    assert.deepEqual(await next!.getSetting('bot_protection'), { enabled: true });
    assert.deepEqual(await reader!.getSetting('bot_protection'), { enabled: true });

    await writer.deleteSetting('bot_protection');
    assert.isNull(await next!.getSetting('bot_protection'));
  });

  test('a missing table is probed again after the TTL', async ({ assert }) => {
    const settings = new RuntimeSettings(db, { ttlMs: 20 });
    assert.isFalse(await settings.isTablePresent());

    await ensureAuthkitSchema(db);
    assert.isFalse(await settings.isTablePresent());
    await new Promise((r) => setTimeout(r, 30));
    assert.isTrue(await new RuntimeSettings(db, { ttlMs: 20 }).isTablePresent());
  });

  test('different databases keep separate caches', async ({ assert, cleanup }) => {
    const other = createTestDatabase();
    cleanup(() => other.manager.closeAll());
    await ensureAuthkitSchema(db);
    await ensureAuthkitSchema(other);
    await new RuntimeSettings(db).setSetting('registration', { enabled: false });

    assert.deepEqual(await new RuntimeSettings(db).getSetting('registration'), {
      enabled: false,
    });
    assert.isNull(await new RuntimeSettings(other).getSetting('registration'));
  });
});
