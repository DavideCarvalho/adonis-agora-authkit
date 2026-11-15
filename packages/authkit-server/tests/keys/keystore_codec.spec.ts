import { test } from '@japa/runner';
import { authkitKeyring, KEYSTORE_PURPOSE } from '../../src/crypto/authkit_crypto.js';
import { gcmEncryption } from '../../src/crypto-kit/index.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';

const STORE = { keys: [{ kid: 'k1', kty: 'RSA', d: 'secret', use: 'sig' }] };

test.group('KeystoreCodec (plaintext)', () => {
  test('round-trip plaintext via envelope v2/none', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: false });
    const blob = await codec.encode(STORE as any);
    assert.deepEqual(JSON.parse(blob).enc, 'none');
    assert.deepEqual(await codec.decode(blob), STORE);
  });

  test('decode lança em formato irreconhecível', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: false });
    await assert.rejects(() => codec.decode('{"v":2,"enc":"weird","data":"x"}'));
  });
});

test.group('KeystoreCodec (encrypted, crypto kit)', () => {
  // The app's own encryption service (config/encryption.ts): what older versions sealed with.
  const APP_KEY = 'app-key-of-the-test-app-32-chars';
  const NEW_KEY = 'the-new-sealing-key-of-32-chars!';
  const appEncryption = gcmEncryption([APP_KEY], 'app');
  const ring = (crypto?: Parameters<typeof authkitKeyring>[1]) =>
    authkitKeyring(KEYSTORE_PURPOSE, crypto, appEncryption);

  test('round-trip sealed with the kit (envelope v2/agora), private key never in clear', async ({
    assert,
  }) => {
    const codec = new KeystoreCodec({ encrypt: true, keyring: await ring() });
    const blob = await codec.encode(STORE as any);
    const env = JSON.parse(blob);
    assert.equal(env.enc, 'agora');
    assert.match(env.data, /^agora:v1:app\.v1:/);
    assert.notInclude(env.data, 'secret');
    assert.deepEqual(await codec.decode(blob), STORE);
    assert.equal(await codec.status(blob), 'active');
  });

  test('opens a keystore sealed by earlier versions (v2/aes, the app encryption) — no migration', async ({
    assert,
  }) => {
    const legacy = JSON.stringify({
      v: 2,
      enc: 'aes',
      data: appEncryption.encrypt(JSON.stringify(STORE)),
    });
    const codec = new KeystoreCodec({ encrypt: true, keyring: await ring() });
    assert.deepEqual(await codec.decode(legacy), STORE);
    assert.equal(await codec.status(legacy), 'legacy');
    const resealed = await codec.reseal(legacy);
    assert.equal(JSON.parse(resealed as string).enc, 'agora');
    assert.deepEqual(await codec.decode(resealed as string), STORE);
    assert.isNull(await codec.reseal(resealed as string));
  });

  test('crypto.keys: an older key is `retired`, reseal moves it to the first key', async ({
    assert,
  }) => {
    const before = new KeystoreCodec({ encrypt: true, keyring: await ring({ keys: [APP_KEY] }) });
    const blob = await before.encode(STORE as any);
    const after = new KeystoreCodec({
      encrypt: true,
      keyring: await ring({ keys: [NEW_KEY, APP_KEY] }),
    });
    assert.equal(await after.status(blob), 'retired');
    const fresh = (await after.reseal(blob)) as string;
    assert.equal(await after.status(fresh), 'active');
    const onlyNew = new KeystoreCodec({ encrypt: true, keyring: await ring({ keys: [NEW_KEY] }) });
    assert.deepEqual(await onlyNew.decode(fresh), STORE);
    await assert.rejects(() => onlyNew.decode(blob), /decrypt falhou/);
    assert.equal(await onlyNew.status(blob), 'unreadable');
  });

  test('a tampered keystore is refused (never regenerated)', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: true, keyring: await ring() });
    const env = JSON.parse(await codec.encode(STORE as any));
    // `agora:v1:app.v1:<ct>.<iv>.<tag>`: flip a bit of the decoded tag.
    const parts = (env.data as string).split('.');
    const tag = Buffer.from(parts[3] as string, 'base64url');
    tag[0] = (tag[0] as number) ^ 0x01;
    parts[3] = tag.toString('base64url');
    const tampered = JSON.stringify({ ...env, data: parts.join('.') });
    await assert.rejects(() => codec.decode(tampered), /decrypt falhou/);
    assert.equal(await codec.status(tampered), 'unreadable');
  });

  test('encrypt:true sem serviço lança no encode', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: true });
    await assert.rejects(() => codec.encode(STORE as any), /indisponível/);
  });
});
