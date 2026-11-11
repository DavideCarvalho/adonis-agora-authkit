/**
 * Componentes prontos de conta/organização sobre as query options.
 *
 * Renderizados via react-dom/server dentro de uma página Inertia (a shared-prop
 * `authkit` alimenta `useAuth()`), com o cache do QueryClient já preenchido
 * (SSR lê o cache e não dispara fetch).
 */

import { App } from '@inertiajs/react';
import { test } from '@japa/runner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthkitProvider } from '../src/authkit_provider.js';
import { createAuthkitClient } from '../src/client/client.js';
import { AuthkitClientProvider } from '../src/client/context.js';
import { AuthorizedApps } from '../src/components/authorized_apps.js';
import { OrganizationProfile } from '../src/components/organization_profile.js';
import { OrganizationSwitcher } from '../src/components/organization_switcher.js';
import { UserProfile } from '../src/components/user_profile.js';
import { authkitKeys } from '../src/queries/keys.js';
import { createElementWithChildren } from './helpers/create_element.js';

const user = { id: 'u1', email: 'ana@acme.test', name: 'Ana' };

function render(
  node: ReactElement,
  seed: (qc: QueryClient) => void,
  authkit: { user: unknown; globalRoles: string[] } = { user, globalRoles: [] },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  const client = createAuthkitClient({
    baseUrl: '/admin/api',
    fetch: async () => {
      throw new Error('no fetch during SSR render');
    },
  });
  const Page = () =>
    createElement(
      QueryClientProvider,
      { client: qc },
      createElementWithChildren(
        AuthkitClientProvider,
        { client },
        createElementWithChildren(AuthkitProvider, {}, node),
      ),
    );
  return renderToStaticMarkup(
    createElement(App as any, {
      initialPage: {
        component: 'Page',
        props: { authkit },
        url: '/',
        version: null,
        clearHistory: false,
        encryptHistory: false,
      },
      initialComponent: Page,
      resolveComponent: () => Page,
      titleCallback: (t: string) => t,
      onHeadUpdate: () => {},
    }),
  );
}

const orgs = {
  supported: true,
  activeOrgId: 'o1',
  orgs: [
    { id: 'o1', name: 'Acme', slug: 'acme', logoUrl: null, role: 'owner', isActive: true },
    { id: 'o2', name: 'Globex', slug: 'globex', logoUrl: null, role: 'member', isActive: false },
  ],
};

test.group('OrganizationSwitcher', () => {
  test('mostra a org ativa a partir de account.orgs', ({ assert }) => {
    const html = render(createElement(OrganizationSwitcher, {}), (qc) =>
      qc.setQueryData(authkitKeys.account.orgs(), orgs),
    );
    assert.include(html, 'authkit-orgswitcher');
    assert.include(html, 'Acme');
  });

  test('sem suporte a organizations → vazio', ({ assert }) => {
    const html = render(createElement(OrganizationSwitcher, {}), (qc) =>
      qc.setQueryData(authkitKeys.account.orgs(), { ...orgs, supported: false }),
    );
    assert.equal(html, '');
  });

  test('não autenticado → vazio', ({ assert }) => {
    const html = render(createElement(OrganizationSwitcher, {}), () => {}, {
      user: null,
      globalRoles: [],
    });
    assert.equal(html, '');
  });
});

test.group('OrganizationProfile', () => {
  test('lista membros da org ativa e o convite para quem gerencia', ({ assert }) => {
    const html = render(createElement(OrganizationProfile, {}), (qc) => {
      qc.setQueryData(authkitKeys.account.orgs(), orgs);
      qc.setQueryData(authkitKeys.account.org('o1'), {
        id: 'o1',
        name: 'Acme',
        slug: 'acme',
        logoUrl: null,
        role: 'owner',
        canManage: true,
        members: [{ accountId: 'a1', email: 'bob@acme.test', role: 'admin', joinedAt: '' }],
      });
    });
    assert.include(html, 'Acme');
    assert.include(html, 'bob@acme.test');
    assert.include(html, 'authkit-org-profile__invite-form');
  });

  test('sem org ativa → vazio', ({ assert }) => {
    const html = render(createElement(OrganizationProfile, {}), (qc) =>
      qc.setQueryData(authkitKeys.account.orgs(), { ...orgs, activeOrgId: null }),
    );
    assert.equal(html, '');
  });
});

test.group('AuthorizedApps', () => {
  test('lista os apps de account.apps', ({ assert }) => {
    const html = render(createElement(AuthorizedApps, {}), (qc) =>
      qc.setQueryData(authkitKeys.account.apps(), {
        supported: true,
        apps: [
          {
            clientId: 'web-app',
            name: 'web-app',
            logoUrl: null,
            accessTokens: 1,
            refreshTokens: 1,
          },
        ],
      }),
    );
    assert.include(html, 'web-app');
    assert.include(html, 'Revogar');
  });

  test('mostra o nome e o logo registrados do client', ({ assert }) => {
    const html = render(createElement(AuthorizedApps, {}), (qc) =>
      qc.setQueryData(authkitKeys.account.apps(), {
        supported: true,
        apps: [
          {
            clientId: 'mcp-123',
            name: 'Claude Code',
            logoUrl: 'https://cdn.example.com/logo.png',
            accessTokens: 1,
            refreshTokens: 0,
          },
        ],
      }),
    );
    assert.include(html, 'Claude Code');
    assert.include(html, 'src="https://cdn.example.com/logo.png"');
    assert.include(html, 'authkit-apps__logo');
  });

  test('lista vazia → emptyLabel', ({ assert }) => {
    const html = render(createElement(AuthorizedApps, { emptyLabel: 'nada' }), (qc) =>
      qc.setQueryData(authkitKeys.account.apps(), { supported: true, apps: [] }),
    );
    assert.include(html, 'nada');
  });
});

test.group('UserProfile', () => {
  test('mostra nome e e-mail do usuário autenticado', ({ assert }) => {
    const html = render(createElement(UserProfile, {}), () => {});
    assert.include(html, 'Ana');
    assert.include(html, 'ana@acme.test');
  });
});
