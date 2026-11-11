import { test } from '@japa/runner';
import { adminGuard } from '../../src/host/register_auth_host.js';

/**
 * Fake ctx mínimo para exercitar o adminGuard. `sessionUserId` controla a sessão;
 * `account` é o que o accountStore.findById resolve; `adminRoles` são as roles
 * permitidas pelo config; `requestUrl` simula o caminho atual (para return_to).
 * Captura o redirect e se o `next()` foi chamado.
 */
function fakeCtx(opts: {
  sessionUserId?: string;
  account?: { id: string; email: string; globalRoles?: string[] } | null;
  adminRoles?: string[];
  adminEnabled?: boolean;
  requestUrl?: string;
  json?: boolean;
  authorize?: unknown;
  resolveTokenRoles?: (
    account: { id: string; email: string; globalRoles?: string[] },
    context: unknown,
  ) => string[] | Promise<string[]>;
}) {
  const redirects: string[] = [];
  const sent: Array<{ status: number; body: unknown }> = [];
  let status = 200;
  let notFoundCalled = false;
  const ctx = {
    session: { get: (_k: string) => opts.sessionUserId },
    request: {
      url: () => opts.requestUrl ?? '',
      parsedUrl: { search: '' },
      accepts: () => (opts.json ? 'json' : 'html'),
    },
    response: {
      redirect: (to: string) => redirects.push(to),
      status(code: number) {
        status = code;
        return this;
      },
      send: (body: unknown) => sent.push({ status, body }),
      notFound: () => {
        notFoundCalled = true;
      },
    },
    containerResolver: {
      make: async (key: unknown) =>
        typeof key === 'function'
          ? new (key as any)()
          : {
              config: {
                admin: {
                  enabled: opts.adminEnabled ?? true,
                  roles: opts.adminRoles ?? ['ADMIN'],
                  authorize: opts.authorize ?? null,
                },
                accountStore: {
                  findById: async (_id: string) => opts.account ?? null,
                },
                resolveTokenRoles: opts.resolveTokenRoles,
              },
            },
    },
  } as any;
  return { ctx, redirects, sent, notFound: () => notFoundCalled };
}

test.group('adminGuard', () => {
  test('sem sessão → redireciona para /account/login', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({});
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/login']);
  });

  test('sem sessão com URL atual → inclui return_to no redirect', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({ requestUrl: '/admin/users' });
    await adminGuard(ctx, async () => {});
    assert.lengthOf(redirects, 1);
    assert.include(redirects[0], '/account/login');
    assert.include(redirects[0], 'return_to=%2Fadmin%2Fusers');
  });

  test('sessão com role admin → chama next()', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u1',
      account: { id: 'u1', email: 'a@x.com', globalRoles: ['ADMIN'] },
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
    assert.lengthOf(redirects, 0);
  });

  test('sessão sem role admin → redireciona para /account/tokens', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u2',
      account: { id: 'u2', email: 'b@x.com', globalRoles: ['VIEWER'] },
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/security']);
  });

  test('respeita roles customizadas do config', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u3',
      account: { id: 'u3', email: 'c@x.com', globalRoles: ['STAFF'] },
      adminRoles: ['STAFF', 'ROOT'],
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
    assert.lengthOf(redirects, 0);
  });

  test('admin.enabled:false → 404 mesmo com sessão admin (flag-drift safety net)', async ({
    assert,
  }) => {
    const { ctx, redirects, notFound } = fakeCtx({
      adminEnabled: false,
      sessionUserId: 'u1',
      account: { id: 'u1', email: 'a@x.com', globalRoles: ['ADMIN'] },
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.isTrue(notFound());
    assert.lengthOf(redirects, 0);
  });

  test('resolveTokenRoles governa o acesso — app-admin (sem globalRoles) entra no console', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u5',
      account: { id: 'u5', email: 'e@x.com', globalRoles: [] },
      resolveTokenRoles: async () => ['ADMIN'],
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
    assert.lengthOf(redirects, 0);
  });

  test('resolveTokenRoles é autoritativo — globalRoles ADMIN não basta se o hook não devolve ADMIN', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u6',
      account: { id: 'u6', email: 'f@x.com', globalRoles: ['ADMIN'] },
      resolveTokenRoles: async () => ['VIEWER'],
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/security']);
  });

  test('conta sem roles → rejeitado', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({
      sessionUserId: 'u4',
      account: { id: 'u4', email: 'd@x.com' },
    });
    let nextCalled = false;
    await adminGuard(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/security']);
  });
});

test.group('adminGuard | admin.authorize', () => {
  const admin = { id: 'u1', email: 'a@x.com', globalRoles: ['ADMIN'] };

  async function run(opts: Parameters<typeof fakeCtx>[0]) {
    const out = fakeCtx({ sessionUserId: 'u1', account: admin, ...opts });
    let nextCalled = false;
    await adminGuard(out.ctx, async () => {
      nextCalled = true;
    });
    return { ...out, nextCalled };
  }

  test('omitted → roles alone decide', async ({ assert }) => {
    const { nextCalled } = await run({});
    assert.isTrue(nextCalled);
  });

  test('allowed → next()', async ({ assert }) => {
    const { nextCalled, redirects } = await run({ authorize: async () => ({ allowed: true }) });
    assert.isTrue(nextCalled);
    assert.lengthOf(redirects, 0);
  });

  test('runs after roles: not called for a non-admin', async ({ assert }) => {
    let called = false;
    const { nextCalled, redirects } = await run({
      account: { id: 'u1', email: 'a@x.com', globalRoles: ['VIEWER'] },
      authorize: () => {
        called = true;
        return true;
      },
    });
    assert.isFalse(nextCalled);
    assert.isFalse(called);
    assert.deepEqual(redirects, ['/account/security']);
  });

  test('denied page navigation → accountHome', async ({ assert }) => {
    const { nextCalled, redirects } = await run({ authorize: () => false });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/security']);
  });

  test('denied JSON call → 403', async ({ assert }) => {
    const { nextCalled, sent } = await run({ json: true, authorize: () => false });
    assert.isFalse(nextCalled);
    assert.equal(sent[0]?.status, 403);
  });

  test('unauthenticated JSON call → 401', async ({ assert }) => {
    const { sent } = await run({
      json: true,
      authorize: () => ({ allowed: false, reason: 'unauthenticated' }),
    });
    assert.equal(sent[0]?.status, 401);
  });

  test('redirectTo → 302 on a page, 401 on JSON', async ({ assert }) => {
    const page = await run({ authorize: () => ({ redirectTo: '/step-up' }) });
    assert.deepEqual(page.redirects, ['/step-up']);
    const api = await run({ json: true, authorize: () => ({ redirectTo: '/step-up' }) });
    assert.lengthOf(api.redirects, 0);
    assert.equal(api.sent[0]?.status, 401);
  });

  test('class form is built through the container', async ({ assert }) => {
    class Access {
      authorize(ctx: any) {
        return ctx.session.get('k') === 'u1';
      }
    }
    const { nextCalled } = await run({ authorize: Access });
    assert.isTrue(nextCalled);
  });

  test('a throwing authorize denies', async ({ assert }) => {
    const { nextCalled, sent } = await run({
      json: true,
      authorize: () => {
        throw new Error('boom');
      },
    });
    assert.isFalse(nextCalled);
    assert.equal(sent[0]?.status, 403);
  });
});
