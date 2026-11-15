import { configProvider } from '@adonisjs/core';
import { Kernel, Parser } from '@adonisjs/core/ace';
import { AppFactory } from '@adonisjs/core/factories/app';
import { test } from '@japa/runner';
import AuthkitCryptoReseal from '../../commands/crypto_reseal.js';
import AuthkitKey from '../../commands/key.js';
import AuthkitSettingsUnset from '../../commands/settings_unset.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import ApiKeysController from '../../src/host/admin_api/api_keys_controller.js';
import ApiSettingsController from '../../src/host/admin_api/api_settings_controller.js';
import ConsoleKeysController from '../../src/host/admin_console/console_keys_controller.js';
import {
  deriveReadOnlySettingKeys,
  readOnlySettingKeys,
  resetLockedSettingKeys,
  SettingLockedError,
  SettingReadOnlyError,
  setLockedSettingKeys,
  setReadOnlySettingKeys,
} from '../../src/host/config_locks.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';
import { SETTING_KEYS } from '../../src/host/runtime_toggles.js';
import {
  generateSigningJwk,
  type PersistedKeystore,
  toProviderJwks,
} from '../../src/keys/keystore.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';
import { KeystoreManager } from '../../src/keys/keystore_manager.js';
import {
  KeystoreReadOnlyError,
  KeystoreUnavailableError,
} from '../../src/keys/keystore_read_only.js';
import { LucidKeystoreVault } from '../../src/keys/keystore_vault.js';
import { keyRotationSchedulerApplies } from '../../src/provider/key_rotation_scheduler.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

/** In-memory vault that counts writes. */
function memoryVault(initial: string | null = null) {
  let blob = initial;
  let writes = 0;
  return {
    read: async () => blob,
    write: async (value: string) => {
      writes++;
      blob = value;
    },
    head: async () => blob,
    writes: () => writes,
    blob: () => blob,
  };
}

const plain = () => new KeystoreCodec({ encrypt: false });

async function seededVault() {
  const store: PersistedKeystore = { keys: [await generateSigningJwk('RS256')] };
  return { store, vault: memoryVault(await plain().encode(store)) };
}

/** A read-only OidcService over an existing keystore (no DB). */
async function readOnlyService() {
  const { store, vault } = await seededVault();
  const manager = new KeystoreManager(vault, plain(), 'RS256', { readOnly: true });
  const cfg = (await configProvider.resolve(
    { container: { make: async () => createTestDatabase() } } as any,
    defineConfig({
      issuer: 'http://localhost:1',
      adapter: adapters.database({}),
      jwks: {
        source: 'managed',
        algorithm: 'RS256',
        store: vault as never,
        encrypt: false,
        readOnly: true,
      },
      accountStore: fakeAccountStore(),
    }),
  )) as ResolvedServerConfig;
  const service = new OidcService(cfg, 'a'.repeat(32), undefined, {
    jwksLoader: async () => toProviderJwks(await manager.readRequired()),
    keystoreHead: () => manager.head(),
    keystoreManager: async () => manager,
  });
  return { service, manager, vault, store };
}

function fakeCtx(service: any, body: any = {}) {
  let status = 200;
  let sent: any;
  const ctx = {
    request: { body: () => body, ip: () => '127.0.0.1', header: () => undefined },
    response: {
      status: (s: number) => {
        status = s;
        return {
          send: (b: any) => {
            sent = b;
            return b;
          },
        };
      },
    },
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        throw new Error(`no binding for ${key}`);
      },
    },
  } as any;
  return { ctx, status: () => status, body: () => sent };
}

test.group('jwks.readOnly | KeystoreManager', () => {
  test('rotate, generate, retire and reseal throw without writing', async ({ assert }) => {
    const { vault, store } = await seededVault();
    const m = new KeystoreManager(vault, plain(), 'RS256', { readOnly: true });
    await assert.rejects(() => m.rotate(), KeystoreReadOnlyError);
    await assert.rejects(() => m.generate(), KeystoreReadOnlyError);
    await assert.rejects(() => m.retire(store.keys[0]!.kid as string), KeystoreReadOnlyError);
    await assert.rejects(() => m.reseal({ all: true }), KeystoreReadOnlyError);
    assert.equal(vault.writes(), 0);
    assert.deepEqual(await m.readRequired(), store);
  });

  test('ensure() and readRequired() never create a missing keystore', async ({ assert }) => {
    const vault = memoryVault();
    const m = new KeystoreManager(vault, plain(), 'RS256', { readOnly: true });
    const error = await m.ensure().catch((e) => e);
    assert.instanceOf(error, KeystoreUnavailableError);
    assert.equal(error.code, 'E_KEYSTORE_UNAVAILABLE');
    assert.equal(error.reason, 'missing');
    assert.equal(vault.writes(), 0);
  });

  test('a blob that does not decode is "unreadable"', async ({ assert }) => {
    const m = new KeystoreManager(memoryVault('not json'), plain(), 'RS256', { readOnly: true });
    const error = await m.readRequired().catch((e) => e);
    assert.instanceOf(error, KeystoreUnavailableError);
    assert.equal(error.reason, 'unreadable');
  });

  test('a writer manager still creates the keystore', async ({ assert }) => {
    const vault = memoryVault();
    await new KeystoreManager(vault, plain(), 'RS256').ensure();
    assert.equal(vault.writes(), 1);
  });
});

test.group('jwks.readOnly | boot (defineConfig resolve)', () => {
  async function resolve(db: any, readOnly: boolean) {
    return configProvider.resolve(
      { container: { make: async () => db } } as any,
      defineConfig({
        issuer: 'http://localhost:1',
        adapter: adapters.database({}),
        jwks: {
          source: 'managed',
          algorithm: 'RS256',
          store: { driver: 'lucid', table: 'authkit_keystore' },
          encrypt: false,
          readOnly,
        },
        accountStore: fakeAccountStore(),
      }),
    ) as Promise<ResolvedServerConfig>;
  }

  test('missing row: boot fails with a clear error, no key and no DDL', async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    const error = await resolve(db, true).catch((e) => e);
    assert.instanceOf(error, KeystoreUnavailableError);
    assert.equal(error.reason, 'missing');
    assert.match(error.message, /never creates keys/);
    assert.isFalse(await db.connection().schema.hasTable('authkit_keystore'));
  });

  test('table present, row missing: still fails and writes nothing', async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    await db.connection().schema.createTable('authkit_keystore', (t) => {
      t.string('key').primary();
      t.text('blob').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
    await assert.rejects(() => resolve(db, true), KeystoreUnavailableError);
    assert.lengthOf(await db.connection().from('authkit_keystore'), 0);
  });

  test("the writer's row: boot reads it and signs with the same keys", async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    const writer = await resolve(db, false);
    const reader = await resolve(db, true);
    assert.deepEqual(
      reader.jwks.keys.map((k) => k.kid),
      writer.jwks.keys.map((k) => k.kid),
    );
    const vault = new LucidKeystoreVault(async () => db.connection());
    assert.isString(await vault.read());
  });

  test('readOnly needs a managed store', async ({ assert }) => {
    const resolveWith = (jwks: any) =>
      configProvider.resolve(
        { container: { make: async () => createTestDatabase() } } as any,
        defineConfig({
          issuer: 'http://localhost:1',
          adapter: adapters.database({}),
          jwks,
          accountStore: fakeAccountStore(),
        }),
      );
    await assert.rejects(
      () => resolveWith({ source: 'managed', readOnly: true }),
      /jwks\.readOnly/,
    );
    await assert.rejects(
      () => resolveWith({ source: 'jwks', keys: [], readOnly: true }),
      /jwks\.readOnly/,
    );
  });
});

test.group('jwks.readOnly | OidcService', () => {
  test('rotateKeys, generateKey, retireKey and a reseal throw the typed error', async ({
    assert,
  }) => {
    const { service, vault, store } = await readOnlyService();
    assert.isTrue(service.keystoreReadOnly);
    const rotate = await service.rotateKeys(2).catch((e) => e);
    assert.instanceOf(rotate, KeystoreReadOnlyError);
    assert.equal(rotate.code, 'E_KEYSTORE_READ_ONLY');
    assert.equal(rotate.action, 'rotate');
    await assert.rejects(() => service.generateKey(), KeystoreReadOnlyError);
    await assert.rejects(
      () => service.retireKey(store.keys[0]!.kid as string),
      KeystoreReadOnlyError,
    );
    await assert.rejects(() => service.sealedAtRest({ all: true }), KeystoreReadOnlyError);
    // Report and dry-run only read.
    await service.sealedAtRest({ report: true });
    assert.isFalse((await service.sealedAtRest({ dryRun: true })).columns.length > 1);
    assert.equal(vault.writes(), 0);
    // The keys are still listed (read path).
    assert.lengthOf(await service.listManagedKeys(), 1);
  });

  test('reloadKeys picks up a rotation the writer made', async ({ assert }) => {
    const { service, vault } = await readOnlyService();
    const writer = new KeystoreManager(vault, plain(), 'RS256');
    const { newKid } = await writer.rotate(2);
    await service.reloadKeys();
    assert.equal(service.publicJwks.keys[0]!.kid, newKid);
  });
});

test.group('jwks.readOnly | key rotation scheduler', () => {
  test('never starts on a read-only instance; starts on the writer', async ({ assert }) => {
    const { service } = await readOnlyService();
    assert.isFalse(await keyRotationSchedulerApplies(service));
    const writer = {
      rotateKeys: async () => {},
      keystoreAgeDays: async () => 3,
      keystoreReadOnly: false,
    };
    assert.isTrue(await keyRotationSchedulerApplies(writer));
    assert.isFalse(
      await keyRotationSchedulerApplies({ ...writer, keystoreAgeDays: async () => null }),
    );
    assert.isFalse(await keyRotationSchedulerApplies(null));
  });
});

test.group('jwks.readOnly | Admin API and console', () => {
  test('GET /keys reports readOnly (the console flag) and no rotation ETA', async ({ assert }) => {
    const { service } = await readOnlyService();
    for (const controller of [new ApiKeysController(), new ConsoleKeysController()]) {
      const res: any = await controller.status(fakeCtx(service).ctx);
      assert.isTrue(res.readOnly);
      assert.isNull(res.nextRotationInDays);
      assert.lengthOf(res.keys, 1);
    }
  });

  test('POST /keys/rotate → 409 keystore_read_only (API and console, before sudo)', async ({
    assert,
  }) => {
    const { service, vault } = await readOnlyService();
    for (const controller of [new ApiKeysController(), new ConsoleKeysController()]) {
      const f = fakeCtx(service, { retire: true });
      await controller.rotate(f.ctx);
      assert.equal(f.status(), 409);
      assert.equal(f.body().error.code, 'keystore_read_only');
    }
    assert.equal(vault.writes(), 0);
  });
});

test.group('jwks.readOnly | key_rotation setting', (group) => {
  group.each.teardown(() => resetLockedSettingKeys());

  test('derived only from jwks.readOnly', ({ assert }) => {
    assert.deepEqual(deriveReadOnlySettingKeys({ jwksConfig: { readOnly: true } }), [
      SETTING_KEYS.KEY_ROTATION,
    ]);
    assert.deepEqual(deriveReadOnlySettingKeys({ jwksConfig: {} }), []);
    assert.deepEqual(deriveReadOnlySettingKeys({}), []);
  });

  test('reads the shared policy, refuses writes and deletes', async ({ assert, cleanup }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    await db.connection().schema.createTable('auth_settings', (t) => {
      t.increments('id');
      t.string('key').notNullable();
      t.string('organization_id').nullable();
      t.text('value').notNullable();
      t.timestamp('updated_at').nullable();
      t.string('updated_by').nullable();
    });
    const settings = new RuntimeSettings(db as any);
    const policy = { enabled: true, maxAgeDays: 30, keep: 2 };
    await settings.setSetting(SETTING_KEYS.KEY_ROTATION, policy);

    setReadOnlySettingKeys([SETTING_KEYS.KEY_ROTATION]);
    const fresh = new RuntimeSettings(db as any);
    assert.deepEqual(await fresh.getSetting(SETTING_KEYS.KEY_ROTATION), policy);
    const error = await fresh
      .setSetting(SETTING_KEYS.KEY_ROTATION, { ...policy, enabled: false })
      .catch((e) => e);
    assert.instanceOf(error, SettingReadOnlyError);
    // Existing `SettingLockedError` handlers (CLI) catch it too.
    assert.instanceOf(error, SettingLockedError);
    assert.equal(error.code, 'E_KEYSTORE_READ_ONLY');
    await assert.rejects(
      () => fresh.deleteSetting(SETTING_KEYS.KEY_ROTATION),
      SettingReadOnlyError,
    );
    // Other shared settings stay writable.
    await fresh.setSetting(SETTING_KEYS.REGISTRATION, { enabled: true });
    assert.deepEqual(await fresh.getSetting(SETTING_KEYS.KEY_ROTATION), policy);
  });

  test('Admin API PUT/DELETE /settings/key_rotation → 409 keystore_read_only; GET lists it', async ({
    assert,
    cleanup,
  }) => {
    const db = createTestDatabase();
    cleanup(() => db.manager.closeAll());
    await db.connection().schema.createTable('auth_settings', (t) => {
      t.increments('id');
      t.string('key').notNullable();
      t.string('organization_id').nullable();
      t.text('value').notNullable();
      t.timestamp('updated_at').nullable();
      t.string('updated_by').nullable();
    });
    setReadOnlySettingKeys([SETTING_KEYS.KEY_ROTATION]);
    const audit: unknown[] = [];
    const service = { config: { audit: { record: async (e: unknown) => audit.push(e) } } };
    const ctx = (method: 'upsert' | 'destroy' | 'index') => {
      let status = 200;
      let sent: any;
      const send = (b: any) => {
        sent = b;
        return b;
      };
      return {
        ctx: {
          request: {
            param: () => SETTING_KEYS.KEY_ROTATION,
            body: () => (method === 'upsert' ? { value: { enabled: false } } : {}),
            qs: () => ({}),
            ip: () => '127.0.0.1',
          },
          response: {
            status: (s: number) => {
              status = s;
              return { send };
            },
            notFound: send,
            badRequest: send,
          },
          containerResolver: {
            make: async (key: string) => {
              if (key === 'authkit.server') return service;
              if (key === 'lucid.db') return db;
              throw new Error(`no binding for ${key}`);
            },
          },
        } as any,
        status: () => status,
        body: () => sent,
      };
    };
    const controller = new ApiSettingsController();
    for (const method of ['upsert', 'destroy'] as const) {
      const c = ctx(method);
      await controller[method](c.ctx);
      assert.equal(c.status(), 409, method);
      assert.equal(c.body().error.code, 'keystore_read_only');
    }
    assert.lengthOf(audit, 0);
    const list: any = await controller.index(ctx('index').ctx);
    assert.deepEqual(list.readOnly, [SETTING_KEYS.KEY_ROTATION]);
    assert.deepEqual(readOnlySettingKeys(), [SETTING_KEYS.KEY_ROTATION]);
  });
});

test.group('jwks.readOnly | commands', () => {
  async function harness() {
    const ro = await readOnlyService();
    const app: any = new AppFactory().create(new URL('../', import.meta.url), () => {});
    await app.init();
    app.container.singleton('authkit.server' as any, async () => ro.service);
    const db = createTestDatabase();
    await db.connection().schema.createTable('auth_settings', (t) => {
      t.increments('id');
      t.string('key').notNullable();
      t.string('organization_id').nullable();
      t.text('value').notNullable();
      t.timestamp('updated_at').nullable();
      t.string('updated_by').nullable();
    });
    app.container.singleton('lucid.db' as any, async () => db);
    const kernel = new Kernel(app);
    kernel.ui.switchMode('raw');
    async function run(Command: any, argv: string[]) {
      await Command.boot();
      const parsed = new Parser(Command.getParserOptions()).parse(argv);
      Command.validate(parsed);
      const command = new Command(app, kernel, parsed, kernel.ui, kernel.prompt);
      command.hydrate();
      const before = kernel.ui.logger.getLogs().length;
      await command.exec();
      const logs = kernel.ui.logger
        .getLogs()
        .slice(before)
        .map((l: any) => l.message as string);
      return { exitCode: command.exitCode ?? 0, logs };
    }
    return { ...ro, run, db };
  }

  test('authkit:key generate|rotate|retire exit 1 with the reason; list and rotate --dry-run work', async ({
    assert,
    cleanup,
  }) => {
    const h = await harness();
    cleanup(() => h.db.manager.closeAll());
    const kid = h.store.keys[0]!.kid as string;
    for (const argv of [['generate'], ['rotate', '--force'], ['retire', kid, '--force']]) {
      const { exitCode, logs } = await h.run(AuthkitKey, argv);
      assert.equal(exitCode, 1, argv.join(' '));
      assert.match(logs.join('\n'), /jwks\.readOnly/);
    }
    assert.equal(h.vault.writes(), 0);
    // `rotate --dry-run` only plans (a read), like `crypto:reseal --dry-run`.
    const plan = await h.run(AuthkitKey, ['rotate', '--dry-run', '--json']);
    assert.equal(plan.exitCode, 0);
    assert.include(plan.logs.join('\n'), kid);
    assert.equal(h.vault.writes(), 0);
    const list = await h.run(AuthkitKey, ['list', '--json']);
    assert.equal(list.exitCode, 0);
    assert.include(list.logs.join('\n'), kid);
  });

  test('authkit:settings:unset exits 1 on a read-only and on a config-locked key', async ({
    assert,
    cleanup,
  }) => {
    const h = await harness();
    cleanup(async () => {
      resetLockedSettingKeys();
      await h.db.manager.closeAll();
    });
    const settings = new RuntimeSettings(h.db as any);
    await settings.setSetting(SETTING_KEYS.KEY_ROTATION, {
      enabled: true,
      maxAgeDays: 30,
      keep: 2,
    });
    await settings.setSetting(SETTING_KEYS.LOCKOUT, { enabled: true });

    setReadOnlySettingKeys([SETTING_KEYS.KEY_ROTATION]);
    const readOnly = await h.run(AuthkitSettingsUnset, [SETTING_KEYS.KEY_ROTATION]);
    assert.equal(readOnly.exitCode, 1);
    assert.match(readOnly.logs.join('\n'), /jwks\.readOnly/);

    setLockedSettingKeys([SETTING_KEYS.LOCKOUT]);
    const locked = await h.run(AuthkitSettingsUnset, [SETTING_KEYS.LOCKOUT]);
    assert.equal(locked.exitCode, 1);
    assert.match(locked.logs.join('\n'), /locked/);

    resetLockedSettingKeys();
    assert.lengthOf(await h.db.connection().from('auth_settings'), 2);
    const unset = await h.run(AuthkitSettingsUnset, [SETTING_KEYS.LOCKOUT]);
    assert.equal(unset.exitCode, 0);
  });

  test('authkit:crypto:reseal exits 1; --dry-run still reports', async ({ assert, cleanup }) => {
    const h = await harness();
    cleanup(() => h.db.manager.closeAll());
    const real = await h.run(AuthkitCryptoReseal, []);
    assert.equal(real.exitCode, 1);
    assert.match(real.logs.join('\n'), /jwks\.readOnly/);
    const dry = await h.run(AuthkitCryptoReseal, ['--dry-run']);
    assert.equal(dry.exitCode, 0);
    assert.equal(h.vault.writes(), 0);
  });
});
