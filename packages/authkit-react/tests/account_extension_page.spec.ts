/**
 * `<AccountExtensionPage>` renders every block kind of a resolved page (the JSON the server's
 * `{prefix}/api/x/:pageId` returns), and the client methods hit the extensions API.
 */
import { test } from '@japa/runner';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountExtensionPage,
  type AccountExtensionProviderComponentProps,
} from '../src/account_extensions/account_extension_page.js';
import type { AccountExtensionPageView } from '../src/account_extensions/types.js';
import { createAuthkitClient } from '../src/client/client.js';

const button = {
  action: 'cancel',
  target: 'sub-a',
  label: 'Cancel',
  tone: 'danger' as const,
  sudo: true,
  step: true,
  href: '/account/billing/actions/cancel/confirm?target=sub-a',
  postHref: '/account/billing/actions/cancel',
  apiHref: '/account/api/x/billing.main/actions/cancel',
};
const direct = {
  ...button,
  action: 'resume',
  label: 'Resume',
  step: false,
  tone: 'default' as const,
  target: null,
  href: '/account/billing/actions/resume',
};
const text = { type: 'text' as const, text: 'x' };

const view: AccountExtensionPageView = {
  id: 'billing.main',
  extension: 'billing',
  title: 'Billing',
  href: '/account/billing',
  tabs: [{ id: 'a', label: 'A', href: '/account/billing?tab=a', active: true }],
  blocks: [
    { kind: 'notice', tone: 'info', text: '<script>alert(1)</script>' },
    {
      kind: 'keyValue',
      title: 'Plan',
      rows: [{ label: 'Price', value: { type: 'money', text: '$19.99' } }],
      actions: [button, direct],
    },
    {
      kind: 'list',
      title: null,
      empty: 'None',
      items: [
        {
          title: 'Inv',
          subtitle: null,
          meta: [text],
          badge: { type: 'badge', text: 'paid', tone: 'success' },
          href: '/x',
          external: false,
          actions: [],
        },
      ],
      nextHref: '/account/billing?cursor=2',
      nextCursor: '2',
    },
    {
      kind: 'table',
      title: null,
      empty: 'None',
      columns: [{ id: 'a', label: 'A' }],
      rows: [{ cells: [text], actions: [] }],
      hasActions: false,
      nextHref: null,
      nextCursor: null,
    },
    {
      kind: 'meter',
      label: 'Tokens',
      used: 5,
      limit: 10,
      percent: 50,
      text: '5 / 10',
      resetsAt: { type: 'date', text: 'tomorrow', iso: '2026-01-01T00:00:00.000Z' },
    },
    { kind: 'actions', items: [direct] },
    { kind: 'link', label: 'Portal', href: 'https://portal.example.com', external: true },
    {
      kind: 'toolPreview',
      title: 'Send email',
      tool: 'send_email',
      subtitle: null,
      args: [{ label: 'to', value: text }],
      body: { format: 'json', content: '{"a":1}' },
      actions: [],
    },
    {
      kind: 'component',
      provider: 'stripe',
      mountId: 'm1',
      scripts: [],
      propsJson: '{}',
      props: { key: 'pk' },
      submit: direct,
      fallback: { label: 'Update on Stripe', href: 'https://billing.stripe.com', external: true },
    },
  ],
};

test.group('AccountExtensionPage', () => {
  test('renders every block kind with data attributes, escaped', ({ assert }) => {
    const html = renderToStaticMarkup(
      createElement(AccountExtensionPage, { view, csrfToken: 'tok' }),
    );
    for (const kind of [
      'notice',
      'keyValue',
      'list',
      'table',
      'meter',
      'actions',
      'link',
      'toolPreview',
      'component',
      'tabs',
    ]) {
      assert.include(html, `data-block="${kind}"`, kind);
    }
    assert.notInclude(html, '<script>');
    assert.include(html, '&lt;script&gt;');
    // step → link; direct → form with csrf
    assert.include(html, 'href="/account/billing/actions/cancel/confirm?target=sub-a"');
    assert.include(html, 'action="/account/billing/actions/resume"');
    assert.include(html, 'value="tok"');
    assert.include(html, 'rel="next"');
    // no loader → the component block shows its fallback
    assert.include(html, 'Update on Stripe');
  });

  test('with onAction every button is a button', ({ assert }) => {
    const html = renderToStaticMarkup(
      createElement(AccountExtensionPage, { view, onAction: () => {} }),
    );
    assert.notInclude(html, '<form');
    assert.include(html, 'data-action="cancel"');
  });

  test('a provider component loads after mount; SSR shows the fallback', ({ assert }) => {
    const Card = (p: AccountExtensionProviderComponentProps) =>
      createElement('div', { 'data-card': p.provider }, String(p.props.key));
    // The loader resolves after mount (effects do not run in SSR): the fallback is rendered first.
    const html = renderToStaticMarkup(
      createElement(AccountExtensionPage, { view, loadComponent: () => Card }),
    );
    assert.include(html, 'Update on Stripe');
  });
});

test.group('client.account.extensions', () => {
  test('list, page and action hit the JSON API', async ({ assert }) => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const client = createAuthkitClient({
      accountBaseUrl: '/conta/api',
      csrfToken: 'tok',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), body: init.body as string | undefined });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as never,
    });
    await client.account.extensions.list();
    await client.account.extensions.page('billing.main', { cursor: 'c2' });
    await client.account.extensions.action('billing.main', 'cancel', {
      target: 'sub-a',
      fields: { reason: 'price' },
    });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'GET /conta/api/extensions',
        'GET /conta/api/x/billing.main?cursor=c2',
        'POST /conta/api/x/billing.main/actions/cancel',
      ],
    );
    assert.deepEqual(JSON.parse(calls[2]?.body ?? '{}'), {
      target: 'sub-a',
      fields: { reason: 'price' },
    });
  });
});
