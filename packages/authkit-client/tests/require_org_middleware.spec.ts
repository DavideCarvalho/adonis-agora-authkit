import { test } from '@japa/runner';
import RequireOrgMiddleware from '../src/middleware/require_org_middleware.js';

function fakeCtx(identity: any) {
  const redirects: string[] = [];
  let aborted: { body: unknown; status: number } | null = null;
  const ctx = {
    auth: { getIdentity: async () => identity },
    response: {
      redirect: (to: string) => {
        redirects.push(to);
        return to;
      },
      abort: (body: unknown, status: number) => {
        aborted = { body, status };
        return body;
      },
    },
    request: { accepts: () => 'html' },
  } as any;
  return { ctx, redirects, getAborted: () => aborted };
}

test.group('RequireOrgMiddleware', () => {
  test('segue adiante quando a sessão tem org ativa', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({ userId: 'u1', orgId: 'org-9' });
    let nextCalled = false;
    await new RequireOrgMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
    assert.deepEqual(redirects, []);
  });

  test('sem org ativa redireciona pro seletor de org (default /account/orgs)', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx({ userId: 'u1', orgId: null });
    let nextCalled = false;
    await new RequireOrgMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/orgs']);
  });

  test('sem sessão nenhuma também barra (fail-closed, não estoura)', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx(null);
    let nextCalled = false;
    await new RequireOrgMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/orgs']);
  });

  test('respeita o redirectTo custom', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx({ userId: 'u1', orgId: null });
    await new RequireOrgMiddleware().handle(ctx, async () => {}, {
      redirectTo: '/escolha-empresa',
    });
    assert.deepEqual(redirects, ['/escolha-empresa']);
  });

  test('em rota de API responde 403 em vez de redirecionar', async ({ assert }) => {
    const { ctx, redirects, getAborted } = fakeCtx({ userId: 'u1', orgId: null });
    let nextCalled = false;
    await new RequireOrgMiddleware().handle(
      ctx,
      async () => {
        nextCalled = true;
      },
      { mode: 'api' },
    );
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, []);
    assert.equal(getAborted()?.status, 403);
  });

  test('exige que a org ativa seja uma das permitidas quando `oneOf` é dado', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx({ userId: 'u1', orgId: 'org-intruso' });
    let nextCalled = false;
    await new RequireOrgMiddleware().handle(
      ctx,
      async () => {
        nextCalled = true;
      },
      { oneOf: ['org-9', 'org-10'] },
    );
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/account/orgs']);
  });
});
