import { configProvider } from '@adonisjs/core';
import { Kernel, Parser } from '@adonisjs/core/ace';
import { AppFactory } from '@adonisjs/core/factories/app';
import { test } from '@japa/runner';
import AuthkitCryptoReseal from '../../commands/crypto_reseal.js';
import {
  type AccountSecretsCapability,
  emptyColumnReport,
  keystoreCodec,
} from '../../src/crypto/authkit_crypto.js';
import { gcmEncryption } from '../../src/crypto-kit/index.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { generateSigningJwk, toProviderJwks } from '../../src/keys/keystore.js';
import { __setEncryptionServiceForTests } from '../../src/keys/keystore_crypto.js';
import { KeystoreManager } from '../../src/keys/keystore_manager.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

const APP_KEY = 'app-key-of-the-test-app-32-chars';
const appEncryption = gcmEncryption([APP_KEY], 'app');

/** An in-memory vault holding a keystore sealed by an EARLIER authkit (v2/aes, app encryption). */
async function legacyVault() {
  const store = { keys: [await generateSigningJwk('RS256')] };
  let blob: string | null = JSON.stringify({
    v: 2,
    enc: 'aes',
    data: appEncryption.encrypt(JSON.stringify(store)),
  });
  return {
    store,
    vault: {
      read: async () => blob,
      write: async (value: string) => {
        blob = value;
      },
    },
    blob: () => blob,
  };
}

async function harness(accountSecrets?: AccountSecretsCapability) {
  __setEncryptionServiceForTests(appEncryption as never);
  const { vault, store, blob } = await legacyVault();
  const manager = new KeystoreManager(vault, await keystoreCodec(true, undefined), 'RS256');
  const accountStore: any = fakeAccountStore();
  if (accountSecrets)
    Object.defineProperty(accountStore, 'accountSecrets', { value: accountSecrets });
  const db = createTestDatabase();
  const cfg = (await configProvider.resolve(
    { container: { make: async () => db } } as any,
    defineConfig({
      issuer: 'http://localhost:1',
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore,
    }),
  )) as ResolvedServerConfig;
  const service = new OidcService(
    { ...cfg, jwks: toProviderJwks(store) },
    'a'.repeat(32),
    undefined,
    {
      keystoreManager: async () => manager,
    },
  );
  const app: any = new AppFactory().create(new URL('../', import.meta.url), () => {});
  await app.init();
  app.container.singleton('authkit.server' as any, async () => service);
  const kernel = new Kernel(app);
  kernel.ui.switchMode('raw');
  return {
    service,
    manager,
    store,
    blob,
    async run(argv: string[]) {
      await AuthkitCryptoReseal.boot();
      const parsed = new Parser(AuthkitCryptoReseal.getParserOptions()).parse(argv);
      AuthkitCryptoReseal.validate(parsed);
      const command = new AuthkitCryptoReseal(app, kernel, parsed, kernel.ui, kernel.prompt);
      command.hydrate();
      const before = kernel.ui.logger.getLogs().length;
      await command.exec();
      const logs = kernel.ui.logger
        .getLogs()
        .slice(before)
        .map((l) => l.message);
      return { exitCode: command.exitCode, logs };
    },
    async close() {
      __setEncryptionServiceForTests(undefined);
      await db.manager.closeAll();
    },
  };
}

const json = (logs: string[]) =>
  JSON.parse(logs.find((l) => l.trimStart().startsWith('{'))!.replace(/^\[ [^\]]*\] /, ''));

test.group('authkit:crypto:reseal', () => {
  test('--dry-run --json reports the legacy keystore without writing; a run reseals it', async ({
    assert,
    cleanup,
  }) => {
    const h = await harness();
    cleanup(() => h.close());
    const before = h.blob();

    const dry = await h.run(['--dry-run', '--json']);
    assert.equal(dry.exitCode ?? 0, 0);
    const report = json(dry.logs);
    assert.isTrue(report.dryRun);
    assert.deepInclude(report.columns[0], { column: 'keystore', legacy: 1, resealed: 1 });
    assert.equal(h.blob(), before);

    const real = await h.run(['--json']);
    assert.equal(real.exitCode ?? 0, 0);
    assert.equal(JSON.parse(h.blob() as string).enc, 'agora');
    assert.deepEqual(await h.manager.read(), h.store);
    const after = await h.service.sealedAtRest({ report: true });
    assert.deepInclude(after.columns[0], { active: 1, legacy: 0 });
  });

  test('aggregates the account secrets, and exits 1 when a value does not open', async ({
    assert,
    cleanup,
  }) => {
    const calls: unknown[] = [];
    const h = await harness({
      async reseal(options) {
        calls.push(options);
        return {
          ...emptyColumnReport('auth_mfa.totp_secret'),
          scanned: 1,
          unreadable: 1,
          failed: 1,
        };
      },
    });
    cleanup(() => h.close());
    const { exitCode, logs } = await h.run(['--all']);
    assert.equal(exitCode, 1);
    assert.deepEqual(calls, [{ dryRun: false, all: true }]);
    assert.isTrue(logs.some((l) => l.includes('did not open')));
  });
});
