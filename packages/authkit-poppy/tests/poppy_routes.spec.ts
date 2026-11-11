import { RouterFactory } from '@adonisjs/core/factories/http';
import { test } from '@japa/runner';
import { poppy } from '../src/extension.js';

/**
 * Contra o Router DE VERDADE: ele nomeia rotas sem `.as()` por controller.método, e as duas URLs
 * da metadata RFC 8414 do Poppy usam o mesmo `metadata` — o boot de um app com o Poppy caía em
 * `A route with name "poppy.metadata" already exists`.
 */
test.group('poppy — rotas no Router real', () => {
  test('as rotas da extension fazem commit sem nome duplicado, com guard e throttles', ({
    assert,
  }) => {
    const definition = poppy({
      organization: { name: 'Shop', domain: 'shop.example' },
      scopes: { 'orders:read': 'Orders' },
    }).resolve({ issuer: 'https://shop.example/oidc', delegationScopes: null });
    const router = new RouterFactory().create();
    const throttled: string[] = [];
    const accountGuard = async (_ctx: unknown, next: () => Promise<void>) => next();
    definition.routes!(router as any, {
      accountGuard,
      throttle: {
        login: (route: any) => {
          throttled.push(`login ${route.getPattern()}`);
          return route;
        },
        otp: (route: any) => {
          throttled.push(`otp ${route.getPattern()}`);
          return route;
        },
      },
    });
    assert.doesNotThrow(() => router.commit());

    const routes = router.toJSON().root;
    const names = routes
      .map((route) => route.name)
      .filter((name): name is string => !!name && name.startsWith('authkit.poppy.'));
    assert.includeMembers(names, [
      'authkit.poppy.discovery',
      'authkit.poppy.metadata',
      'authkit.poppy.metadata_under_issuer',
      'authkit.poppy.token',
      'authkit.poppy.revoke',
      'authkit.poppy.device_authorization',
      'authkit.poppy.authorize',
      'authkit.poppy.authorize_decide',
      'authkit.poppy.device',
      'authkit.poppy.device_decide',
      'authkit.poppy.protected_resource',
      'authkit.poppy.browser_session_page',
      'authkit.poppy.browser_session',
      'authkit.poppy.browser_session_authorize',
    ]);
    assert.sameMembers(throttled, [
      'login /poppy/browser-session',
      'otp /poppy/device',
      'otp /poppy/device',
    ]);
    // As telas do usuário ficam atrás do guard de conta; os endpoints de máquina, não.
    const guarded = (pattern: string, method: string) =>
      routes
        .find((r) => r.pattern === pattern && r.methods.includes(method))!
        .middleware.all()
        .has(accountGuard as any);
    assert.isTrue(guarded('/poppy/oauth/authorize', 'GET'));
    assert.isTrue(guarded('/poppy/device', 'POST'));
    assert.isFalse(guarded('/poppy/oauth/token', 'POST'));
  });
});
