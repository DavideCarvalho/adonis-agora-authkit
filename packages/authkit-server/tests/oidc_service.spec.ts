import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import instance from 'oidc-provider/lib/helpers/weak_cache.js';
import { adapters, defineConfig } from '../src/define_config.js';
import type { BrandingConfig } from '../src/host/branding.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

test.group('OidcService', () => {
  test('expõe provider e callback handler', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://auth.test',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [{ clientId: 'app1', clientSecret: 's', redirectUris: ['https://app1/cb'] }],
        accountStore: fakeAccountStore(),
      }),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    assert.isOk(service.provider);
    assert.isFunction(service.callback);
    assert.equal(service.provider.issuer, 'https://auth.test');
  });

  test('expõe .config com mountPath e render da defineConfig', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://auth.test',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [{ clientId: 'app1', clientSecret: 's', redirectUris: ['https://app1/cb'] }],
        accountStore: fakeAccountStore(),
        mountPath: '/oidc',
        render: () => {},
      }),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    assert.equal(service.config.mountPath, '/oidc');
    assert.isFunction(service.config.render);
  });

  test('verifyClientCredentials aceita par correto e rejeita errado/inexistente', async ({
    assert,
  }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://auth.test',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [{ clientId: 'rs1', clientSecret: 's3cr3t', redirectUris: ['https://rs1/cb'] }],
        accountStore: fakeAccountStore(),
      }),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    assert.isTrue(service.verifyClientCredentials('rs1', 's3cr3t'));
    assert.isFalse(service.verifyClientCredentials('rs1', 'errado'));
    assert.isFalse(service.verifyClientCredentials('naoexiste', 's3cr3t'));
  });

  // ── Gate de least-privilege: roles/org_* só para clients first-party ──────────
  // Mesmo que o client peça `scope=roles`, a emissão das claims de roles/org só
  // acontece quando o clientId está em `branding.firstParty`. Montamos um ctx fake
  // com `oidc.client.clientId` e verificamos presença/ausência das claims no
  // resultado de `findAccount(ctx, sub).claims()`.
  async function serviceWithBranding(
    branding: BrandingConfig,
    extra: Partial<Parameters<typeof defineConfig>[0]> = {},
  ) {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'https://auth.test',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [
          { clientId: 'first-app', clientSecret: 's', redirectUris: ['https://first-app/cb'] },
          { clientId: 'third-app', clientSecret: 's', redirectUris: ['https://third-app/cb'] },
        ],
        accountStore: fakeAccountStore(),
        branding,
        ...extra,
      }),
    );
    return new OidcService(cfg!, 'a'.repeat(32));
  }

  const branding: BrandingConfig = {
    company: 'ACME',
    clients: {},
    default: { appName: 'ACME', accent: '#000', accentSoft: '#111', tagline: 't' },
    firstParty: ['first-app'],
  };

  async function claimsFor(service: OidcService, clientId: string) {
    const findAccount = (instance(service.provider as any) as any).configuration.findAccount;
    const ctx = { oidc: { client: { clientId } } };
    const account = await findAccount(ctx, 'u1');
    return account.claims('id_token', 'roles');
  }

  test('phone-only accounts omit email claims without probing email verification', async ({
    assert,
  }) => {
    let verificationCalls = 0;
    const service = await serviceWithBranding(branding, {
      accountStore: fakeAccountStore({
        findById: async () => ({ id: 'u1', email: '', phone: '5511999999999' }),
        isEmailVerified: async () => {
          verificationCalls++;
          return true;
        },
      }),
    });
    const claims = await claimsFor(service, 'third-app');
    assert.equal(claims.sub, 'u1');
    assert.notProperty(claims, 'email');
    assert.notProperty(claims, 'email_verified');
    assert.equal(verificationCalls, 0);
  });

  for (const verified of [true, false]) {
    test(`email_verified reflects the store status: ${verified}`, async ({ assert }) => {
      const service = await serviceWithBranding(branding, {
        accountStore: fakeAccountStore({ isEmailVerified: async () => verified }),
      });
      const claims = await claimsFor(service, 'third-app');
      assert.equal(claims.email, 'a@b.com');
      assert.equal(claims.email_verified, verified);
    });
  }

  test('email_verified is false when the store cannot attest verification', async ({ assert }) => {
    const service = await serviceWithBranding(branding);
    const claims = await claimsFor(service, 'third-app');
    assert.equal(claims.email_verified, false);
  });

  test('findAccount.claims emite roles/org SOMENTE para client first-party', async ({ assert }) => {
    const service = await serviceWithBranding(branding);

    // First-party: roles presente (fakeAccountStore retorna globalRoles=['ADMIN']).
    const fp = await claimsFor(service, 'first-app');
    assert.deepEqual(fp.roles, ['ADMIN']);

    // Third-party: NUNCA recebe roles, mesmo pedindo scope=roles.
    const tp = await claimsFor(service, 'third-app');
    assert.notProperty(tp, 'roles');
    assert.notProperty(tp, 'org_id');
    assert.notProperty(tp, 'org_slug');
    assert.notProperty(tp, 'org_role');

    // Identidade básica continua para ambos.
    assert.equal(fp.sub, 'u1');
    assert.equal(tp.sub, 'u1');
    assert.equal(tp.email, 'a@b.com');
  });

  // ── Hook plugável resolveTokenRoles: fonte da claim de roles no mint ──────────
  test('(a) default: sem resolveTokenRoles a claim vem de account.globalRoles', async ({
    assert,
  }) => {
    const service = await serviceWithBranding(branding);
    const fp = await claimsFor(service, 'first-app');
    // fakeAccountStore retorna globalRoles=['ADMIN'] — comportamento inalterado (BC).
    assert.deepEqual(fp.roles, ['ADMIN']);
  });

  test('(b) hook sobrescreve: claim vem do hook, account.globalRoles é IGNORADO', async ({
    assert,
  }) => {
    const service = await serviceWithBranding(branding, {
      resolveTokenRoles: () => ['X', 'Y'],
    });
    const fp = await claimsFor(service, 'first-app');
    assert.deepEqual(fp.roles, ['X', 'Y']);
    // account.globalRoles (['ADMIN']) não aparece — o hook é a fonte de verdade.
    assert.notDeepEqual(fp.roles, ['ADMIN']);
  });

  test('(c) hook assíncrono é aguardado corretamente', async ({ assert }) => {
    const service = await serviceWithBranding(branding, {
      resolveTokenRoles: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return ['ASYNC_ROLE'];
      },
    });
    const fp = await claimsFor(service, 'first-app');
    assert.deepEqual(fp.roles, ['ASYNC_ROLE']);
  });

  test('(d) hook recebe o contexto certo (account + clientId + activeOrg)', async ({ assert }) => {
    let received: any;
    const service = await serviceWithBranding(branding, {
      resolveTokenRoles: (account, context) => {
        received = { account, context };
        return ['OK'];
      },
    });
    const fp = await claimsFor(service, 'first-app');
    assert.deepEqual(fp.roles, ['OK']);
    // A conta resolvida (findAccount('u1')) é passada ao hook.
    assert.equal(received.account.id, 'u1');
    assert.equal(received.account.email, 'a@b.com');
    // clientId do client autenticado; sem cookie de org ativa => activeOrg null.
    assert.equal(received.context.clientId, 'first-app');
    assert.equal(received.context.activeOrg, null);
  });

  test('(e) gate first-party continua valendo: third-party não roda o hook nem vaza roles', async ({
    assert,
  }) => {
    let called = false;
    const service = await serviceWithBranding(branding, {
      resolveTokenRoles: () => {
        called = true;
        return ['LEAK'];
      },
    });
    const tp = await claimsFor(service, 'third-app');
    // Third-party NUNCA recebe a claim de roles, mesmo com o hook configurado.
    assert.notProperty(tp, 'roles');
    // E o hook NÃO é invocado para third-party.
    assert.isFalse(called);
  });
});
