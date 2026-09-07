import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { fakeAccountStore } from './bootstrap.js';

test.group('defineConfig (server)', () => {
  test('resolve config com adapter, jwks, ttl e findAccount materializados', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;

    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      ttl: { accessToken: '15m', refreshToken: '30d' },
      accountStore: fakeAccountStore(),
    });

    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.issuer, 'https://auth.test');
    assert.isFunction(resolved.AdapterClass);
    assert.lengthOf(resolved.jwks.keys, 1);
    assert.equal(resolved.ttl.accessToken, 900); // 15m em segundos
    assert.equal(resolved.ttl.refreshToken, 2592000); // 30d
    assert.equal(resolved.globalRolesClaim, 'roles'); // default
    assert.isFunction(resolved.findAccount);
    const acc = await resolved.findAccount('u1');
    assert.equal(acc!.email, 'a@b.com');
  });

  test('carrega verifyCredentials quando fornecido', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore({
        verifyCredentials: async (email) =>
          email === 'a@b.com' ? { id: 'u1', email, globalRoles: [] } : null,
      }),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isFunction(resolved!.verifyCredentials);
    assert.deepEqual(await resolved!.verifyCredentials!('a@b.com', 'x'), {
      id: 'u1',
    });
    assert.isNull(await resolved!.verifyCredentials!('no@b.com', 'x'));
  });

  test('toSeconds converte unidades', async ({ assert }) => {
    const { toSeconds } = await import('../src/define_config.js');
    assert.equal(toSeconds('30s', 0), 30);
    assert.equal(toSeconds('5m', 0), 300);
    assert.equal(toSeconds('2h', 0), 7200);
    assert.equal(toSeconds('1d', 0), 86400);
    assert.equal(toSeconds(42, 0), 42);
    assert.equal(toSeconds(undefined, 99), 99);
  });

  test('resolve config com host-kit (render/branding/social/mountPath/patIntrospectionSecret)', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { inertiaRenderer } = await import('../src/host/renderers/inertia_renderer.js');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      mountPath: '/oidc',
      render: inertiaRenderer({ prefix: 'authkit' }),
      branding: {
        company: 'C',
        clients: {},
        default: {
          appName: 'x',
          accent: '#000',
          accentSoft: '#111',
          tagline: 't',
        },
        firstParty: [],
      },
      social: { providers: ['google'] },
      patIntrospectionSecret: 's3cr3t',
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.mountPath, '/oidc');
    assert.isFunction(resolved.render);
    assert.deepEqual(resolved.social, { providers: ['google'] });
    assert.equal(resolved.branding!.company, 'C');
    assert.equal(resolved.patIntrospectionSecret, 's3cr3t');
  });

  test('resolve config sem `branding` cai num default sensato (regressão do crash em cfg.branding!.clients)', async ({
    assert,
  }) => {
    // `branding` é opcional em AuthServerConfigInput e todo doc
    // (getting-started/quickstart/reference) o omite na config mínima. Antes
    // de `resolveBranding` (src/host/branding.ts), `resolved.branding` ficava
    // `undefined` e o interaction controller crashava em `cfg.branding!.clients`
    // no primeiro hit de QUALQUER tela built-in. Aqui a config nem declara a
    // chave `branding` — reproduzindo a config mínima documentada ao pé da letra.
    const { brandFor } = await import('../src/host/branding.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = (await configProvider.resolve(fakeApp, provider)) as any;
    assert.isDefined(resolved.branding);
    assert.isObject(resolved.branding.clients);
    assert.isObject(resolved.branding.default);
    assert.isString(resolved.branding.default.appName);
    assert.doesNotThrow(() => brandFor(resolved.branding, 'any-client-id'));
  });

  test('rateLimit ligado por default (enabled true)', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isTrue(resolved.rateLimit.enabled);
    // Buckets default determinísticos.
    assert.deepEqual(resolved.rateLimit.login, {
      points: 10,
      duration: '1 min',
    });
    assert.deepEqual(resolved.rateLimit.introspection, {
      points: 60,
      duration: '1 min',
    });
  });

  test('rateLimit resolve defaults quando enabled sem buckets explícitos', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      rateLimit: { enabled: true },
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isTrue(resolved.rateLimit.enabled);
    assert.deepEqual(resolved.rateLimit.login, {
      points: 10,
      duration: '1 min',
    });
    assert.deepEqual(resolved.rateLimit.introspection, {
      points: 60,
      duration: '1 min',
    });
  });

  test('rateLimit respeita enabled e store customizados (buckets via settings)', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      rateLimit: {
        enabled: true,
        store: 'redis',
      },
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isTrue(resolved.rateLimit.enabled);
    // Buckets são sempre lib defaults — política via runtime setting.
    assert.deepEqual(resolved.rateLimit.login, {
      points: 10,
      duration: '1 min',
    });
    assert.deepEqual(resolved.rateLimit.introspection, {
      points: 60,
      duration: '1 min',
    });
    assert.equal(resolved.rateLimit.store, 'redis');
  });

  test('resolveRateLimit aplica defaults isoladamente', async ({ assert }) => {
    const { resolveRateLimit } = await import('../src/define_config.js');
    // Default (undefined) agora liga o rate-limit.
    const on0 = resolveRateLimit();
    assert.isTrue(on0.enabled);
    assert.deepEqual(on0.login, { points: 10, duration: '1 min' });

    // enabled: false explícito desliga.
    const off = resolveRateLimit({ enabled: false });
    assert.isFalse(off.enabled);
    assert.deepEqual(off.login, { points: 10, duration: '1 min' });

    // store customizado
    const onWithStore = resolveRateLimit({ enabled: true, store: 'redis' });
    assert.isTrue(onWithStore.enabled);
    assert.equal(onWithStore.store, 'redis');
    // Buckets sempre lib defaults
    assert.deepEqual(onWithStore.login, { points: 10, duration: '1 min' });
    assert.deepEqual(onWithStore.introspection, {
      points: 60,
      duration: '1 min',
    });
  });

  test('mail é passthrough (hooks opcionais materializados quando fornecidos)', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const calls: string[] = [];
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      mail: {
        onPasswordReset: async () => {
          calls.push('reset');
        },
        onEmailVerification: async () => {
          calls.push('verify');
        },
      },
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isFunction(resolved.mail!.onPasswordReset);
    assert.isFunction(resolved.mail!.onEmailVerification);
    await resolved.mail!.onPasswordReset!({
      email: 'a@b.com',
      resetUrl: 'u',
      token: 't',
    });
    await resolved.mail!.onEmailVerification!({
      email: 'a@b.com',
      verifyUrl: 'u',
      token: 't',
    });
    assert.deepEqual(calls, ['reset', 'verify']);
  });

  test('mail é undefined quando não fornecido', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isUndefined(resolved.mail);
  });

  test('audit é passthrough quando fornecido', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const events: string[] = [];
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      audit: {
        record: async (e) => {
          events.push(e.type);
        },
      },
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isFunction(resolved.audit!.record);
    await resolved.audit!.record({ type: 'login.success', email: 'a@b.com' });
    assert.deepEqual(events, ['login.success']);
  });

  test('audit é sempre o fan-out de diagnostics (sempre ligado) mesmo sem sink', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    // Bridge Agora: o sink de diagnostics é sempre composto (zero-config), então
    // `record` existe mesmo sem o host fornecer um audit sink. É no-op sem o slot.
    assert.isFunction(resolved.audit?.record);
    await assert.doesNotReject(() => resolved.audit!.record({ type: 'login.success' }));
  });

  test('mountPath default é /oidc quando omitido', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.mountPath, '/oidc');
  });

  test('accountHome é propagado para o config resolvido (bug: antes era descartado silenciosamente)', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const { accountHome } = await import('../src/host/account_home.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      accountHome: '/minha-conta',
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.accountHome, '/minha-conta');
    assert.equal(accountHome(resolved), '/minha-conta');
  });

  test('accountHome fica undefined no resolvido quando omitido, e accountHome() cai no default', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const { accountHome } = await import('../src/host/account_home.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.isUndefined(resolved.accountHome);
    assert.equal(accountHome(resolved), '/account/security');
  });

  test('resolveDynamicRegistration: management sem enabled lança erro de config', async ({
    assert,
  }) => {
    const { resolveDynamicRegistration } = await import('../src/define_config.js');
    assert.throws(
      () => resolveDynamicRegistration({ enabled: false, management: true }),
      /management.*requer.*enabled|enabled.*true/,
    );
  });

  test('resolveDynamicRegistration: management com enabled resolve normalmente', async ({
    assert,
  }) => {
    const { resolveDynamicRegistration } = await import('../src/define_config.js');
    const r = resolveDynamicRegistration({ enabled: true, management: true });
    assert.isTrue(r.enabled);
    assert.isTrue(r.management);
  });

  test('resolveDynamicRegistration: defaults desligados', async ({ assert }) => {
    const { resolveDynamicRegistration } = await import('../src/define_config.js');
    const r = resolveDynamicRegistration();
    assert.isFalse(r.enabled);
    assert.isFalse(r.management);
  });

  test('defineConfig lança em resolve quando management sem enabled', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      dynamicRegistration: { enabled: false, management: true },
    });
    await assert.rejects(() => configProvider.resolve(fakeApp, provider));
  });

  test('accessTokens default → opaque (anyJwt false), preserva comportamento atual', async ({
    assert,
  }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.accessTokens.format, 'opaque');
    assert.isFalse(resolved.accessTokens.anyJwt);
    assert.equal(resolved.accessTokens.audience, 'https://auth.test');
  });

  test('accessTokens jwt é materializado na config resolvida', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { fakeAccountStore } = await import('./bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      accessTokens: {
        format: 'jwt',
        resources: { 'https://api.test': { format: 'jwt' } },
      },
    });
    const resolved = await configProvider.resolve(fakeApp, provider);
    assert.equal(resolved.accessTokens.format, 'jwt');
    assert.isTrue(resolved.accessTokens.anyJwt);
    assert.equal(resolved.accessTokens.resources['https://api.test'].format, 'jwt');
  });
});

test.group('resolveAccessTokens', () => {
  test('default = opaque sem resources e anyJwt false (comportamento atual)', async ({
    assert,
  }) => {
    const { resolveAccessTokens } = await import('../src/define_config.js');
    const r = resolveAccessTokens('https://auth.test');
    assert.equal(r.format, 'opaque');
    assert.equal(r.audience, 'https://auth.test'); // audience default = issuer
    assert.isFalse(r.anyJwt);
    assert.deepEqual(r.resources, {});
  });

  test('format jwt (modo simples) → anyJwt true, audience default = issuer', async ({ assert }) => {
    const { resolveAccessTokens } = await import('../src/define_config.js');
    const r = resolveAccessTokens('https://auth.test', { format: 'jwt' });
    assert.equal(r.format, 'jwt');
    assert.isTrue(r.anyJwt);
    assert.equal(r.audience, 'https://auth.test');
  });

  test('audience explícito sobrescreve o issuer', async ({ assert }) => {
    const { resolveAccessTokens } = await import('../src/define_config.js');
    const r = resolveAccessTokens('https://auth.test', {
      format: 'jwt',
      audience: 'my-api',
    });
    assert.equal(r.audience, 'my-api');
  });

  test('resources herdam format raiz; audience default = a chave (resource indicator)', async ({
    assert,
  }) => {
    const { resolveAccessTokens } = await import('../src/define_config.js');
    const r = resolveAccessTokens('https://auth.test', {
      format: 'jwt',
      resources: {
        'https://api.acme.test': { scopes: ['read'] },
        'https://other.test': {
          format: 'opaque',
          audience: 'other-aud',
          expiresIn: 120,
        },
      },
    });
    assert.equal(r.resources['https://api.acme.test'].format, 'jwt'); // herdou
    assert.equal(r.resources['https://api.acme.test'].audience, 'https://api.acme.test'); // = a chave
    assert.deepEqual(r.resources['https://api.acme.test'].scopes, ['read']);
    assert.equal(r.resources['https://other.test'].format, 'opaque'); // override
    assert.equal(r.resources['https://other.test'].audience, 'other-aud');
    assert.equal(r.resources['https://other.test'].expiresIn, 120);
    assert.isTrue(r.anyJwt);
  });

  test('root opaque + resource jwt → anyJwt true', async ({ assert }) => {
    const { resolveAccessTokens } = await import('../src/define_config.js');
    const r = resolveAccessTokens('https://auth.test', {
      format: 'opaque',
      resources: { 'https://api.test': { format: 'jwt' } },
    });
    assert.isTrue(r.anyJwt);
  });
});
