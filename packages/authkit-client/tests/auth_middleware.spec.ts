import { test } from '@japa/runner';
import AuthkitAuthMiddleware from '../src/middleware/auth_middleware.js';

function fakeCtx(authenticated: boolean) {
  const redirects: string[] = [];
  const ctx = {
    authkit: { check: async () => authenticated },
    response: {
      redirect: (to: string) => {
        redirects.push(to);
        return to;
      },
    },
  } as any;
  return { ctx, redirects };
}

test.group('AuthkitAuthMiddleware', () => {
  test('request autenticada segue adiante (chama next, não redireciona)', async ({ assert }) => {
    const { ctx, redirects } = fakeCtx(true);
    const middleware = new AuthkitAuthMiddleware();
    let nextCalled = false;
    await middleware.handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
    assert.deepEqual(redirects, []);
  });

  test('request não autenticada redireciona pro redirectTo default (/auth/login)', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx(false);
    const middleware = new AuthkitAuthMiddleware();
    let nextCalled = false;
    await middleware.handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isFalse(nextCalled);
    assert.deepEqual(redirects, ['/auth/login']);
  });

  test('request não autenticada redireciona pro redirectTo custom quando fornecido', async ({
    assert,
  }) => {
    const { ctx, redirects } = fakeCtx(false);
    const middleware = new AuthkitAuthMiddleware();
    await middleware.handle(ctx, async () => {}, {
      redirectTo: '/login-custom',
    });
    assert.deepEqual(redirects, ['/login-custom']);
  });

  test('não recebe/expõe opção de roles — o middleware é só-login', async ({ assert }) => {
    // AuthMiddlewareOptions não tem mais `roles`; uma request autenticada sempre
    // passa, independentemente de qualquer papel — autorização saiu daqui.
    const { ctx, redirects } = fakeCtx(true);
    const middleware = new AuthkitAuthMiddleware();
    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };
    // @ts-expect-error `roles` não existe mais em AuthMiddlewareOptions
    await middleware.handle(ctx, next, { roles: ['ADMIN'] });
    assert.isTrue(nextCalled);
    assert.deepEqual(redirects, []);
  });
});
