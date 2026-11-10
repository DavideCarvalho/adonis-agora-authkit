import { test } from '@japa/runner';
import { buildAuthUrl, DEFAULT_CONFIG, resolveConfig } from '../src/config.js';
import { deriveInitials } from '../src/utils.js';

test.group('resolveConfig', () => {
  test('retorna defaults quando nada é passado', ({ assert }) => {
    const r = resolveConfig();
    assert.equal(r.loginUrl, DEFAULT_CONFIG.loginUrl);
    assert.equal(r.logoutUrl, DEFAULT_CONFIG.logoutUrl);
    assert.equal(r.profileUrl, DEFAULT_CONFIG.profileUrl);
    assert.deepEqual(r.endpoints, DEFAULT_CONFIG.endpoints);
    assert.isUndefined(r.csrfToken);
  });

  test('faz override só dos campos informados', ({ assert }) => {
    const r = resolveConfig({ loginUrl: '/login' });
    assert.equal(r.loginUrl, '/login');
    assert.equal(r.logoutUrl, DEFAULT_CONFIG.logoutUrl);
    assert.equal(r.profileUrl, DEFAULT_CONFIG.profileUrl);
  });

  test('propaga csrfToken', ({ assert }) => {
    assert.equal(resolveConfig({ csrfToken: 'abc' }).csrfToken, 'abc');
  });

  test('endpoints.can default é /authz/can', ({ assert }) => {
    assert.equal(resolveConfig().endpoints.can, '/authz/can');
  });

  test('canPath sobrescreve o default de endpoints.can', ({ assert }) => {
    assert.equal(resolveConfig({ canPath: '/api/authz/can' }).endpoints.can, '/api/authz/can');
  });

  test('endpoints.can vence canPath quando ambos são passados', ({ assert }) => {
    const r = resolveConfig({ canPath: '/a', endpoints: { can: '/b' } });
    assert.equal(r.endpoints.can, '/b');
  });
});

test.group('buildAuthUrl', () => {
  test('retorna base sem returnTo', ({ assert }) => {
    assert.equal(buildAuthUrl('/auth/login'), '/auth/login');
  });

  test('acrescenta returnTo encodado com ?', ({ assert }) => {
    assert.equal(
      buildAuthUrl('/auth/login', '/dashboard?tab=1'),
      '/auth/login?returnTo=%2Fdashboard%3Ftab%3D1',
    );
  });

  test('usa & quando a base já tem query', ({ assert }) => {
    assert.equal(buildAuthUrl('/auth/login?x=1', '/a'), '/auth/login?x=1&returnTo=%2Fa');
  });
});

test.group('deriveInitials', () => {
  test('duas iniciais de nome completo', ({ assert }) => {
    assert.equal(deriveInitials('Ana Maria Silva'), 'AS');
  });

  test('duas letras de nome único', ({ assert }) => {
    assert.equal(deriveInitials('Ana'), 'AN');
  });

  test('fallback para email quando sem nome', ({ assert }) => {
    assert.equal(deriveInitials(undefined, 'ana@b.com'), 'A');
    assert.equal(deriveInitials('', 'zoe@b.com'), 'Z');
  });

  test('? quando sem nada', ({ assert }) => {
    assert.equal(deriveInitials(), '?');
    assert.equal(deriveInitials(null, null), '?');
  });
});
