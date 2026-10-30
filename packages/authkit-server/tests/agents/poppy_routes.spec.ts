import { RouterFactory } from '@adonisjs/core/factories/http';
import { test } from '@japa/runner';
import { resetAuthHostConfig, setAuthHostConfig } from '../../src/host/auth_host_config.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

/**
 * Contra o Router DE VERDADE: ele nomeia rotas sem `.as()` por controller.método, e as duas URLs
 * da metadata RFC 8414 do Poppy usam o mesmo `metadata` — o boot de um app com
 * `personalAgents.poppy` caía em `A route with name "poppy.metadata" already exists`.
 */
test.group('poppy — rotas no Router real', (group) => {
  group.each.teardown(() => resetAuthHostConfig());

  test('registerAuthHost com Poppy (e PACT) faz commit sem nome duplicado', ({ assert }) => {
    setAuthHostConfig({
      mountPath: '/oidc',
      rateLimit: false as any,
      adminEnabled: false,
      adminApiEnabled: false,
      personalAgents: { prefix: '/agents', poppyPrefix: '/poppy' },
    });
    const router = new RouterFactory().create();
    registerAuthHost(router as any, { mountPath: '/oidc' } as any);
    assert.doesNotThrow(() => router.commit());

    const names = router
      .toJSON()
      .root.map((route) => route.name)
      .filter((name): name is string => !!name && name.startsWith('authkit.poppy.'));
    assert.includeMembers(names, [
      'authkit.poppy.discovery',
      'authkit.poppy.metadata',
      'authkit.poppy.metadata_under_issuer',
      'authkit.poppy.token',
      'authkit.poppy.authorize',
      'authkit.poppy.protected_resource',
      'authkit.poppy.browser_session_page',
      'authkit.poppy.browser_session',
      'authkit.poppy.browser_session_authorize',
    ]);
  });
});
