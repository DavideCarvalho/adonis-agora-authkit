import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import {
  adapters,
  defineConfig,
  ephemeralSigningKeyWarning,
  type ResolvedServerConfig,
} from '../../src/define_config.js';
import { checkJwks } from '../../src/doctor/checks.js';
import { generateSigningJwk } from '../../src/keys/keystore.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';
import { KeystoreManager } from '../../src/keys/keystore_manager.js';
import { LucidKeystoreVault } from '../../src/keys/keystore_vault.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

/**
 * A fake app ("one process"). `db` is the shared database: two apps over the same `db` are two
 * processes of the same deployment (web + `durable:work`).
 */
function fakeApp(db: any, options: { lucid?: boolean; inProduction?: boolean } = {}) {
  const warnings: string[] = [];
  const app = {
    inProduction: options.inProduction === true,
    makePath: (p: string) => p,
    container: {
      hasBinding: (key: string) => key === 'lucid.db' && options.lucid !== false,
      make: async (key: string) => {
        if (key === 'logger') return { warn: (message: string) => warnings.push(message) };
        if (key === 'lucid.db') return db;
        if (key === 'redis') return { connection: () => new RedisMock() };
        throw new Error(`no binding ${key}`);
      },
    },
  };
  return { app, warnings };
}

async function boot(app: any, jwks: Record<string, unknown> = {}) {
  return (await configProvider.resolve(
    app,
    defineConfig({
      issuer: 'http://localhost:1',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256', encrypt: false, ...jwks } as never,
      accountStore: fakeAccountStore(),
    }),
  )) as ResolvedServerConfig;
}

const kid = (cfg: ResolvedServerConfig) => cfg.jwks.keys[0]?.kid as string;

test.group('jwks managed without store: database default', (group) => {
  let db: any;
  group.each.setup(() => {
    db = createTestDatabase();
    return async () => db.manager.closeAll();
  });

  test('two processes over the same database sign with the same key', async ({ assert }) => {
    const web = await boot(fakeApp(db).app);
    const worker = await boot(fakeApp(db).app);
    assert.equal(kid(web), kid(worker));
    assert.deepInclude(web.jwksConfig.store as object, { driver: 'lucid' });
    // a restart keeps the key
    assert.equal(kid(await boot(fakeApp(db).app)), kid(web));
  });

  test('store: false keeps the ephemeral per-process key', async ({ assert }) => {
    const a = await boot(fakeApp(db).app, { store: false });
    const b = await boot(fakeApp(db).app, { store: false });
    assert.notEqual(kid(a), kid(b));
    assert.isUndefined(a.jwksConfig.store);
  });

  test('without Lucid the key stays ephemeral (back-compat) and production warns', async ({
    assert,
  }) => {
    const dev = fakeApp(db, { lucid: false });
    const cfg = await boot(dev.app);
    assert.isUndefined(cfg.jwksConfig.store);
    assert.lengthOf(dev.warnings, 0);

    const prod = fakeApp(db, { lucid: false, inProduction: true });
    await boot(prod.app);
    assert.isTrue(prod.warnings.some((w) => w.includes('ephemeral key')));
  });

  test('an unusable default database falls back to an ephemeral key with a warning', async ({
    assert,
  }) => {
    const down = {
      ...db,
      connection: () => {
        throw new Error('database is down');
      },
    };
    const { app, warnings } = fakeApp(down);
    const cfg = await boot(app);
    assert.isString(kid(cfg));
    assert.isUndefined(cfg.jwksConfig.store);
    assert.isTrue(warnings.some((w) => w.includes('database is down')));
  });

  test('an explicit store that fails still fails the boot', async ({ assert }) => {
    const { app } = fakeApp({
      connection: () => {
        throw new Error('database is down');
      },
    });
    await assert.rejects(() => boot(app, { store: { driver: 'lucid' } }), /database is down/);
  });

  test('concurrent first boots converge on one key', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: false });
    const vault = new LucidKeystoreVault(async () => db.connection());
    // both "processes" read an empty keystore before either writes
    const read = vault.read.bind(vault);
    let gate = 0;
    vault.read = async () => {
      const value = await read();
      if (gate++ < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      return value;
    };
    const a = new KeystoreManager(vault, codec, 'RS256');
    const b = new KeystoreManager(vault, codec, 'RS256');
    const [sa, sb] = await Promise.all([a.ensure(), b.ensure()]);
    assert.equal(sa.keys[0].kid, sb.keys[0].kid);
    assert.equal((await a.read())!.keys[0].kid, sa.keys[0].kid);
    assert.isString((await generateSigningJwk('RS256')).kid);
  });
});

test.group('doctor: managed signing keys without a shared store', () => {
  test('error in production, warn elsewhere', ({ assert }) => {
    const input = (inProduction: boolean) => ({
      authkitConfig: { jwksConfig: { source: 'managed' } },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
      inProduction,
    });
    assert.equal(checkJwks(input(true))!.level, 'error');
    assert.equal(checkJwks(input(false))!.level, 'warn');
    assert.include(checkJwks(input(true))!.message, 'durable:work');
  });

  test('boot warning only in production', ({ assert }) => {
    assert.isNull(ephemeralSigningKeyWarning({ inProduction: false }));
    assert.isString(ephemeralSigningKeyWarning({ inProduction: true }));
  });
});
