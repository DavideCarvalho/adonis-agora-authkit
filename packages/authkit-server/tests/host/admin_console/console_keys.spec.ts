import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../../../src/define_config.js';
import ConsoleKeysController from '../../../src/host/admin_console/console_keys_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../../src/host/middleware/account_auth.js';
import { adminGuard } from '../../../src/host/register_auth_host.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../../src/host/sudo_mode.js';
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
 * Fake ctx para os controllers do console admin. `service` é resolvido para
 * `authkit.server`; `lucid.db` lança (sem DB nos testes), então
 * `resolveRuntimeSettings` retorna null → política default (rotação off).
 * Captura status/body das respostas de erro.
 */
function fakeCtx(opts: {
  service?: any;
  body?: any;
  sessionUserId?: string;
  adminRoles?: string[];
  /**
   * Simula sudo mode CONFIRMADO (M9) para este `sessionUserId`. Sem isto,
   * `ConsoleKeysController.rotate` responde 403 `sudo_required` — ver o teste
   * dedicado abaixo.
   */
  sudoConfirmed?: boolean;
}) {
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
      url: () => '/admin/api/keys/rotate',
      parsedUrl: { search: '' },
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
      redirect: (url: string) => {
        status = 302;
        body = { redirect: url };
        return undefined;
      },
    },
    session: {
      get: (k: string) => {
        if (k === ACCOUNT_SESSION_KEY) return opts.sessionUserId;
        if (!opts.sudoConfirmed || !opts.sessionUserId) return undefined;
        if (k === SUDO_SESSION_KEY) return Date.now();
        if (k === SUDO_ACCOUNT_SESSION_KEY) return opts.sessionUserId;
        return undefined;
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
      clients: [],
      accountStore: fakeAccountStore(),
      admin: { enabled: true, roles: ['ADMIN'] },
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

test.group('Console API /keys (session-authed)', (group) => {
  let dir: string;
  let path: string;
  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'authkit-consolekeys-'));
    path = join(dir, 'jwks.json');
    return () => rmSync(dir, { recursive: true, force: true });
  });

  // ─── status ────────────────────────────────────────────────────────────────

  test('GET {ap}/api/keys → 200 com ageDays numérico e policy.enabled false', async ({
    assert,
  }) => {
    const { service, m } = await makeService(path, 9980);
    const ctrl = new ConsoleKeysController();
    const res: any = await ctrl.status(fakeCtx({ service }).ctx);
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

  test('GET {ap}/api/keys → após rotação keep:2, lista 2 chaves só a primeira ativa', async ({
    assert,
  }) => {
    const { service, m } = await makeService(path, 9985);
    const ctrl = new ConsoleKeysController();
    await service.rotateKeys(2);
    const res: any = await ctrl.status(fakeCtx({ service }).ctx);
    const store = (await m.read())!;
    assert.lengthOf(res.keys, 2);
    assert.equal(res.keys[0].kid, store.keys[0].kid);
    assert.isTrue(res.keys[0].active);
    assert.isFalse(res.keys[1].active);
  });

  test('GET {ap}/api/keys → 501 quando jwks não é managed+store', async ({ assert }) => {
    // svc sem keystoreManager → keystoreAgeDays() retorna null.
    const svc = { keystoreAgeDays: async () => null };
    const ctrl = new ConsoleKeysController();
    const { ctx, captured } = fakeCtx({ service: svc });
    await ctrl.status(ctx);
    assert.equal(captured.status(), 501);
    assert.equal(captured.body().error.code, 'not_implemented');
  });

  // ─── rotate ────────────────────────────────────────────────────────────────

  test('POST {ap}/api/keys/rotate → rotated:true e novo kid', async ({ assert }) => {
    const { service, m } = await makeService(path, 9981);
    const ctrl = new ConsoleKeysController();

    const before = (await m.read())!;
    const beforeKids = before.keys.map((k: any) => k.kid);

    const rotated: any = await ctrl.rotate(
      fakeCtx({ service, body: {}, sessionUserId: 'admin-1', sudoConfirmed: true }).ctx,
    );
    assert.equal(rotated.rotated, true);
    assert.isString(rotated.newKid);
    assert.notInclude(beforeKids, rotated.newKid);

    // O keystore mudou: o novo kid está presente.
    const after = (await m.read())!;
    const afterKids = after.keys.map((k: any) => k.kid);
    assert.include(afterKids, rotated.newKid);
    assert.isAbove(afterKids.length, 0);
  });

  test('POST {ap}/api/keys/rotate → 501 quando jwks não é managed+store', async ({ assert }) => {
    const svc = { keystoreAgeDays: async () => null };
    const ctrl = new ConsoleKeysController();
    const { ctx, captured } = fakeCtx({ service: svc });
    await ctrl.rotate(ctx);
    assert.equal(captured.status(), 501);
    assert.equal(captured.body().error.code, 'not_implemented');
  });

  test('POST {ap}/api/keys/rotate — sudo (M9): sem confirmação recente → 403 sudo_required', async ({
    assert,
  }) => {
    // Capability suportada (managed+store) e sessão de admin válida, mas SEM
    // sudo confirmado — o gate tem de barrar antes de tocar no keystore.
    const { service, m } = await makeService(path, 9986);
    const ctrl = new ConsoleKeysController();

    const before = (await m.read())!;
    const { ctx, captured } = fakeCtx({ service, body: {}, sessionUserId: 'admin-1' });
    await ctrl.rotate(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'sudo_required');
    // Nada rotacionou: o keystore continua como estava.
    const after = (await m.read())!;
    assert.deepEqual(
      after.keys.map((k: any) => k.kid),
      before.keys.map((k: any) => k.kid),
    );
  });

  // ─── adminGuard barrier ────────────────────────────────────────────────────

  test('sem sessão → adminGuard redireciona para /account/login', async ({ assert }) => {
    const { service } = await makeService(path, 9982);
    // Monta um ctx que simula adminGuard: sem sessão (sessionUserId undefined).
    const { ctx, captured } = fakeCtx({ service, sessionUserId: undefined });
    let nexted = false;
    await adminGuard(ctx, async () => {
      nexted = true;
    });
    assert.isFalse(nexted);
    // O adminGuard faz redirect (302) para o login.
    assert.equal(captured.status(), 302);
  });

  test('sessão sem role admin → adminGuard não deixa passar', async ({ assert }) => {
    const { service } = await makeService(path, 9983);
    // Sobrescreve findById para retornar uma conta SEM role ADMIN.
    const noAdminService = {
      ...service,
      config: {
        ...service.config,
        admin: { enabled: true, roles: ['ADMIN'] },
        accountStore: {
          ...service.config.accountStore,
          findById: async (_id: string) => ({
            id: _id,
            email: 'noadmin@example.com',
            globalRoles: [],
          }),
        },
      },
    };
    const { ctx, captured } = fakeCtx({ service: noAdminService, sessionUserId: 'some-user-id' });
    let nexted = false;
    await adminGuard(ctx, async () => {
      nexted = true;
    });
    assert.isFalse(nexted);
    // Redireciona (não vaza a existência do console admin).
    assert.equal(captured.status(), 302);
  });

  test('sessão com role admin → adminGuard deixa passar', async ({ assert }) => {
    const { service } = await makeService(path, 9984);
    const account = await service.config.accountStore.create({
      email: 'admin@example.com',
      password: 'pw',
      globalRoles: ['ADMIN'],
    });
    const { ctx } = fakeCtx({ service, sessionUserId: account.id });
    let nexted = false;
    await adminGuard(ctx, async () => {
      nexted = true;
    });
    assert.isTrue(nexted);
  });
});
