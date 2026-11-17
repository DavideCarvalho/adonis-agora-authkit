import { test } from '@japa/runner';
import { setBootedApp } from '../../services/booted_app.js';
import { keystoreCodec } from '../../src/crypto/authkit_crypto.js';
import {
  __setEncryptionServiceForTests,
  getInjectedEncryptionService,
  loadEncryptionService,
} from '../../src/keys/keystore_crypto.js';

const fakeEncryption = () => ({
  encrypt: (v: unknown) => `enc:${String(v)}`,
  decrypt: <T = string>(v: string) => v.replace(/^enc:/, '') as unknown as T,
});

/** Um app "bootado" mínimo: só o container que o loader usa. */
function bootedAppWith(make: (binding: string) => Promise<unknown>) {
  return { container: { make } } as any;
}

test.group('keystore crypto', (group) => {
  group.each.teardown(() => {
    __setEncryptionServiceForTests(undefined);
    setBootedApp(undefined as any);
  });

  test('serviço injetado é retornado (sem app)', ({ assert }) => {
    const fake = fakeEncryption();
    __setEncryptionServiceForTests(fake);
    assert.strictEqual(getInjectedEncryptionService(), fake);
  });

  test('sem injeção, getInjected retorna undefined', ({ assert }) => {
    assert.isUndefined(getInjectedEncryptionService());
  });

  test('com o provider registrado, a encryption vem do container do app bootado', async ({
    assert,
  }) => {
    const svc = fakeEncryption();
    const asked: string[] = [];
    setBootedApp(
      bootedAppWith(async (binding) => {
        asked.push(binding);
        return svc;
      }),
    );
    assert.strictEqual(await loadEncryptionService(), svc);
    assert.deepEqual(asked, ['encryption']);
  });

  test('falha do container chega ao keystore com a causa, não só "indisponível"', async ({
    assert,
  }) => {
    const boom = new Error('E_MISSING_APP_KEY: appKey ausente');
    setBootedApp(
      bootedAppWith(async () => {
        throw boom;
      }),
    );
    const error = await keystoreCodec(true, undefined).catch((caught: unknown) => caught);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, 'indisponível');
    assert.include((error as Error).message, 'E_MISSING_APP_KEY');
    assert.strictEqual((error as Error).cause, boom);
  });

  test('cada chamada resolve de novo pelo container: uma falha não fica guardada', async ({
    assert,
  }) => {
    const svc = fakeEncryption();
    let calls = 0;
    setBootedApp(
      bootedAppWith(async () => {
        calls++;
        if (calls === 1) throw new Error('falha passageira');
        return svc;
      }),
    );
    await assert.rejects(() => loadEncryptionService(), /falha passageira/);
    assert.strictEqual(await loadEncryptionService(), svc);
  });
});
