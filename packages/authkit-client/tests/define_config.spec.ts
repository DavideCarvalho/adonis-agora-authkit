import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';

test.group('defineConfig (client)', () => {
  test('resolve config com defaults', async ({ assert }) => {
    const provider = defineConfig({
      issuer: 'https://auth.test/oidc',
      clientId: 'app1',
      clientSecret: 's',
      redirectUri: 'https://app/cb',
      resolver: resolvers.jwt(),
    });
    const resolved = await configProvider.resolve<ResolvedClientConfig>({} as any, provider);
    assert.equal(resolved!.issuer, 'https://auth.test/oidc');
    assert.equal(resolved!.sessionKey, 'authkit');
    // Default inclui `roles`: as roles/org saíram do scope `profile` no server (least
    // privilege), então o client first-party precisa solicitar `roles` para recebê-las.
    assert.deepEqual(resolved!.scopes, ['openid', 'profile', 'email', 'offline_access', 'roles']);
    assert.equal(resolved!.globalRolesClaim, 'roles');
    assert.isOk(resolved!.resolverFactory);
  });

  test('scopes custom sobrescreve o default (sem forçar `roles`)', async ({ assert }) => {
    const provider = defineConfig({
      issuer: 'https://auth.test/oidc',
      clientId: 'app1',
      clientSecret: 's',
      redirectUri: 'https://app/cb',
      resolver: resolvers.jwt(),
      scopes: ['openid', 'email'],
    });
    const resolved = await configProvider.resolve<ResolvedClientConfig>({} as any, provider);
    assert.deepEqual(resolved!.scopes, ['openid', 'email']);
  });
});
