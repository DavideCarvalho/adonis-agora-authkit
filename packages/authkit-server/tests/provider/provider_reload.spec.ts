import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProvider } from '@adonisjs/core';
// tests/provider/provider_reload.spec.ts
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from 'jose';
import { adapters, defineConfig } from '../../src/define_config.js';
import { toPublicJwks } from '../../src/keys/keystore.js';
import { KeystoreCodec } from '../../src/keys/keystore_codec.js';
import { KeystoreManager } from '../../src/keys/keystore_manager.js';
import { FileKeystoreVault } from '../../src/keys/keystore_vault.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../bootstrap.js';

function mgr(path: string) {
  return new KeystoreManager(
    new FileKeystoreVault(path),
    new KeystoreCodec({ encrypt: false }),
    'RS256',
  );
}
async function sign(jwk: Record<string, any>, sub: string) {
  const key = await importJWK(jwk, jwk.alg);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: jwk.alg, kid: jwk.kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

test.group('hot-reload viabilidade (jose)', (group) => {
  let dir: string;
  let path: string;
  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'authkit-reload-'));
    path = join(dir, 'jwks.json');
    return () => rmSync(dir, { recursive: true, force: true });
  });

  test('pós-rotação: JWKS público novo valida token novo E token antigo (overlap)', async ({
    assert,
  }) => {
    const m = mgr(path);
    const before = await m.ensure();
    const tokenOld = await sign(before.keys[0], 'u-old');

    // "reload": rotaciona no cofre e relê o keystore (o que reloadKeys fará)
    await m.rotate(2);
    const after = await m.read();
    const tokenNew = await sign(after!.keys[0], 'u-new');

    // o JWKS público pós-reload contém AMBAS as chaves (grace) → ambos validam
    const jwkSet = createLocalJWKSet(toPublicJwks(after!) as any);
    assert.equal((await jwtVerify(tokenOld, jwkSet)).payload.sub, 'u-old');
    assert.equal((await jwtVerify(tokenNew, jwkSet)).payload.sub, 'u-new');

    // e o kid corrente (de assinatura) mudou
    assert.notEqual(after!.keys[0].kid, before.keys[0].kid);
  });
});

test.group('OidcService.reloadKeys (e2e)', (group) => {
  let dir: string;
  let path: string;
  let server: Server;
  let service: OidcService;
  const PORT = 9791;
  const ISSUER = `http://localhost:${PORT}`;

  group.each.setup(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authkit-svc-'));
    path = join(dir, 'jwks.json');
    const m = mgr(path);
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
      makePath: (p: string) => p,
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256', store: path, encrypt: false },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ISSUER}/cb`],
            grants: ['authorization_code'],
          },
        ],
        accountStore: fakeAccountStore(),
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32), undefined, {
      jwksLoader: async () => {
        const s = (await m.read())!;
        return { keys: s.keys.map(({ iat, ...j }: any) => j) };
      },
      keystoreHead: () => m.head(),
    });
    server = createServer((req, res) => service.callback(req, res));
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    };
  });

  test('reloadKeys publica o kid novo mantendo o antigo (overlap) ao vivo', async ({ assert }) => {
    const fetchKids = async () => {
      const disco = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
      const jwks = await (await fetch(disco.jwks_uri)).json();
      return jwks.keys.map((k: any) => k.kid);
    };

    const before = await fetchKids();
    assert.lengthOf(before, 1);

    // rotaciona no cofre e recarrega AO VIVO (sem recriar o service)
    await mgr(path).rotate(2);
    await service.reloadKeys();

    const after = await fetchKids();
    assert.lengthOf(after, 2); // overlap: 2 chaves publicadas
    assert.include(after, before[0]); // a antiga continua publicada
    assert.notDeepEqual(after, before); // mudou
  });

  test('reloadKeys sem jwksLoader é no-op (não lança)', async ({ assert }) => {
    const fakeApp2 = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
      makePath: (p: string) => p,
    } as any;
    const svc = new OidcService(
      (await configProvider.resolve(
        fakeApp2,
        defineConfig({
          issuer: `http://localhost:${PORT + 1}`,
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256' },
          clients: [],
          accountStore: fakeAccountStore(),
        }),
      ))!,
      'a'.repeat(32),
    );
    await svc.reloadKeys(); // no jwksLoader → no-op
    assert.isOk(svc.provider);
  });
});

test.group('OidcService.reloadKeys (atomicidade)', () => {
  test('reloadKeys: loader que lança NÃO troca o provider (atômico)', async ({ assert }) => {
    const dir2 = mkdtempSync(join(tmpdir(), 'authkit-atomic-'));
    const path2 = join(dir2, 'jwks.json');
    try {
      const m = mgr(path2);
      await m.ensure();
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
        makePath: (p: string) => p,
      } as any;
      const cfg = await configProvider.resolve(
        fakeApp,
        defineConfig({
          issuer: 'http://localhost:9792',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256', store: path2, encrypt: false },
          clients: [],
          accountStore: fakeAccountStore(),
        }),
      );
      const svc = new OidcService(cfg!, 'a'.repeat(32), undefined, {
        jwksLoader: async () => {
          throw new Error('loader boom');
        },
        keystoreHead: () => m.head(),
      });
      const providerBefore = svc.provider;
      await assert.rejects(() => svc.reloadKeys(), /loader boom/);
      assert.strictEqual(svc.provider, providerBefore); // mesma instância — não trocou
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

test.group('OidcService reload serialization + age', () => {
  test('reloadKeys concorrentes não constroem providers sobrepostos (serializado)', async ({
    assert,
  }) => {
    const dirX = mkdtempSync(join(tmpdir(), 'authkit-ser-'));
    const pathX = join(dirX, 'jwks.json');
    try {
      const m = mgr(pathX);
      await m.ensure();
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
        makePath: (p: string) => p,
      } as any;
      const cfg = await configProvider.resolve(
        fakeApp,
        defineConfig({
          issuer: 'http://localhost:9793',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256', store: pathX, encrypt: false },
          clients: [],
          accountStore: fakeAccountStore(),
        }),
      );
      let building = 0;
      let maxConcurrent = 0;
      const svc = new OidcService(cfg!, 'a'.repeat(32), undefined, {
        jwksLoader: async () => {
          building++;
          maxConcurrent = Math.max(maxConcurrent, building);
          await new Promise((r) => setTimeout(r, 20));
          building--;
          const s = (await m.read())!;
          return { keys: s.keys.map(({ iat, ...j }) => j) };
        },
        keystoreHead: () => m.head(),
      });
      await Promise.all([svc.reloadKeys(), svc.reloadKeys(), svc.reloadKeys()]);
      assert.equal(maxConcurrent, 1);
    } finally {
      rmSync(dirX, { recursive: true, force: true });
    }
  });

  test('keystoreAgeDays reflete a idade (0 recém-criada)', async ({ assert }) => {
    const dirY = mkdtempSync(join(tmpdir(), 'authkit-age-'));
    const pathY = join(dirY, 'jwks.json');
    try {
      const m = mgr(pathY);
      await m.ensure();
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
        makePath: (p: string) => p,
      } as any;
      const cfg = await configProvider.resolve(
        fakeApp,
        defineConfig({
          issuer: 'http://localhost:9794',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256', store: pathY, encrypt: false },
          clients: [],
          accountStore: fakeAccountStore(),
        }),
      );
      const svc = new OidcService(cfg!, 'a'.repeat(32), undefined, {
        jwksLoader: async () => {
          const s = (await m.read())!;
          return { keys: s.keys.map(({ iat, ...j }) => j) };
        },
        keystoreHead: () => m.head(),
        keystoreManager: async () => m,
      });
      assert.equal(await svc.keystoreAgeDays(), 0);
    } finally {
      rmSync(dirY, { recursive: true, force: true });
    }
  });

  test('rotateKeys concorrentes não perdem rotação (serializado)', async ({ assert }) => {
    const dirR = mkdtempSync(join(tmpdir(), 'authkit-rr-'));
    const pathR = join(dirR, 'jwks.json');
    try {
      const m = mgr(pathR);
      await m.ensure();
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
        makePath: (p: string) => p,
      } as any;
      const cfg = await configProvider.resolve(
        fakeApp,
        defineConfig({
          issuer: 'http://localhost:9796',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256', store: pathR, encrypt: false },
          clients: [],
          accountStore: fakeAccountStore(),
        }),
      );
      const svc = new OidcService(cfg!, 'a'.repeat(32), undefined, {
        jwksLoader: async () => {
          const s = (await m.read())!;
          return { keys: s.keys.map(({ iat, ...j }) => j) };
        },
        keystoreHead: () => m.head(),
        keystoreManager: async () => m,
      });
      const [r1, r2] = await Promise.all([svc.rotateKeys(5), svc.rotateKeys(5)]);
      const after = (await m.read())!;
      const kids = after.keys.map((k: any) => k.kid);
      // ambas as rotações persistiram (nenhuma perdida): os dois newKids estão no keystore
      assert.include(kids, r1.newKid);
      assert.include(kids, r2.newKid);
      assert.notEqual(r1.newKid, r2.newKid);
    } finally {
      rmSync(dirR, { recursive: true, force: true });
    }
  });

  test('rotateKeys rotaciona, aplica ao vivo e audita', async ({ assert }) => {
    const dirZ = mkdtempSync(join(tmpdir(), 'authkit-rot-'));
    const pathZ = join(dirZ, 'jwks.json');
    try {
      const m = mgr(pathZ);
      const before = await m.ensure();
      const audits: any[] = [];
      const fakeApp = {
        container: { make: async () => ({ connection: () => new RedisMock() }) },
        makePath: (p: string) => p,
      } as any;
      const cfg = await configProvider.resolve(
        fakeApp,
        defineConfig({
          issuer: 'http://localhost:9795',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256', store: pathZ, encrypt: false },
          clients: [],
          accountStore: fakeAccountStore(),
          audit: {
            record: async (e: any) => {
              audits.push(e);
            },
          } as any,
        }),
      );
      const svc = new OidcService(cfg!, 'a'.repeat(32), undefined, {
        jwksLoader: async () => {
          const s = (await m.read())!;
          return { keys: s.keys.map(({ iat, ...j }) => j) };
        },
        keystoreHead: () => m.head(),
        keystoreManager: async () => m,
      });
      const res = await svc.rotateKeys(2);
      assert.notEqual(res.newKid, before.keys[0].kid);
      const after = (await m.read())!;
      assert.equal(after.keys[0].kid, res.newKid); // persistiu a rotação
      assert.isTrue(audits.some((a) => a.type === 'keys.rotated')); // auditou
    } finally {
      rmSync(dirZ, { recursive: true, force: true });
    }
  });
});
