import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { buildPersonalAgentsRuntime } from '../../src/agents/runtime.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import ConsolePersonalAgentsController from '../../src/host/admin_console/console_personal_agents_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

const ADMIN_ID = 'admin-1';

/** Ctx falso do console: `authkit.server` e `lucid.db` do ambiente; sudo opcional. */
function consoleCtx(
  service: any,
  db: any,
  opts: {
    body?: any;
    params?: Record<string, string>;
    qs?: Record<string, string>;
    sudo?: boolean;
  } = {},
) {
  let status = 200;
  let body: any;
  const set = (s: number) => (b: any) => {
    status = s;
    body = b;
    return b;
  };
  const audit: any[] = [];
  service.config.audit = { record: async (e: any) => audit.push(e) };
  const ctx = {
    request: {
      body: () => opts.body ?? {},
      param: (k: string) => opts.params?.[k],
      qs: () => opts.qs ?? {},
      ip: () => '127.0.0.1',
      url: () => '/admin/api/personal-agents',
      parsedUrl: { search: '' },
    },
    response: {
      status: (s: number) => ({ send: set(s) }),
      notFound: set(404),
      unprocessableEntity: set(422),
      redirect: () => undefined,
    },
    session: {
      get: (k: string) => {
        if (k === ACCOUNT_SESSION_KEY) return ADMIN_ID;
        if (!opts.sudo) return undefined;
        if (k === SUDO_SESSION_KEY) return Date.now();
        if (k === SUDO_ACCOUNT_SESSION_KEY) return ADMIN_ID;
        return undefined;
      },
    },
    containerResolver: {
      make: async (k: string) => {
        if (k === 'authkit.server') return service;
        if (k === 'lucid.db') return db;
        throw new Error(`no binding for ${k}`);
      },
    },
  } as any;
  return { ctx, status: () => status, body: () => body, audit };
}

const controller = new ConsolePersonalAgentsController();

test.group('console admin — personal agents (PACT)', () => {
  async function setupPact(agents: { issuer: string; jwksUri: string }[] = []) {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://shop.example/oidc',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'ES256' },
        accountStore: { findById: async () => null } as any,
        personalAgents: { audience: 'shop', agents },
      }),
    );
    const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
    const db = createTestDatabase();
    await ensureAuthkitSchema(db);
    const runtime = (await buildPersonalAgentsRuntime(service, async () => db))!;
    return { service, db, runtime };
  }

  test('PACT só de identidade: o console libera (com JWKS) e bloqueia por cima do config', async ({
    assert,
  }) => {
    const listed = { issuer: 'https://listed.example', jwksUri: 'https://listed.example/jwks' };
    const { service, db, runtime } = await setupPact([listed]);
    const resolve = runtime.config.resolveAgent;
    assert.isNull(await resolve('https://new.example'));

    const noJwks = consoleCtx(service, db, {
      body: { protocol: 'pact', identifier: 'https://new.example', status: 'allowed' },
      sudo: true,
    });
    await controller.upsert(noJwks.ctx);
    assert.equal(noJwks.status(), 422);

    await controller.upsert(
      consoleCtx(service, db, {
        body: {
          protocol: 'pact',
          identifier: 'https://new.example',
          status: 'allowed',
          jwksUri: 'https://new.example/jwks',
          name: 'New',
        },
        sudo: true,
      }).ctx,
    );
    assert.deepEqual(await resolve('https://new.example'), {
      issuer: 'https://new.example',
      jwksUri: 'https://new.example/jwks',
      name: 'New',
    });

    await controller.upsert(
      consoleCtx(service, db, {
        body: { protocol: 'pact', identifier: listed.issuer, status: 'blocked' },
        sudo: true,
      }).ctx,
    );
    assert.isFalse((await resolve(listed.issuer))!.enabled);

    const overview: any = await controller.index(consoleCtx(service, db).ctx);
    assert.deepEqual(overview.protocols.pact, { open: false, hostResolver: false });
    const byId = Object.fromEntries(overview.agents.map((a: any) => [a.identifier, a]));
    assert.include(byId[listed.issuer], { config: 'allowed', effective: 'blocked' });
    assert.include(byId['https://new.example'], { config: null, effective: 'allowed' });
    await db.manager.closeAll();
  });

  test('sem `personalAgents`: 404 capability_unsupported', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://shop.example/oidc',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'ES256' },
        accountStore: { findById: async () => null } as any,
      }),
    );
    const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
    const ctx = consoleCtx(service, createTestDatabase());
    await controller.index(ctx.ctx);
    assert.equal(ctx.status(), 404);
    assert.equal(ctx.body().error.code, 'capability_unsupported');
  });
});
