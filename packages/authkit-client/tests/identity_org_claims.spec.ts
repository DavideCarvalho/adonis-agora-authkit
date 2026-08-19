import { test } from '@japa/runner';
import { buildIdentityFromClaims } from '../src/resolvers/identity.js';

test.group('resolvers/identity — claims de organização', () => {
  test('promove org_id/org_slug/org_role a campos de primeira classe', ({ assert }) => {
    const identity = buildIdentityFromClaims(
      {
        sub: 'user-1',
        email: 'a@b.c',
        org_id: 'org-9',
        org_slug: 'acme',
        org_role: 'owner',
      },
      'roles',
    );

    assert.equal(identity.orgId, 'org-9');
    assert.equal(identity.orgSlug, 'acme');
    assert.equal(identity.orgRole, 'owner');
  });

  test('sem claims de org, os campos ficam null (sessão sem org ativa)', ({ assert }) => {
    const identity = buildIdentityFromClaims({ sub: 'user-1', email: 'a@b.c' }, 'roles');

    assert.isNull(identity.orgId);
    assert.isNull(identity.orgSlug);
    assert.isNull(identity.orgRole);
  });

  test('aceita os aliases de tenant de IdPs de terceiros (byo-idp)', ({ assert }) => {
    // Um Entra ID/Auth0 à frente do authkit não emite `org_id`; o app não deveria
    // ter que reimplementar a derivação por causa disso.
    assert.equal(buildIdentityFromClaims({ sub: 'u', tid: 't-1' }, 'roles').orgId, 't-1');
    assert.equal(
      buildIdentityFromClaims({ sub: 'u', organization_id: 'o-2' }, 'roles').orgId,
      'o-2',
    );
    assert.equal(
      buildIdentityFromClaims({ sub: 'u', active_organization_id: 'o-3' }, 'roles').orgId,
      'o-3',
    );
  });

  test('active_organization_id tem precedência sobre os demais aliases', ({ assert }) => {
    const identity = buildIdentityFromClaims(
      { sub: 'u', active_organization_id: 'ativo', org_id: 'org-9', tid: 'tenant' },
      'roles',
    );
    assert.equal(identity.orgId, 'ativo');
  });
});
