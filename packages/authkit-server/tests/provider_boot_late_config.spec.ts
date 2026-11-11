import { configProvider } from '@adonisjs/core';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import {
  ADMIN_CONSOLE_NO_AUTHORIZE_WARNING,
  resetAdminConsoleWarning,
} from '../src/host/admin_console_warning.js';
import { getAuthHostConfig, resetAuthHostConfig } from '../src/host/auth_host_config.js';

const APP_ROOT = new URL('./fixtures/boot_app/', import.meta.url);

/**
 * Regressão: um host com keystore CRIPTOGRAFADO (o `jwks` precisa do serviço de encryption para
 * resolver) não conseguia resolver o config no `boot()` do provider, e o catch engolia a falha em
 * silêncio: o stash que o `registerAuthHost` lê nunca era gravado, e nada derivado do config
 * valia — personal agents, `sudo.methods`, headless. Agora a resolução é tentada de novo no
 * `booted`, antes do preload das rotas.
 */
test.group('provider boot — config que só resolve depois do boot', (group) => {
  group.each.setup(() => resetAuthHostConfig);

  test('a resolução que falha no boot é refeita no booted e o stash sai completo', async ({
    assert,
  }) => {
    let calls = 0;
    const authkit = configProvider.create(async () => {
      calls += 1;
      if (calls === 1) throw new Error('serviço de encryption (APP_KEY) indisponível');
      return {
        mountPath: '/oidc',
        rateLimit: {},
        admin: { enabled: false },
        adminApi: { enabled: false },
        sudo: {},
        routes: false,
        lockedRouteOptions: [],
        lockedSettingKeys: [],
        personalAgents: { prefix: '/agents' },
      } as any;
    });
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({ config: { app: { appKey: 'a'.repeat(32) }, authkit } })
      .create(APP_ROOT)
      .createApp('web');
    await app.init();
    app.container.singleton('redis' as any, async () => ({ connection: () => new RedisMock() }));
    await app.boot();

    const { default: AuthkitServerProvider } = await import(
      '../providers/authkit_server_provider.js'
    );
    const provider = new AuthkitServerProvider(app);
    provider.register();
    await provider.boot();
    // O app deste teste já está bootado: o hook `booted` roda na hora.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.isAtLeast(calls, 2);
    assert.deepEqual(getAuthHostConfig()?.personalAgents, { prefix: '/agents' });
  });
});

test.group('provider boot — admin console without admin.authorize', (group) => {
  group.each.setup(() => {
    resetAdminConsoleWarning();
    return resetAuthHostConfig;
  });

  async function boot(admin: Record<string, unknown>) {
    const authkit = configProvider.create(
      async () =>
        ({
          mountPath: '/oidc',
          rateLimit: {},
          admin,
          adminApi: { enabled: false },
          sudo: {},
          routes: false,
          lockedRouteOptions: [],
          lockedSettingKeys: [],
        }) as any,
    );
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({ config: { app: { appKey: 'a'.repeat(32) }, authkit } })
      .create(APP_ROOT)
      .createApp('web');
    await app.init();
    app.container.singleton('redis' as any, async () => ({ connection: () => new RedisMock() }));
    await app.boot();
    const warnings: string[] = [];
    app.container.singleton(
      'logger' as any,
      async () => ({ warn: (m: string) => warnings.push(m), info: () => {} }) as any,
    );
    const { default: AuthkitServerProvider } = await import(
      '../providers/authkit_server_provider.js'
    );
    const provider = new AuthkitServerProvider(app);
    provider.register();
    await provider.boot();
    return warnings;
  }

  test('warns once at boot when admin.authorize is omitted', async ({ assert }) => {
    const first = await boot({ enabled: true, roles: ['ADMIN'], authorize: null });
    assert.deepEqual(first, [ADMIN_CONSOLE_NO_AUTHORIZE_WARNING]);
    const second = await boot({ enabled: true, roles: ['ADMIN'], authorize: null });
    assert.deepEqual(second, []);
  });

  test('no warning with admin.authorize, or with the console off', async ({ assert }) => {
    assert.deepEqual(await boot({ enabled: true, roles: ['ADMIN'], authorize: () => true }), []);
    assert.deepEqual(await boot({ enabled: false, roles: ['ADMIN'], authorize: null }), []);
  });
});
