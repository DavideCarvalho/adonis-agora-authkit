import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import instance from 'oidc-provider/lib/helpers/weak_cache.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { ClientMetadataError } from '../src/host/client_metadata.js';
import { buildProvider } from '../src/provider/build_provider.js';
import { fakeAccountStore } from './bootstrap.js';

async function resolved() {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  return configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'app1',
          clientSecret: 's',
          redirectUris: ['https://app1/cb'],
          postLogoutRedirectUris: ['https://app1/'],
          grants: ['authorization_code', 'refresh_token'],
          backchannelLogoutUri: 'https://app1/auth/backchannel-logout',
          backchannelLogoutSessionRequired: true,
        },
      ],
      accountStore: fakeAccountStore(),
    }),
  );
}

test.group('buildProvider', () => {
  test('client estático inválido (nativo com secret) falha no boot', async ({ assert }) => {
    const cfg = await resolved();
    cfg!.clients.push({
      clientId: 'app-nativo',
      clientSecret: 'nao-pode',
      redirectUris: ['com.example.app:/callback'],
      applicationType: 'native',
    } as NonNullable<typeof cfg>['clients'][number]);
    assert.throws(
      () =>
        buildProvider(cfg!, {
          appKey: 'a'.repeat(32),
          findAccount: async () => undefined,
        }),
      ClientMetadataError as any,
    );
  });

  test('instancia um Provider OIDC com issuer', async ({ assert }) => {
    const cfg = await resolved();
    const provider = buildProvider(cfg!, {
      appKey: 'a'.repeat(32),
      findAccount: async (_ctx: any, sub: string) => ({
        accountId: sub,
        claims: async () => ({ sub }),
      }),
    });
    assert.equal(provider.issuer, 'https://auth.test');
    assert.equal(provider.constructor.name, 'Provider');
  });

  test('aceita findAccount no-account (retorna undefined)', async ({ assert }) => {
    const cfg = await resolved();
    const provider = buildProvider(cfg!, {
      appKey: 'a'.repeat(32),
      findAccount: async () => undefined,
    });
    assert.isOk(provider);
  });

  test('mapeia postLogoutRedirectUris para post_logout_redirect_uris do client', async ({
    assert,
  }) => {
    const cfg = await resolved();
    const provider = buildProvider(cfg!, {
      appKey: 'a'.repeat(32),
      findAccount: async (_ctx: any, sub: string) => ({
        accountId: sub,
        claims: async () => ({ sub }),
      }),
    });
    const client = await (provider as any).Client.find('app1');
    assert.isOk(client);
    assert.deepEqual(client.metadata().post_logout_redirect_uris, ['https://app1/']);
  });

  test('habilita backchannelLogout e mapeia backchannel_logout_uri do client', async ({
    assert,
  }) => {
    const cfg = await resolved();
    const provider = buildProvider(cfg!, {
      appKey: 'a'.repeat(32),
      findAccount: async (_ctx: any, sub: string) => ({
        accountId: sub,
        claims: async () => ({ sub }),
      }),
    });
    // O oidc-provider só ACEITA backchannel_logout_uri no metadata do client quando a
    // feature backchannelLogout está habilitada — caso contrário a propriedade é
    // rejeitada/descartada. Logo, a presença abaixo prova a feature ligada + o mapeamento.
    const client = await (provider as any).Client.find('app1');
    const meta = client.metadata();
    assert.equal(meta.backchannel_logout_uri, 'https://app1/auth/backchannel-logout');
    assert.isTrue(meta.backchannel_logout_session_required);
  });

  // ── L3 (FIX least-privilege): roles/org_* vivem no scope `roles` DEDICADO ──────
  // O `profile` volta a ser só identidade (name/picture). roles + org_* ficam num
  // scope `roles` dedicado, fora do `profile`, para que clients que peçam só `profile`
  // não recebam dados de autorização interna. Este teste FIXA a nova decisão.
  test('L3: roles e org_* ficam no scope `roles` dedicado, não em `profile`', async ({
    assert,
  }) => {
    const cfg = await resolved();
    const provider = buildProvider(cfg!, {
      appKey: 'a'.repeat(32),
      findAccount: async (_ctx: any, sub: string) => ({
        accountId: sub,
        claims: async () => ({ sub }),
      }),
    });
    const claims = (instance(provider as any) as any).configuration.claims;

    // `profile` é só identidade — sem roles nem org_*.
    const profileClaims = Object.keys(claims.profile ?? {});
    assert.includeMembers(profileClaims, ['name', 'picture']);
    assert.notInclude(profileClaims, cfg!.globalRolesClaim);
    assert.notInclude(profileClaims, 'org_id');
    assert.notInclude(profileClaims, 'org_slug');
    assert.notInclude(profileClaims, 'org_role');

    // O scope `roles` dedicado carrega roles + claims de org.
    const rolesClaims = Object.keys(claims.roles ?? {});
    assert.includeMembers(rolesClaims, [cfg!.globalRolesClaim, 'org_id', 'org_slug', 'org_role']);
  });
});
