import { test } from '@japa/runner';
import { ensureAuthkitSchema } from '../src/schema/ensure.js';
import { AppCatalogStore } from '../src/service_tenants/app_catalog.js';
import {
  APP_GRAPH_TTL_MS,
  AUTHKIT_APP_GRAPH_SLOT,
  buildAppGraph,
  cachedAppGraphReader,
  publishAppGraph,
} from '../src/service_tenants/app_graph.js';
import { createTestDatabase } from './bootstrap.js';

test.group('app graph', (group) => {
  let db: ReturnType<typeof createTestDatabase>;

  group.each.setup(async () => {
    db = createTestDatabase();
    await ensureAuthkitSchema(db, { accountTable: 'users' });
    return () => {
      delete (globalThis as Record<symbol, unknown>)[AUTHKIT_APP_GRAPH_SLOT];
      return db.manager.closeAll();
    };
  });

  test('service tenants become apps with their calls; catalogs come along', async ({ assert }) => {
    const store = new AppCatalogStore(() => db.connection());
    await store.put('entre-textos', ['media:objects:read', 'media:objects:write']);
    const graph = await buildAppGraph(
      [
        {
          clientId: 'hub-svc',
          disabled: false,
          serviceTenant: {
            partition: 'agora-hub',
            apps: { 'entre-textos': ['media:objects:write', 'media:objects:read'] },
          },
        },
        {
          clientId: 'et-svc',
          disabled: true,
          serviceTenant: { partition: 'entre-textos', environment: 'production' },
        },
        { clientId: 'web', disabled: false, serviceTenant: null },
      ],
      store,
    );
    assert.deepEqual(graph.apps, [
      {
        app: 'agora-hub',
        clientId: 'hub-svc',
        disabled: false,
        calls: { 'entre-textos': ['media:objects:read', 'media:objects:write'] },
      },
      {
        app: 'entre-textos',
        clientId: 'et-svc',
        disabled: true,
        environment: 'production',
        calls: {},
      },
    ]);
    assert.deepEqual(
      graph.catalogs.map((c) => [c.app, c.capabilities]),
      [['entre-textos', ['media:objects:read', 'media:objects:write']]],
    );
  });

  test('without a database there are no catalogs', async ({ assert }) => {
    assert.deepEqual((await buildAppGraph([], null)).catalogs, []);
  });

  test('the reader caches for the TTL and is published on the slot', async ({ assert }) => {
    let loads = 0;
    let clock = 0;
    const reader = cachedAppGraphReader(
      async () => {
        loads += 1;
        return { apps: [], catalogs: [] };
      },
      () => clock,
    );
    await Promise.all([reader.snapshot(), reader.snapshot()]);
    assert.equal(loads, 1);
    clock += APP_GRAPH_TTL_MS + 1;
    await reader.snapshot();
    assert.equal(loads, 2);
    publishAppGraph(reader);
    assert.strictEqual((globalThis as Record<symbol, unknown>)[AUTHKIT_APP_GRAPH_SLOT], reader);
  });
});
