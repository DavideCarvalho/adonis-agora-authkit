import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { resolveUploads } from '../../src/define_config.js';
import {
  __setDriveLoaderForTests,
  __setMediaLoaderForTests,
  AvatarUploadError,
  deleteAvatar,
  isAvatarUploadSupported,
  isDriveAvailable,
  storeAvatar,
} from '../../src/host/avatar_storage.js';
import { DEFAULT_MESSAGES, translate } from '../../src/host/i18n.js';

const viewsDir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
const readView = (p: string) => readFileSync(viewsDir + p, 'utf8');

function makeEdge() {
  const edge = new Edge();
  edge.mount('authkit', viewsDir);
  edge.global('t', (key: string, params?: Record<string, string | number>) =>
    translate({ ...DEFAULT_MESSAGES }, key, params),
  );
  return edge;
}

/** Drive fake em memória: registra puts e devolve URL previsível. */
function fakeDrive() {
  const puts: { key: string }[] = [];
  const disk = {
    async putStream(key: string) {
      puts.push({ key });
    },
    async getUrl(key: string) {
      return `https://cdn.test/${key}`;
    },
  };
  return {
    puts,
    service: {
      use(_disk?: string) {
        return disk;
      },
    },
  };
}

/** File de multipart fake (com moveToDisk + tmpPath). */
function fakeFile(over: Partial<{ extname: string; size: number; recorded: string[] }> = {}) {
  const moves: string[] = over.recorded ?? [];
  return {
    extname: over.extname ?? 'png',
    size: over.size ?? 1024,
    tmpPath: '/tmp/fake-avatar.png',
    async moveToDisk(key: string) {
      moves.push(key);
    },
    moves,
  };
}

/**
 * Módulo media fake em memória: registra as chamadas de store/remove e devolve
 * uma URL previsível. `available` controla o `isSingleFileStoreAvailable`.
 */
function fakeMedia(over: { available?: boolean } = {}) {
  const stores: Array<{
    ownerType: string;
    ownerId: string;
    collection: string;
    fileName: string;
    mimeType: string;
    contents: Buffer;
  }> = [];
  const removes: Array<{ ownerType: string; ownerId: string; collection: string }> = [];
  return {
    stores,
    removes,
    module: {
      async isSingleFileStoreAvailable() {
        return over.available ?? true;
      },
      async storeSingleFile(input: (typeof stores)[number]) {
        stores.push(input);
        return {
          url: `https://media.test/${input.ownerType}/${input.ownerId}/${input.collection}`,
          thumbUrl: null,
        };
      },
      async removeSingleFile(input: (typeof removes)[number]) {
        removes.push(input);
      },
    },
  };
}

const ctx = {} as any;
const msgs = {
  extname: translate({ ...DEFAULT_MESSAGES }, 'account.profile.avatar_invalid_type'),
  size: translate({ ...DEFAULT_MESSAGES }, 'account.profile.avatar_too_large'),
};

test.group('avatar_storage', (group) => {
  group.each.teardown(() => {
    __setDriveLoaderForTests(undefined);
    __setMediaLoaderForTests(undefined);
  });

  test('armazena avatar via drive do app e retorna URL pública', async ({ assert }) => {
    const drive = fakeDrive();
    __setDriveLoaderForTests(() => Promise.resolve(drive.service));

    const cfg = resolveUploads();
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);

    assert.isString(url);
    assert.include(url!, 'https://cdn.test/authkit/avatars/acc-1-');
    assert.match(url!, /\.png$/);
    // moveToDisk foi usado com a key derivada.
    assert.lengthOf(file.moves, 1);
    assert.include(file.moves[0], 'authkit/avatars/acc-1-');
  });

  test('respeita disk e directory customizados', async ({ assert }) => {
    let usedDisk: string | undefined;
    const inner = {
      async getUrl(key: string) {
        return `https://s3/${key}`;
      },
    };
    __setDriveLoaderForTests(() =>
      Promise.resolve({
        use(d?: string) {
          usedDisk = d;
          return inner;
        },
      }),
    );

    const cfg = resolveUploads({ avatars: { disk: 's3', directory: 'custom/dir' } });
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-9', msgs);

    assert.equal(usedDisk, 's3');
    assert.include(url!, 'https://s3/custom/dir/acc-9-');
    assert.include(file.moves[0], 'custom/dir/acc-9-');
  });

  test('rejeita extensão inválida com erro i18n', async ({ assert }) => {
    __setDriveLoaderForTests(() => Promise.resolve(fakeDrive().service));
    const cfg = resolveUploads();
    const file = fakeFile({ extname: 'gif' });

    await assert.rejects(async () => {
      await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);
    }, msgs.extname);

    try {
      await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);
    } catch (e: any) {
      assert.instanceOf(e, AvatarUploadError);
      assert.equal(e.reason, 'extname');
    }
  });

  test('rejeita arquivo acima do tamanho máximo com erro i18n', async ({ assert }) => {
    __setDriveLoaderForTests(() => Promise.resolve(fakeDrive().service));
    const cfg = resolveUploads({ avatars: { maxSizeMb: 1 } });
    const file = fakeFile({ size: 2 * 1024 * 1024 });

    try {
      await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);
      assert.fail('deveria ter lançado');
    } catch (e: any) {
      assert.instanceOf(e, AvatarUploadError);
      assert.equal(e.reason, 'size');
      assert.equal(e.message, msgs.size);
    }
  });

  test('drive ausente → retorna null (degrada para URL) e isDriveAvailable=false', async ({
    assert,
  }) => {
    __setDriveLoaderForTests(() => Promise.resolve(null));
    const cfg = resolveUploads();
    const file = fakeFile();

    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);
    assert.isNull(url);
    assert.isFalse(await isDriveAvailable());
  });

  test("storage 'auto' com media presente → roteia para o media (store)", async ({ assert }) => {
    const media = fakeMedia();
    __setMediaLoaderForTests(() => Promise.resolve(media.module));
    // drive também presente para provar que o media tem prioridade no 'auto'.
    __setDriveLoaderForTests(() => Promise.resolve(fakeDrive().service));

    // Bytes reais no tmpPath (o backend media lê via fs.readFile).
    const tmpPath = join(tmpdir(), `authkit-avatar-${Date.now()}.png`);
    writeFileSync(tmpPath, Buffer.from('fake-png-bytes'));

    const cfg = resolveUploads();
    const file = { ...fakeFile(), tmpPath, type: 'image/png' };
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-42', msgs);

    // URL do media foi usada, não a do drive.
    assert.equal(url, 'https://media.test/AuthAccount/acc-42/avatar');
    assert.lengthOf(media.stores, 1);
    const call = media.stores[0];
    assert.equal(call.ownerType, 'AuthAccount');
    assert.equal(call.ownerId, 'acc-42');
    assert.equal(call.collection, 'avatar');
    assert.equal(call.fileName, 'avatar.png');
    assert.equal(call.mimeType, 'image/png');
    assert.equal(call.contents.toString(), 'fake-png-bytes');
  });

  test("storage 'auto' com media presente → roteia para o media (delete)", async ({ assert }) => {
    const media = fakeMedia();
    __setMediaLoaderForTests(() => Promise.resolve(media.module));
    __setDriveLoaderForTests(() => Promise.resolve(fakeDrive().service));

    const cfg = resolveUploads();
    const ok = await deleteAvatar(cfg, 'acc-7', 'https://media.test/AuthAccount/acc-7/avatar');

    assert.isTrue(ok);
    assert.lengthOf(media.removes, 1);
    assert.deepEqual(media.removes[0], {
      ownerType: 'AuthAccount',
      ownerId: 'acc-7',
      collection: 'avatar',
    });
  });

  test("storage 'auto' sem media (loader null) → cai no drive builtin", async ({ assert }) => {
    const drive = fakeDrive();
    __setMediaLoaderForTests(() => Promise.resolve(null));
    __setDriveLoaderForTests(() => Promise.resolve(drive.service));

    const cfg = resolveUploads();
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);

    assert.include(url!, 'https://cdn.test/authkit/avatars/acc-1-');
    assert.lengthOf(file.moves, 1);
  });

  test("storage 'auto' com media presente mas store indisponível → cai no drive builtin", async ({
    assert,
  }) => {
    const media = fakeMedia({ available: false });
    const drive = fakeDrive();
    __setMediaLoaderForTests(() => Promise.resolve(media.module));
    __setDriveLoaderForTests(() => Promise.resolve(drive.service));

    const cfg = resolveUploads();
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);

    // Media não usável → builtin; nenhum store no media.
    assert.include(url!, 'https://cdn.test/authkit/avatars/acc-1-');
    assert.lengthOf(media.stores, 0);
  });

  test("storage 'builtin' com media presente → ainda usa o drive builtin", async ({ assert }) => {
    const media = fakeMedia();
    const drive = fakeDrive();
    __setMediaLoaderForTests(() => Promise.resolve(media.module));
    __setDriveLoaderForTests(() => Promise.resolve(drive.service));

    const cfg = resolveUploads({ avatars: { storage: 'builtin' } });
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);

    assert.include(url!, 'https://cdn.test/authkit/avatars/acc-1-');
    assert.lengthOf(media.stores, 0);
  });

  test("storage 'media' sem o pacote (loader null) → degrada para null", async ({ assert }) => {
    __setMediaLoaderForTests(() => Promise.resolve(null));
    __setDriveLoaderForTests(() => Promise.resolve(fakeDrive().service));

    const cfg = resolveUploads({ avatars: { storage: 'media' } });
    const file = fakeFile();
    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);

    // 'media' NÃO cai no drive — degrada para URL (null).
    assert.isNull(url);
  });

  test('config de uploads resolve os defaults do seam de media', ({ assert }) => {
    const cfg = resolveUploads();
    assert.equal(cfg.avatars.storage, 'auto');
    assert.equal(cfg.avatars.collection, 'avatar');
    assert.equal(cfg.avatars.ownerType, 'AuthAccount');
    assert.equal(cfg.avatars.directory, 'authkit/avatars');
    assert.equal(cfg.avatars.maxSizeMb, 5);

    const custom = resolveUploads({
      avatars: { storage: 'media', collection: 'pfp', ownerType: 'Profile' },
    });
    assert.equal(custom.avatars.storage, 'media');
    assert.equal(custom.avatars.collection, 'pfp');
    assert.equal(custom.avatars.ownerType, 'Profile');
  });

  test('isAvatarUploadSupported: auto + media disponível + drive ausente → true', async ({
    assert,
  }) => {
    const media = fakeMedia();
    __setMediaLoaderForTests(() => Promise.resolve(media.module));
    __setDriveLoaderForTests(() => Promise.resolve(null));

    const cfg = resolveUploads();
    assert.isTrue(await isAvatarUploadSupported(cfg));
  });

  test('isAvatarUploadSupported: builtin + drive ausente → false', async ({ assert }) => {
    // media presente para provar que 'builtin' NÃO o consulta.
    __setMediaLoaderForTests(() => Promise.resolve(fakeMedia().module));
    __setDriveLoaderForTests(() => Promise.resolve(null));

    const cfg = resolveUploads({ avatars: { storage: 'builtin' } });
    assert.isFalse(await isAvatarUploadSupported(cfg));
  });

  test("storage 'builtin' sem drive + ext inválida → retorna null (NÃO lança)", async ({
    assert,
  }) => {
    // Backend resolvido PRIMEIRO: sem drive → degrada para null antes de validar.
    __setDriveLoaderForTests(() => Promise.resolve(null));
    __setMediaLoaderForTests(() => Promise.resolve(null));

    const cfg = resolveUploads({ avatars: { storage: 'builtin' } });
    const file = fakeFile({ extname: 'gif' });

    const url = await storeAvatar(ctx, cfg, file as any, 'acc-1', msgs);
    assert.isNull(url);
  });

  test('view mostra input de arquivo quando avatarUploadSupported', async ({ assert }) => {
    const edge = makeEdge();
    const html = await edge.renderRaw(readView('account/security.edge'), {
      csrfToken: 'x',
      supported: true,
      profileSupported: true,
      avatarUploadSupported: true,
      email: 'a@b.com',
      name: 'Ana',
      avatarUrl: 'https://cdn.test/a.png',
    });
    assert.include(html, 'name="avatar" type="file"');
    assert.include(html, 'enctype="multipart/form-data"');
    assert.include(html, translate({ ...DEFAULT_MESSAGES }, 'account.profile.avatar_upload_label'));
    // thumbnail do avatar atual.
    assert.include(html, 'https://cdn.test/a.png');
  });

  test('view esconde input de arquivo quando drive ausente', async ({ assert }) => {
    const edge = makeEdge();
    const html = await edge.renderRaw(readView('account/security.edge'), {
      csrfToken: 'x',
      supported: true,
      profileSupported: true,
      avatarUploadSupported: false,
      email: 'a@b.com',
      name: 'Ana',
      avatarUrl: '',
    });
    assert.notInclude(html, 'name="avatar" type="file"');
    // input de URL continua disponível (path de degradação).
    assert.include(html, 'name="avatarUrl"');
  });
});
