import { test } from '@japa/runner';
import {
  type BrandingConfig,
  brandFor,
  isFirstParty,
  resolveBranding,
  resolveDefaultBrand,
} from '../../src/host/branding.js';

const cfg: BrandingConfig = {
  company: 'educ(a)ção',
  clients: {
    'entre-textos': {
      appName: 'Entre Textos',
      accent: '#1d4ed8',
      accentSoft: '#3b82f6',
      tagline: 'Orientação',
    },
  },
  default: { appName: 'Sua conta', accent: '#111827', accentSoft: '#374151', tagline: 'Acesso' },
  firstParty: ['entre-textos'],
  audienceLabels: { advisor: 'Orientador' },
};

test.group('branding', () => {
  test('brandFor retorna a marca do client + company', ({ assert }) => {
    const b = brandFor(cfg, 'entre-textos');
    assert.equal(b.appName, 'Entre Textos');
    assert.equal(b.company, 'educ(a)ção');
  });
  test('brandFor cai no default p/ client desconhecido', ({ assert }) => {
    assert.equal(brandFor(cfg, 'xpto').appName, 'Sua conta');
  });
  test('brandFor anexa audienceLabel quando há audience', ({ assert }) => {
    assert.equal(brandFor(cfg, 'entre-textos', 'advisor').audienceLabel, 'Orientador');
    assert.isUndefined(brandFor(cfg, 'entre-textos', 'nope').audienceLabel);
  });
  test('isFirstParty', ({ assert }) => {
    assert.isTrue(isFirstParty(cfg, 'entre-textos'));
    assert.isFalse(isFirstParty(cfg, 'xpto'));
    assert.isFalse(isFirstParty(cfg, undefined));
  });
});

/**
 * Host real (Entre Textos): `branding: { company, clients }` sem `default` nem `firstParty`.
 * Antes, `brandFor` sem client conhecido devolvia uma marca SEM `appName`/`accent` (telas de
 * sessão expirada, throttle, login sem client caíam no fallback genérico enquanto os e-mails
 * já usavam a `company`) e `isFirstParty` estourava em `firstParty.includes`.
 */
test.group('branding sem `default`', () => {
  const partial = {
    company: 'educ(a)ção',
    clients: { 'entre-textos': cfg.clients['entre-textos'] },
  };

  test('resolveBranding deriva o default da company', ({ assert }) => {
    const resolved = resolveBranding(partial);
    const b = brandFor(resolved, undefined);
    assert.equal(b.appName, 'educ(a)ção');
    assert.isString(b.accent);
    assert.isString(b.accentSoft);
    assert.equal(b.company, 'educ(a)ção');
    assert.equal(brandFor(resolved, 'xpto').appName, 'educ(a)ção');
    assert.equal(brandFor(resolved, 'entre-textos').appName, 'Entre Textos');
  });

  test('isFirstParty não estoura sem `firstParty`', ({ assert }) => {
    const resolved = resolveBranding(partial);
    assert.doesNotThrow(() => isFirstParty(resolved, 'entre-textos'));
    assert.isFalse(isFirstParty(resolved, 'entre-textos'));
  });

  test('resolveDefaultBrand: default → company → AuthKit', ({ assert }) => {
    assert.equal(resolveDefaultBrand(cfg).appName, 'Sua conta');
    assert.equal(resolveDefaultBrand(cfg).accent, '#111827');
    assert.equal(resolveDefaultBrand(partial).appName, 'educ(a)ção');
    assert.equal(resolveDefaultBrand(undefined).appName, 'AuthKit');
  });

  test('defineConfig resolve `branding` parcial com default derivado', async ({ assert }) => {
    const RedisMock = (await import('ioredis-mock')).default;
    const { configProvider } = await import('@adonisjs/core');
    const { defineConfig, adapters } = await import('../../src/define_config.js');
    const { fakeAccountStore } = await import('../bootstrap.js');
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const provider = defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed' },
      accountStore: fakeAccountStore(),
      branding: partial,
    });
    const resolved = (await configProvider.resolve(fakeApp, provider)) as any;
    assert.equal(resolved.branding.default.appName, 'educ(a)ção');
    assert.deepEqual(resolved.branding.firstParty, []);
    assert.equal(brandFor(resolved.branding, undefined).appName, 'educ(a)ção');
  });
});
