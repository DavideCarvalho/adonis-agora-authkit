import { test } from '@japa/runner';
import { listAppCatalogsHandler, publishAppCatalogHandler } from '../src/host/app_catalog.js';
import { authkitCsrfExceptions } from '../src/host/csrf.js';
import { ensureAuthkitSchema } from '../src/schema/ensure.js';
import {
  AppCatalogStore,
  authenticateCatalogPublisher,
  MAX_CATALOG_CAPABILITIES,
  validateCatalog,
} from '../src/service_tenants/app_catalog.js';
import { createTestDatabase } from './bootstrap.js';

const CLIENTS: Record<string, Record<string, unknown>> = {
  et: {
    client_id: 'et',
    client_secret: 'et-secret',
    authkit_service_tenant: { partition: 'entre-textos', capabilities: [] },
  },
  off: {
    client_id: 'off',
    client_secret: 'x',
    authkit_disabled: true,
    authkit_service_tenant: { partition: 'off', capabilities: [] },
  },
  web: { client_id: 'web', client_secret: 'x' },
};

class MemoryAdapter {
  constructor(readonly model: string) {}
  async find(id: string) {
    return this.model === 'Client' ? CLIENTS[id] : undefined;
  }
}

const creds = (clientId: string, clientSecret: string) => ({ clientId, clientSecret });
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

function fakeCtx(db: any, authorization: string | undefined, input: unknown) {
  const reply: { status?: number; body?: unknown } = {};
  const fail = (status: number) => (body: unknown) => {
    reply.status = status;
    reply.body = body;
    return reply;
  };
  return {
    reply,
    ctx: {
      containerResolver: {
        make: async (key: string) =>
          key === 'lucid.db' ? db : { config: { AdapterClass: MemoryAdapter, schema: {} } },
      },
      request: {
        header: (name: string) => (name === 'authorization' ? authorization : undefined),
        input: (name: string) => (name === 'capabilities' ? input : undefined),
      },
      response: {
        header: () => {},
        unauthorized: fail(401),
        unprocessableEntity: fail(422),
        serviceUnavailable: fail(503),
      },
    },
  };
}

test.group('app catalog', (group) => {
  let db: ReturnType<typeof createTestDatabase>;

  group.each.setup(async () => {
    db = createTestDatabase();
    await ensureAuthkitSchema(db, { accountTable: 'users' });
    return () => db.manager.closeAll();
  });

  test('authenticates an enabled service tenant as its partition', async ({ assert }) => {
    assert.equal(
      await authenticateCatalogPublisher(MemoryAdapter as any, creds('et', 'et-secret')),
      'entre-textos',
    );
    for (const [id, secret] of [
      ['et', 'wrong'],
      ['off', 'x'],
      ['web', 'x'],
      ['nobody', 'x'],
    ] as const) {
      assert.isNull(
        await authenticateCatalogPublisher(MemoryAdapter as any, creds(id, secret)),
        id,
      );
    }
    assert.isNull(await authenticateCatalogPublisher(MemoryAdapter as any, null));
  });

  test('validates, dedupes and sorts capabilities', ({ assert }) => {
    assert.deepEqual(validateCatalog(['b:x', 'a:*', 'b:x']), ['a:*', 'b:x']);
    assert.deepEqual(validateCatalog([]), []);
    assert.property(validateCatalog('a'), 'error');
    assert.property(validateCatalog(['has space']), 'error');
    assert.property(validateCatalog([1]), 'error');
    assert.property(
      validateCatalog(Array.from({ length: MAX_CATALOG_CAPABILITIES + 1 }, (_, i) => `c${i}`)),
      'error',
    );
  });

  test('stores one row per app and replaces it', async ({ assert }) => {
    const store = new AppCatalogStore(() => db.connection());
    await store.put('entre-textos', ['media:objects:read']);
    await store.put('agora-hub', ['media:avatars:read']);
    await store.put('entre-textos', ['media:objects:read', 'media:objects:write']);
    const all = await store.list();
    assert.deepEqual(
      all.map((e) => [e.app, e.capabilities]),
      [
        ['agora-hub', ['media:avatars:read']],
        ['entre-textos', ['media:objects:read', 'media:objects:write']],
      ],
    );
    assert.instanceOf(all[0]?.updatedAt, Date);
    const et = all.find((e) => e.app === 'entre-textos')!;
    assert.instanceOf(et.createdAt, Date);
    // Republishing replaces the capabilities but keeps when the app first published.
    const firstPublished = (await store.find('entre-textos'))!.createdAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const republished = await store.put('entre-textos', ['media:objects:read']);
    assert.equal(republished.createdAt?.getTime(), firstPublished);
    assert.equal((await store.find('entre-textos'))!.createdAt?.getTime(), firstPublished);
    assert.isAbove(republished.updatedAt.getTime(), firstPublished);
    assert.isTrue(await store.delete('agora-hub'));
    assert.isNull(await store.find('agora-hub'));
  });

  test('PUT publishes the caller app catalog; the console lists it', async ({ assert }) => {
    const { ctx } = fakeCtx(db, basic('et', 'et-secret'), [
      'media:objects:write',
      'media:objects:read',
    ]);
    const published = (await publishAppCatalogHandler(ctx)) as {
      app: string;
      capabilities: string[];
    };
    assert.equal(published.app, 'entre-textos');
    assert.deepEqual(published.capabilities, ['media:objects:read', 'media:objects:write']);

    const listed = (await listAppCatalogsHandler(fakeCtx(db, undefined, undefined).ctx)) as {
      apps: Array<{ app: string; capabilities: string[]; updatedAt: string }>;
    };
    assert.deepEqual(
      listed.apps.map((a) => [a.app, a.capabilities]),
      [['entre-textos', ['media:objects:read', 'media:objects:write']]],
    );
    assert.isString(listed.apps[0]?.updatedAt);
  });

  test('PUT refuses bad credentials (401) and a bad catalog (422)', async ({ assert }) => {
    const bad = fakeCtx(db, basic('et', 'nope'), ['a']);
    await publishAppCatalogHandler(bad.ctx);
    assert.equal(bad.reply.status, 401);
    const invalid = fakeCtx(db, basic('et', 'et-secret'), ['no spaces allowed']);
    await publishAppCatalogHandler(invalid.ctx);
    assert.equal(invalid.reply.status, 422);
  });

  test('the publish path is exempt from CSRF, nothing next to it', ({ assert }) => {
    assert.isTrue(authkitCsrfExceptions('/api/apps/catalog'));
    assert.isFalse(authkitCsrfExceptions('/api/apps/catalog/x'));
    assert.isFalse(authkitCsrfExceptions('/api/apps'));
    assert.isTrue(authkitCsrfExceptions('/hub/catalog', { appCatalogPath: '/hub/catalog' }));
    assert.isFalse(authkitCsrfExceptions('/api/apps/catalog', { appCatalogPath: false }));
  });
});
