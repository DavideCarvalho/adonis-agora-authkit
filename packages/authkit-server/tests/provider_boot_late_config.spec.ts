import { configProvider } from '@adonisjs/core';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
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
