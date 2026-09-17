import { test } from '@japa/runner';
import {
  ACTIVE_ORG_COOKIE,
  decodeActiveOrgCookie,
  encodeActiveOrgCookie,
  normalizeActiveOrg,
  readActiveOrgFromKoaCtx,
} from '../../src/host/active_org_cookie.js';

test.group('active_org_cookie — encode/decode', () => {
  test('encodeActiveOrgCookie / decode round-trip', ({ assert }) => {
    const encoded = encodeActiveOrgCookie({ orgId: 'org-1', orgSlug: 'acme', orgRole: 'admin' });
    assert.isString(encoded);
    const decoded = decodeActiveOrgCookie(encoded);
    assert.deepEqual(decoded, { orgId: 'org-1', orgSlug: 'acme', orgRole: 'admin' });
  });

  test('decodeActiveOrgCookie retorna null para valor inválido', ({ assert }) => {
    assert.isNull(decodeActiveOrgCookie('garbage'));
    assert.isNull(decodeActiveOrgCookie(''));
    assert.isNull(decodeActiveOrgCookie(undefined));
  });

  test('ACTIVE_ORG_COOKIE tem o nome correto', ({ assert }) => {
    assert.equal(ACTIVE_ORG_COOKIE, 'authkit_active_org');
  });

  test('decode retorna null para formato faltando campos', ({ assert }) => {
    assert.isNull(decodeActiveOrgCookie('only-two\tparts'));
    assert.isNull(decodeActiveOrgCookie('\t\t')); // campos vazios
  });
});

test.group('readActiveOrgFromKoaCtx — o jar Koa NÃO URL-decodifica', () => {
  const koaCtx = (value: string) => ({ cookies: { get: () => value } });

  test('lê o valor cru (sem encode)', ({ assert }) => {
    const info = readActiveOrgFromKoaCtx(
      koaCtx(encodeActiveOrgCookie({ orgId: 'o', orgSlug: 's', orgRole: 'owner' })),
    );
    assert.deepEqual(info, { orgId: 'o', orgSlug: 's', orgRole: 'owner' });
  });

  test('lê o valor URL-encoded que o `cookies` devolve como está', ({ assert }) => {
    // `response.cookie` serializa com encodeURIComponent: TAB vira %09. O get do
    // jar Koa devolve o valor ainda encoded, então o reader PRECISA decodificar.
    const encoded = encodeURIComponent(
      encodeActiveOrgCookie({ orgId: 'o', orgSlug: 's', orgRole: 'admin' }),
    );
    const info = readActiveOrgFromKoaCtx(koaCtx(encoded));
    assert.deepEqual(info, { orgId: 'o', orgSlug: 's', orgRole: 'admin' });
  });

  test('valor inválido/sem cookie retorna null', ({ assert }) => {
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx('garbage')));
    assert.isNull(readActiveOrgFromKoaCtx({ cookies: { get: () => null } }));
    assert.isNull(readActiveOrgFromKoaCtx({}));
  });
});

test.group('normalizeActiveOrg — payload persistido é desconfiado', () => {
  test('aceita a forma completa', ({ assert }) => {
    assert.deepEqual(normalizeActiveOrg({ orgId: 'o', orgSlug: 's', orgRole: 'admin' }), {
      orgId: 'o',
      orgSlug: 's',
      orgRole: 'admin',
    });
  });

  test('rejeita null/undefined/parcial/tipo errado', ({ assert }) => {
    assert.isNull(normalizeActiveOrg(null));
    assert.isNull(normalizeActiveOrg(undefined));
    assert.isNull(normalizeActiveOrg({ orgId: 'o' }));
    assert.isNull(normalizeActiveOrg({ orgId: 'o', orgSlug: 's', orgRole: '' }));
    assert.isNull(normalizeActiveOrg({ orgId: 1, orgSlug: 's', orgRole: 'admin' }));
    assert.isNull(normalizeActiveOrg('o\ts\tadmin'));
  });
});
