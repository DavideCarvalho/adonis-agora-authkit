/**
 * Modo de IdP (`idp: 'authkit' | 'external'`).
 *
 * Com IdP externo (Keycloak/Auth0/Okta via authkit-client), os componentes
 * que dependem da REST surface do authkit-server degradam para `null`.
 * Renderizamos via react-dom/server com o provider — nenhum desses
 * componentes chega a chamar hooks de dados quando degrada.
 */
import { test } from '@japa/runner';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthkitProvider } from '../src/authkit_provider.js';
import { AuthorizedApps } from '../src/components/authorized_apps.js';
import { OrganizationProfile } from '../src/components/organization_profile.js';
import { OrganizationSwitcher } from '../src/components/organization_switcher.js';
import { UserProfile } from '../src/components/user_profile.js';
import { resolveConfig } from '../src/config.js';
import { createElementWithChildren } from './helpers/create_element.js';

test.group('resolveConfig — idp mode', () => {
  test('default é authkit', ({ assert }) => {
    assert.equal(resolveConfig().idp, 'authkit');
    assert.equal(resolveConfig({}).idp, 'authkit');
  });

  test('external é preservado', ({ assert }) => {
    assert.equal(resolveConfig({ idp: 'external' }).idp, 'external');
  });
});

test.group('componentes authkit-only degradam com idp external', () => {
  const renderExternal = (component: any) =>
    renderToStaticMarkup(
      createElementWithChildren(
        AuthkitProvider,
        { config: { idp: 'external' }, value: { user: null, isAuthenticated: false } as any },
        createElement(component, {}),
      ),
    );

  test('UserProfile → vazio', ({ assert }) => {
    assert.equal(renderExternal(UserProfile), '');
  });

  test('OrganizationSwitcher → vazio', ({ assert }) => {
    assert.equal(renderExternal(OrganizationSwitcher), '');
  });

  test('OrganizationProfile → vazio', ({ assert }) => {
    assert.equal(renderExternal(OrganizationProfile), '');
  });

  test('AuthorizedApps → vazio', ({ assert }) => {
    assert.equal(renderExternal(AuthorizedApps), '');
  });
});
