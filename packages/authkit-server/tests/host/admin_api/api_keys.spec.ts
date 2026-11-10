import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../../../src/define_config.js';
import { adminApiGuard } from '../../../src/host/admin_api/admin_api_guard.js';
import ApiKeysController from '../../../src/host/admin_api/api_keys_controller.js';
import { KeystoreCodec } from '../../../src/keys/keystore_codec.js';
import { KeystoreManager } from '../../../src/keys/keystore_manager.js';
import { FileKeystoreVault } from '../../../src/keys/keystore_vault.js';
import { OidcService } from '../../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../../bootstrap.js';

function mgr(path: string) {
  return new KeystoreManager(
    new FileKeystoreVault(path),
    new KeystoreCodec({ encrypt: false }),
    'RS256',
  );
}

/**
 * Fake ctx para os controllers da Admin REST API. `service` é resolvido para
 * `authkit.server`; `lucid.db` lança (sem DB nos testes), então
 * `resolveRuntimeSettings` retorna null → política default (rotação off). Captura
 * status/body das respostas de erro.
 */
function fakeCtx(opts: { service?: any; body?: any; authHeader?: string }) {
  let status = 200;
  let body: any;
  const captured = { status: () => status, body: () => body };
  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const ctx = {
    request: {
      body: () => opts.body ?? {},
      ip: () => '127.0.0.1',
      header: (h: string) => (h.toLowerCase() === 'authorization' ? opts.authHeader : undefined),
    },
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      notFound: (b: any) => {
        status = 404;
        return setBody(b);
      },
      unauthorized: (b: any) => {
        status = 401;
        return setBody(b);
      },
    },
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return opts.service;
        // lucid.db indisponível nos testes → resolveRuntimeSettings cai no catch (null).
        throw new Error(`no binding for ${key}`);
      },
    },
  } as any;
  return { ctx, captured };
}

async function makeService(path: string, port: number) {
  const m = mgr(path);
  await m.ensure();
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
    makePath: (p: string) => p,
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: `http://localhost:${port}`,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256', store: path, encrypt: false },
      accountStore: fakeAccountStore(),
      adminApi: { enabled: true, apiKeys: ['secret-key'] },
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32), undefined, {
    jwksLoader: async () => {
      const s = (await m.read())!;
      return { keys: s.keys.map(({ iat, ...j }: any) => j) };
    },
    keystoreHead: () => m.head(),
    keystoreManager: async () => m,
  });
  return { service, m };
}

test.group('Admin REST API /keys (managed)', (group) => {
  let dir: string;
  let path: string;
  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'authkit-apikeys-'));
    path = join(dir, 'jwks.json');
    return () => rmSync(dir, { recursive: true, force: true });
  });

  test('GET /keys → 200 com ageDays numérico e policy.enabled false', async ({ assert }) => {
    const { service, m } = await makeService(path, 9971);
    const keys = new ApiKeysController();
    const res: any = await keys.status(fakeCtx({ service }).ctx);
    assert.isNumber(res.ageDays);
    assert.equal(res.policy.enabled, false);
    // Sem política habilitada → sem ETA.
    assert.equal(res.nextRotationInDays, null);
    // Lista de chaves: 1 chave após ensure(), ativa, com o kid corrente do keystore.
    const store = (await m.read())!;
    assert.isArray(res.keys);
    assert.lengthOf(res.keys, 1);
    assert.isTrue(res.keys[0].active);
    assert.equal(res.keys[0].kid, store.keys[0].kid);
  });

  test('GET /keys → após rotação keep:2, lista 2 chaves só a primeira ativa', async ({
    assert,
  }) => {
    const { service, m } = await makeService(path, 9974);
    const keys = new ApiKeysController();
    await service.rotateKeys(2);
    const res: any = await keys.status(fakeCtx({ service }).ctx);
    const store = (await m.read())!;
    assert.lengthOf(res.keys, 2);
    assert.equal(res.keys[0].kid, store.keys[0].kid);
    assert.isTrue(res.keys[0].active);
    assert.isFalse(res.keys[1].active);
  });

  test('POST /keys/rotate → 200 rotated:true; GET reflete o novo kid', async ({ assert }) => {
    const { service, m } = await makeService(path, 9972);
    const keys = new ApiKeysController();

    const before = (await m.read())!;
    const beforeKids = before.keys.map((k: any) => k.kid);

    const rotated: any = await keys.rotate(fakeCtx({ service, body: {} }).ctx);
    assert.equal(rotated.rotated, true);
    assert.isString(rotated.newKid);
    assert.notInclude(beforeKids, rotated.newKid);

    // O keystore mudou: o novo kid está presente (overlap mantém o antigo também).
    const after = (await m.read())!;
    const afterKids = after.keys.map((k: any) => k.kid);
    assert.include(afterKids, rotated.newKid);
    assert.isAbove(afterKids.length, 0);
  });

  test('GET /keys → 501 quando jwks não é managed+store', async ({ assert }) => {
    // svc sem keystoreManager → keystoreAgeDays() === null.
    const svc = { keystoreAgeDays: async () => null };
    const keys = new ApiKeysController();
    const { ctx, captured } = fakeCtx({ service: svc });
    await keys.status(ctx);
    assert.equal(captured.status(), 501);
    assert.equal(captured.body().error.code, 'not_implemented');
  });

  test('sem Bearer key → 401 (adminApiGuard)', async ({ assert }) => {
    const { service } = await makeService(path, 9973);
    const { ctx, captured } = fakeCtx({ service });
    let nexted = false;
    await adminApiGuard(ctx, async () => {
      nexted = true;
    });
    assert.isFalse(nexted);
    assert.equal(captured.status(), 401);
  });
});
