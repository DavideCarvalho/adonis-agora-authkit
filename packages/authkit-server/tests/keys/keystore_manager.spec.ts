import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@japa/runner';
import { signingKeyAgeDays } from '../../src/keys/keystore.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';
import { __setEncryptionServiceForTests } from '../../src/keys/keystore_crypto.js';
import { KeystoreManager, resolveKeystoreVault } from '../../src/keys/keystore_manager.js';
import type { KeystoreVault } from '../../src/keys/keystore_vault.js';
import {
  DriveKeystoreVault,
  FileKeystoreVault,
  HashicorpVaultKeystoreVault,
  LazyExternalVault,
  LucidKeystoreVault,
  RedisKeystoreVault,
} from '../../src/keys/keystore_vault.js';

function memVault(initial: string | null = null): KeystoreVault & { blob: string | null } {
  return {
    blob: initial,
    async read() {
      return this.blob;
    },
    async write(b: string) {
      this.blob = b;
    },
    async head() {
      return this.blob ? String(this.blob.length) : null;
    },
  };
}

test.group('KeystoreManager', () => {
  test('ensure gera + persiste quando ausente', async ({ assert }) => {
    const vault = memVault();
    const mgr = new KeystoreManager(vault, new KeystoreCodec({ encrypt: false }), 'RS256');
    const store = await mgr.ensure();
    assert.lengthOf(store.keys, 1);
    assert.isString(store.keys[0].kid);
    assert.isNotNull(vault.blob); // persistiu
  });

  test('ensure existente decodifica e retorna sem reescrever', async ({ assert }) => {
    const codec = new KeystoreCodec({ encrypt: false });
    const existing = await codec.encode({
      keys: [{ kid: 'old', kty: 'RSA', d: 'x', alg: 'RS256' }],
    } as any);
    const vault = memVault(existing);
    const mgr = new KeystoreManager(vault, codec, 'RS256');
    const store = await mgr.ensure();
    assert.equal(store.keys[0].kid, 'old'); // preserva a chave existente
    assert.equal(vault.blob, existing); // não reescreveu
  });

  test('rotate gera kid novo na frente e mantém keep', async ({ assert }) => {
    const vault = memVault();
    const mgr = new KeystoreManager(vault, new KeystoreCodec({ encrypt: false }), 'RS256');
    await mgr.ensure();
    const firstKid = (await mgr.read())!.keys[0].kid;
    const res = await mgr.rotate(2, false);
    assert.notEqual(res.newKid, firstKid);
    const after = (await mgr.read())!;
    assert.equal(after.keys[0].kid, res.newKid); // novo assina
    assert.equal(after.keys[1].kid, firstKid); // antigo no grace
  });

  test('head delega ao vault', async ({ assert }) => {
    const vault = memVault();
    const mgr = new KeystoreManager(vault, new KeystoreCodec({ encrypt: false }), 'RS256');
    assert.isNull(await mgr.head());
    await mgr.ensure();
    assert.isString(await mgr.head());
  });
});

test.group('resolveKeystoreVault', () => {
  const ctx = {
    makePath: (p: string) => `/abs/${p}`,
    container: { make: async (_t: string) => ({}) },
  };

  test('string → FileKeystoreVault', ({ assert }) => {
    assert.instanceOf(resolveKeystoreVault('tmp/jwks.json', ctx), FileKeystoreVault);
  });
  test('{driver:file} → FileKeystoreVault', ({ assert }) => {
    assert.instanceOf(
      resolveKeystoreVault({ driver: 'file', path: 'tmp/x.json' }, ctx),
      FileKeystoreVault,
    );
  });
  test('{driver:drive} → DriveKeystoreVault', ({ assert }) => {
    assert.instanceOf(
      resolveKeystoreVault({ driver: 'drive', key: 'keys/jwks.json' }, ctx),
      DriveKeystoreVault,
    );
  });
  test('instância custom passa direto', ({ assert }) => {
    const custom = { read: async () => null, write: async () => {} };
    assert.strictEqual(resolveKeystoreVault(custom as any, ctx), custom);
  });
  test('{driver:lucid} → LucidKeystoreVault', ({ assert }) => {
    assert.instanceOf(resolveKeystoreVault({ driver: 'lucid' }, ctx), LucidKeystoreVault);
  });
  test('{driver:redis} → RedisKeystoreVault', ({ assert }) => {
    assert.instanceOf(resolveKeystoreVault({ driver: 'redis' }, ctx), RedisKeystoreVault);
  });
  test('{driver:hashicorp-vault} → HashicorpVaultKeystoreVault', ({ assert }) => {
    assert.instanceOf(
      resolveKeystoreVault(
        { driver: 'hashicorp-vault', endpoint: 'http://v', path: 'p' } as any,
        ctx,
      ),
      HashicorpVaultKeystoreVault,
    );
  });
  test('{driver:aws-secrets-manager} → LazyExternalVault (lazy-load do package)', ({ assert }) => {
    assert.instanceOf(
      resolveKeystoreVault({ driver: 'aws-secrets-manager', secretId: 's' } as any, ctx),
      LazyExternalVault,
    );
  });
});

test.group('KeystoreManager em arquivo (paridade com o comando)', (group) => {
  let dir: string;
  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'authkit-mgr-'));
  });
  group.each.teardown(() => rmSync(dir, { recursive: true, force: true }));

  test('rotate --retire mantém só a nova', async ({ assert }) => {
    const vault = new FileKeystoreVault(join(dir, 'jwks.json'));
    const mgr = new KeystoreManager(vault, new KeystoreCodec({ encrypt: false }), 'RS256');
    await mgr.ensure();
    const res = await mgr.rotate(2, true);
    const store = (await mgr.read())!;
    assert.lengthOf(store.keys, 1);
    assert.equal(store.keys[0].kid, res.newKid);
    assert.isAbove(res.retiredKids.length, 0);
  });
});

test.group('idade via keystore encriptado (regressão doctor)', (group) => {
  const fakeEnc = {
    encrypt: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
    decrypt: <T = string>(v: string) => Buffer.from(v, 'base64').toString('utf8') as unknown as T,
  };
  group.each.teardown(() => __setEncryptionServiceForTests(undefined));

  test('keystore encriptado → idade legível com enc disponível', async ({ assert }) => {
    __setEncryptionServiceForTests(fakeEnc);
    const vault = {
      blob: null as string | null,
      async read() {
        return this.blob;
      },
      async write(b: string) {
        this.blob = b;
      },
    };
    const codec = new KeystoreCodec({ encrypt: true, enc: fakeEnc });
    const mgr = new KeystoreManager(vault as any, codec, 'RS256');
    await mgr.ensure();
    // sanity: o blob persistido está mesmo encriptado (aes), não plaintext
    assert.equal(JSON.parse(vault.blob!).enc, 'aes');
    // lê de volta e computa idade (deve ser um número, não null)
    const store = await mgr.read();
    assert.isNotNull(store);
    assert.isNumber(signingKeyAgeDays(store));
  });

  test('keystore encriptado SEM enc → read lança (doctor degrada p/ não-aplicável)', async ({
    assert,
  }) => {
    const codec = new KeystoreCodec({ encrypt: true, enc: fakeEnc });
    const vault = {
      blob: null as string | null,
      async read() {
        return this.blob;
      },
      async write(b: string) {
        this.blob = b;
      },
    };
    await new KeystoreManager(vault as any, codec, 'RS256').ensure();
    // um manager SEM enc (como o doctor com encrypt:false) não consegue decodificar
    const noEncMgr = new KeystoreManager(
      vault as any,
      new KeystoreCodec({ encrypt: false }),
      'RS256',
    );
    await assert.rejects(() => noEncMgr.read());
  });
});
