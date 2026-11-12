import { test } from '@japa/runner';
import {
  ACCOUNT_BLOCK_KINDS,
  ACCOUNT_EXTENSION_CONTRACT,
  ACCOUNT_EXTENSIONS_BINDING,
  type AccountExtension,
  type AccountExtensionContext,
} from '../../src/account/extension.js';
import {
  apiAction,
  apiExtensions,
  apiPage,
  componentScriptTag,
  postAction,
  showActionStep,
  showPage,
} from '../../src/account/http.js';
import { AccountExtensionRegistryImpl } from '../../src/account/registry.js';
import {
  buildAccountNav,
  findPageById,
  formatValue,
  jsonForDataBlock,
  makeTranslator,
  safeHref,
  safeScriptSrc,
} from '../../src/account/runtime.js';
import { fakeCtx, resetAccountConsoleState, serve } from './helpers.js';

/** Owned rows of the sample extension, by account. The handlers re-derive ownership. */
const SUBSCRIPTIONS: Record<string, string> = { 'sub-a': 'acc-1', 'sub-b': 'acc-2' };

function sampleExtension(overrides: Partial<AccountExtension> = {}): AccountExtension {
  return {
    id: 'billing',
    contract: 1,
    messages: {
      en: { 'billing.title': 'Billing', 'billing.cancelled': 'Cancelled {id}.' },
      'pt-BR': { 'billing.title': 'Cobrança' },
    },
    scriptOrigins: ['https://js.stripe.com'],
    pages: [
      {
        id: 'billing.subscription',
        segment: 'billing',
        title: { key: 'billing.title' },
        nav: { group: 'billing', order: 100 },
        async load(ctx) {
          return {
            tabs: [
              { id: 'current', label: 'Current' },
              { id: 'history', label: 'History' },
            ],
            blocks: [
              { kind: 'notice', tone: 'info', text: 'Hello <script>alert(1)</script>' },
              {
                kind: 'keyValue',
                title: 'Plan',
                rows: [
                  { label: 'Price', value: { type: 'money', amount: 1999, currency: 'USD' } },
                  { label: 'Status', value: { type: 'badge', text: 'active', tone: 'success' } },
                  { label: 'Since', value: { type: 'date', at: '2026-01-02T03:04:05Z' } },
                  { label: 'Seats', value: { type: 'number', value: 1234, unit: 'seats' } },
                  { label: 'Owner', value: { type: 'text', text: ctx.subject.id } },
                ],
                actions: [{ action: 'cancel', target: 'sub-a' }, { action: 'resume' }],
              },
              {
                kind: 'list',
                title: 'Invoices',
                empty: 'None',
                items: [
                  {
                    title: 'Inv 1',
                    href: '/account/billing?tab=history',
                    meta: [{ type: 'text', text: 'meta' }],
                  },
                  { title: 'Evil', href: 'javascript:alert(1)' },
                  { title: 'Ext', href: 'https://pay.example.com/x', external: true },
                ],
                nextCursor: 'c2',
              },
              {
                kind: 'table',
                empty: 'No rows',
                columns: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                rows: [
                  {
                    cells: { a: { type: 'text', text: 'x' } },
                    actions: [{ action: 'cancel', target: 'sub-a' }],
                  },
                ],
              },
              { kind: 'meter', label: 'Tokens', used: 50, limit: 200, unit: 'k' },
              { kind: 'actions', items: [{ action: 'note' }] },
              { kind: 'link', label: 'Portal', href: 'https://portal.example.com', external: true },
              {
                kind: 'toolPreview',
                title: 'Send email',
                tool: 'send_email',
                args: [{ label: 'to', value: { type: 'text', text: 'x@y.z' } }],
                body: { format: 'json', content: '{"html":"<b>hi</b>"}' },
                actions: [{ action: 'cancel', target: 'sub-a' }],
              },
              {
                kind: 'component',
                provider: 'stripe',
                scripts: [
                  { src: 'https://js.stripe.com/v3/' },
                  { src: '/billing/assets/card.js', module: true },
                ],
                props: { key: 'pk_test', label: '</script><b>x</b>' },
                submit: { action: 'resume' },
                fallback: {
                  label: 'Update on Stripe',
                  href: 'https://billing.stripe.com/p',
                  external: true,
                },
              },
              { kind: 'mystery' } as never,
            ],
          };
        },
        actions: {
          cancel: {
            label: 'Cancel',
            tone: 'danger',
            confirm: 'Cancel your subscription?',
            sudo: true,
            fields: [
              {
                name: 'reason',
                label: 'Reason',
                kind: 'select',
                options: [{ value: 'price', label: 'Price' }],
              },
              { name: 'note', label: 'Note', kind: 'text', maxLength: 5 },
            ],
            async handle(ctx, input) {
              // IDOR rule: re-derive ownership; another account's row is "not found".
              if (!input.target || SUBSCRIPTIONS[input.target] !== ctx.account.id) {
                return { ok: false, error: 'Not found', status: 404 };
              }
              return {
                ok: true,
                flash: { key: 'billing.cancelled', params: { id: input.target } },
              };
            },
          },
          resume: {
            label: 'Resume',
            async handle() {
              return { ok: true, redirectTo: { external: 'https://billing.stripe.com/session' } };
            },
          },
          note: {
            label: 'Note',
            async handle() {
              return { ok: true, redirectTo: { page: 'billing.other' } };
            },
          },
        },
      },
      {
        id: 'billing.other',
        segment: 'invoices',
        title: 'Other',
        nav: { group: 'billing', order: 110 },
        async load() {
          return { blocks: [] };
        },
      },
    ],
    ...overrides,
  };
}

test.group('account extensions | contract', () => {
  test('constants and block kinds', ({ assert }) => {
    assert.equal(ACCOUNT_EXTENSIONS_BINDING, 'authkit.accountExtensions');
    assert.equal(ACCOUNT_EXTENSION_CONTRACT, 1);
    const registry = new AccountExtensionRegistryImpl();
    assert.equal(registry.contract, 1);
    assert.includeMembers([...registry.blockKinds], [...ACCOUNT_BLOCK_KINDS]);
  });
});

test.group('account extensions | registry', () => {
  test('rejects invalid ids, contracts, message keys, segments and origins', ({ assert }) => {
    const bad: Array<[Partial<AccountExtension>, RegExp]> = [
      [{ id: 'X' }, /invalid id/],
      [{ id: 'security' }, /invalid id/],
      [{ contract: 2 }, /contract 2/],
      [{ messages: { en: { 'other.key': 'x' } } }, /must start with "billing\."/],
      [{ scriptOrigins: ['http://js.example.com'] }, /https origin/],
      [{ scriptOrigins: ['https://js.example.com/v3'] }, /https origin/],
    ];
    for (const [patch, error] of bad) {
      const registry = new AccountExtensionRegistryImpl();
      assert.throws(() => registry.register(sampleExtension(patch)), error);
    }
    const reserved = sampleExtension();
    (reserved.pages[0] as any).segment = 'api';
    assert.throws(() => new AccountExtensionRegistryImpl().register(reserved), /reserved segment/);
    const badPageId = sampleExtension();
    (badPageId.pages[0] as any).id = 'other.page';
    assert.throws(() => new AccountExtensionRegistryImpl().register(badPageId), /page id/);
  });

  test('duplicates and segment collisions between extensions name the extension', ({ assert }) => {
    const registry = new AccountExtensionRegistryImpl();
    registry.register(sampleExtension());
    assert.throws(() => registry.register(sampleExtension()), /"billing" — is registered twice/);
    const other = sampleExtension({ id: 'other', messages: {} });
    (other.pages[0] as any).id = 'other.a';
    (other.pages[1] as any).id = 'other.b';
    assert.throws(() => registry.register(other), /already used by "billing"/);
  });

  test('production skips an invalid extension and logs once', ({ assert }) => {
    const logs: string[] = [];
    const registry = new AccountExtensionRegistryImpl({
      production: () => true,
      log: (m) => logs.push(m),
    });
    registry.register(sampleExtension({ contract: 9 }));
    assert.lengthOf(registry.extensions(), 0);
    assert.lengthOf(logs, 1);
    assert.match(logs[0] as string, /billing.*skipped/);
  });

  test('register after the freeze throws with the fix', ({ assert }) => {
    const registry = new AccountExtensionRegistryImpl();
    registry.freeze({ production: false });
    assert.throws(() => registry.register(sampleExtension()), /from your provider's boot\(\)/);
  });

  test('host overrides disable, rename and reorder', ({ assert }) => {
    const registry = new AccountExtensionRegistryImpl();
    registry.register(sampleExtension());
    const pages = registry.freeze({
      production: false,
      overrides: {
        billing: {
          pages: {
            'billing.other': false,
            'billing.subscription': { segment: 'cobranca', order: 5 },
          },
        },
      },
    });
    assert.deepEqual(
      pages.map((p) => [p.page.id, p.segment, p.order]),
      [['billing.subscription', 'cobranca', 5]],
    );
    const off = new AccountExtensionRegistryImpl();
    off.register(sampleExtension());
    assert.lengthOf(off.freeze({ production: false, overrides: { billing: false } }), 0);
  });

  test('a segment that collides with a renamed built-in screen is refused at freeze', ({
    assert,
  }) => {
    const registry = new AccountExtensionRegistryImpl();
    registry.register(sampleExtension());
    assert.throws(
      () => registry.freeze({ production: false, builtinSegments: ['billing'] }),
      /collides with a built-in screen/,
    );
  });
});

test.group('account extensions | values and hrefs', () => {
  test('safe hrefs: same-origin paths and https only', ({ assert }) => {
    assert.equal(safeHref('/account/x'), '/account/x');
    assert.isNull(safeHref('//evil.com'));
    assert.isNull(safeHref('/\\evil.com'));
    assert.isNull(safeHref('javascript:alert(1)'));
    assert.isNull(safeHref('/a b'));
    assert.isNull(safeHref('http://x.com', true));
    assert.equal(safeHref('https://x.com/p', true), 'https://x.com/p');
    assert.isNull(safeHref('https://x.com/p'));
    assert.equal(
      safeScriptSrc('https://js.stripe.com/v3/', ['https://js.stripe.com']),
      'https://js.stripe.com/v3/',
    );
    assert.isNull(safeScriptSrc('https://evil.com/x.js', ['https://js.stripe.com']));
  });

  test('values are formatted with Intl in the console locale', ({ assert }) => {
    const t = makeTranslator({}, 'pt-BR', []);
    const now = new Date('2026-01-10T00:00:00Z');
    assert.include(
      formatValue({ type: 'money', amount: 1999, currency: 'BRL' }, t, 'pt-BR', now).text,
      '19,99',
    );
    assert.equal(
      formatValue({ type: 'money', amount: 500, currency: 'JPY' }, t, 'en', now).text,
      '¥500',
    );
    assert.equal(formatValue({ type: 'number', value: 1234 }, t, 'pt-BR', now).text, '1.234');
    assert.equal(
      formatValue({ type: 'date', at: '2026-01-09T00:00:00Z', style: 'relative' }, t, 'en', now)
        .text,
      'yesterday',
    );
  });

  test('messages: host overrides win over the extension catalogs', ({ assert }) => {
    const catalogs = [{ en: { 'x.a': 'A en' }, 'pt-BR': { 'x.a': 'A pt' } }];
    assert.equal(makeTranslator({}, 'pt-BR', catalogs)({ key: 'x.a' }), 'A pt');
    assert.equal(makeTranslator({}, 'es', catalogs)({ key: 'x.a' }), 'A en');
    assert.equal(makeTranslator({ 'x.a': 'host' }, 'pt-BR', catalogs)({ key: 'x.a' }), 'host');
    assert.equal(makeTranslator({}, 'en', catalogs)({ key: 'x.missing' }), 'x.missing');
  });

  test('JSON data blocks never close the script tag', ({ assert }) => {
    const json = jsonForDataBlock({ a: '</script><script>alert(1)</script>' });
    assert.notInclude(json, '</script>');
    assert.deepEqual(JSON.parse(json), { a: '</script><script>alert(1)</script>' });
  });

  test('component scripts carry the nonce, integrity and module type', ({ assert }) => {
    const tag = componentScriptTag(
      { src: 'https://js.stripe.com/v3/', integrity: 'sha384-abc', module: false },
      'n0nce',
    );
    assert.equal(
      tag,
      '<script src="https://js.stripe.com/v3/" defer nonce="n0nce" integrity="sha384-abc" crossorigin="anonymous"></script>',
    );
    assert.equal(
      componentScriptTag({ src: '/a.js', integrity: null, module: true }, null),
      '<script src="/a.js" type="module"></script>',
    );
  });
});

test.group('account extensions | pages', (group) => {
  group.each.teardown(() => resetAccountConsoleState());

  test('renders every block kind, escaped, with the nav and the CSP nonce', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, rendered } = fakeCtx({ nonce: 'abc123' });
    const page = findPageById('billing.subscription');
    await showPage(ctx, page!);
    const html = rendered.html ?? '';
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
    ]) {
      assert.include(html, `data-block="${kind}"`, kind);
    }
    assert.notInclude(html, '<script>alert(1)</script>');
    assert.include(html, 'Hello &lt;script&gt;alert(1)&lt;/script&gt;');
    assert.include(html, '$19.99');
    assert.include(html, 'data-account-nav');
    assert.include(html, 'href="/account/billing"');
    assert.include(html, 'aria-current="page"');
    // unsafe list href dropped, the rest kept
    assert.notInclude(html, 'javascript:');
    assert.include(html, 'href="/account/billing?tab=history"');
    // next page cursor
    assert.include(html, '/account/billing?cursor=c2');
    // unknown block → notice
    assert.include(html, 'This section cannot be shown here.');
    // tool preview body escaped
    assert.include(html, '{&quot;html&quot;:&quot;&lt;b&gt;hi&lt;/b&gt;&quot;}');
    // component: nonce on every script, props in a data block that cannot close the tag
    assert.include(html, '<script src="https://js.stripe.com/v3/" defer nonce="abc123"></script>');
    assert.include(
      html,
      '<script src="/billing/assets/card.js" type="module" nonce="abc123"></script>',
    );
    assert.include(html, 'type="application/json"');
    assert.notInclude(html, '</script><b>x</b>');
    assert.include(html, 'Update on Stripe');
    // actions: step link for confirm/fields, direct form otherwise
    assert.include(html, 'href="/account/billing/actions/cancel/confirm?target=sub-a"');
    assert.include(html, 'action="/account/billing/actions/resume"');
    assert.include(html, 'name="_csrf" value="csrf-token"');
  });

  test('a component script from an origin the extension did not declare is refused', async ({
    assert,
  }) => {
    const ext = sampleExtension({ scriptOrigins: [] });
    serve([ext]);
    const { ctx, rendered } = fakeCtx();
    await showPage(ctx, findPageById('billing.subscription')!);
    assert.notInclude(rendered.html ?? '', 'js.stripe.com/v3');
    assert.include(rendered.html ?? '', 'loads a script from an address that is not allowed');
  });

  test('a load() that throws or times out is isolated to its page', async ({ assert }) => {
    const ext = sampleExtension({
      pages: [
        {
          id: 'billing.a',
          segment: 'a',
          title: 'A',
          load: async () => {
            throw new Error('db down');
          },
        },
        { id: 'billing.b', segment: 'b', title: 'B', load: () => new Promise(() => {}) },
      ],
    });
    serve([ext]);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const a = fakeCtx();
      await showPage(a.ctx, findPageById('billing.a')!);
      assert.include(a.rendered.html ?? '', 'could not be loaded');
      const b = fakeCtx({ config: { accountConsole: { loadTimeoutMs: 20 } } });
      await showPage(b.ctx, findPageById('billing.b')!);
      assert.include(b.rendered.html ?? '', 'could not be loaded');
    } finally {
      console.error = original;
    }
    assert.isAtLeast(errors.length, 2);
  });

  test('visible() false or throwing hides the page (404) and its nav entry', async ({ assert }) => {
    const ext = sampleExtension();
    (ext.pages[0] as any).visible = async () => false;
    (ext.pages[1] as any).visible = async () => {
      throw new Error('boom');
    };
    serve([ext]);
    const original = console.error;
    console.error = () => {};
    try {
      const { ctx, out } = fakeCtx();
      await showPage(ctx, findPageById('billing.subscription')!);
      assert.equal(out.statusCode, 404);
      const nav = await buildAccountNav(fakeCtx().ctx, null);
      assert.deepEqual(
        nav.map((n) => n.id),
        ['security', 'tokens', 'apps'],
      );
    } finally {
      console.error = original;
    }
  });

  test('nav merges built-ins and extensions by group, order and id', async ({ assert }) => {
    const ext = sampleExtension();
    const ai = sampleExtension({ id: 'ai', messages: {}, scriptOrigins: [] });
    (ai as any).pages = [
      {
        id: 'ai.usage',
        segment: 'ai',
        title: 'AI',
        nav: { group: 'ai', order: 1 },
        load: async () => ({ blocks: [] }),
      },
      {
        id: 'ai.mine',
        segment: 'mine',
        title: 'Mine',
        nav: { order: 5 },
        load: async () => ({ blocks: [] }),
      },
      {
        id: 'ai.hidden',
        segment: 'hidden',
        title: 'Hidden',
        nav: false,
        load: async () => ({ blocks: [] }),
      },
    ];
    serve([ext, ai], {
      builtins: {
        security: '/account/security',
        mfa: '/account/mfa',
        tokens: '/account/tokens',
        apps: '/account/apps',
        orgs: '/account/orgs',
      },
    });
    const nav = await buildAccountNav(fakeCtx().ctx, 'billing.other');
    assert.deepEqual(
      nav.map((n) => n.id),
      [
        'ai.mine',
        'security',
        'mfa',
        'tokens',
        'apps',
        'orgs',
        'billing.subscription',
        'billing.other',
        'ai.usage',
      ],
    );
    assert.isTrue(nav.find((n) => n.id === 'billing.other')?.active);
    assert.equal(nav.find((n) => n.id === 'billing.subscription')?.label, 'Billing');
  });

  test('the context: subject hook, active org and impersonation', async ({ assert }) => {
    let seen: AccountExtensionContext | null = null;
    const ext = sampleExtension();
    (ext.pages[1] as any).load = async (c: AccountExtensionContext) => {
      seen = c;
      return { blocks: [] };
    };
    serve([ext]);
    const { ctx } = fakeCtx({
      query: { cursor: 'x', tab: 'ok', evil: '1' },
      impersonator: 'admin-9',
      config: {
        accountConsole: {
          subject: (account: { id: string }) => ({ type: 'Customer', id: `c-${account.id}` }),
        },
      },
    });
    await showPage(ctx, findPageById('billing.other')!);
    const c = seen as unknown as AccountExtensionContext;
    assert.deepEqual(c.subject, { type: 'Customer', id: 'c-acc-1' });
    assert.deepEqual(c.query, { cursor: 'x', tab: 'ok' });
    assert.equal(c.impersonatedBy, 'admin-9');
    assert.equal(c.account.email, 'ana@example.com');
    assert.isNull(c.activeOrg);
    assert.equal(c.url('billing.subscription', { tab: 'history' }), '/account/billing?tab=history');
  });

  test('confirmation step renders fields and posts to the action', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, rendered } = fakeCtx({ params: { action: 'cancel' }, query: { target: 'sub-a' } });
    await showActionStep(ctx, findPageById('billing.subscription')!);
    const html = rendered.html ?? '';
    assert.include(html, 'data-block="confirm"');
    assert.include(html, 'Cancel your subscription?');
    assert.include(html, 'action="/account/billing/actions/cancel"');
    assert.include(html, 'name="target" value="sub-a"');
    assert.include(html, 'name="field_reason"');
    assert.include(html, 'maxlength=5');
  });
});

test.group('account extensions | actions', (group) => {
  group.each.teardown(() => resetAccountConsoleState());

  test('sudo actions send the user through /account/confirm and back to the step', async ({
    assert,
  }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({ params: { action: 'cancel' }, body: { target: 'sub-a' } });
    await postAction(ctx, findPageById('billing.subscription')!);
    assert.equal(out.statusCode, 302);
    assert.equal(
      out.location,
      `/account/confirm?return_to=${encodeURIComponent('/account/billing/actions/cancel/confirm?target=sub-a')}`,
    );
  });

  test('IDOR: another account target answers not found', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out, flashed } = fakeCtx({
      sudo: true,
      params: { action: 'cancel' },
      body: { target: 'sub-b', field_reason: 'price' },
    });
    await postAction(ctx, findPageById('billing.subscription')!);
    assert.equal(out.statusCode, 302);
    assert.deepEqual(flashed.get('authkit_account_extension'), {
      tone: 'danger',
      text: 'Not found',
    });
    const json = fakeCtx({
      sudo: true,
      params: { pageId: 'billing.subscription', action: 'cancel' },
      body: { target: 'sub-b', fields: { reason: 'price' } },
    });
    await apiAction(json.ctx);
    assert.equal(json.out.statusCode, 404);
  });

  test('fields are validated against the declaration', async ({ assert }) => {
    serve([sampleExtension()]);
    const run = async (fields: Record<string, string>) => {
      const c = fakeCtx({
        sudo: true,
        params: { pageId: 'billing.subscription', action: 'cancel' },
        body: { target: 'sub-a', fields },
      });
      await apiAction(c.ctx);
      return c.out;
    };
    assert.equal((await run({ reason: 'nope' })).statusCode, 422);
    assert.equal((await run({ reason: 'price', note: 'too long' })).statusCode, 422);
    const ok = await run({ reason: 'price', note: 'ok' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, {
      ok: true,
      flash: 'Cancelled sub-a.',
      redirectTo: null,
      external: false,
    });
  });

  test('impersonation refuses danger and sudo actions', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({
      sudo: true,
      impersonator: 'admin-1',
      params: { pageId: 'billing.subscription', action: 'cancel' },
      body: { target: 'sub-a', fields: { reason: 'price' } },
    });
    await apiAction(ctx);
    assert.equal(out.statusCode, 403);
    assert.equal((out.body as any).error.code, 'impersonation_refused');
  });

  test('external redirects are https-only and audited; page redirects resolve', async ({
    assert,
  }) => {
    serve([sampleExtension()]);
    const audit: Array<Record<string, unknown>> = [];
    const { ctx, out } = fakeCtx({ params: { action: 'resume' }, audit });
    await postAction(ctx, findPageById('billing.subscription')!);
    assert.equal(out.location, 'https://billing.stripe.com/session');
    assert.equal(audit[0]?.type, 'account.extension.redirect');
    const note = fakeCtx({ params: { action: 'note' } });
    await postAction(note.ctx, findPageById('billing.subscription')!);
    assert.equal(note.out.location, '/account/invoices');
  });

  test('JSON sudo refusal points at the confirmation page', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({
      params: { pageId: 'billing.subscription', action: 'cancel' },
      body: { target: 'sub-a' },
    });
    await apiAction(ctx);
    assert.equal(out.statusCode, 403);
    assert.equal((out.body as any).error.code, 'sudo_required');
  });
});

test.group('account extensions | review fixes', (group) => {
  group.each.teardown(() => resetAccountConsoleState());

  test('a load() that returns no view is isolated too', async ({ assert }) => {
    const ext = sampleExtension({
      pages: [{ id: 'billing.a', segment: 'a', title: 'A', load: async () => null as never }],
    });
    serve([ext]);
    const original = console.error;
    console.error = () => {};
    try {
      const { ctx, rendered } = fakeCtx();
      await showPage(ctx, findPageById('billing.a')!);
      assert.include(rendered.html ?? '', 'could not be loaded');
    } finally {
      console.error = original;
    }
  });

  test('refused fields send the user back to the step with the target', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({
      sudo: true,
      params: { action: 'cancel' },
      body: { target: 'sub-a', field_reason: 'nope' },
    });
    await postAction(ctx, findPageById('billing.subscription')!);
    assert.equal(out.location, '/account/billing/actions/cancel/confirm?target=sub-a');
  });

  test('JSON sudo refusal returns to the step of the attempted action', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({
      params: { pageId: 'billing.subscription', action: 'cancel' },
      body: { target: 'sub-a' },
    });
    await apiAction(ctx);
    assert.equal(
      (out.body as any).error.confirmUrl,
      `/account/confirm?return_to=${encodeURIComponent('/account/billing/actions/cancel/confirm?target=sub-a')}`,
    );
  });

  test('a component form posts to the action even when it has a confirmation step', async ({
    assert,
  }) => {
    const ext = sampleExtension();
    (ext.pages[1] as any).load = async () => ({
      blocks: [{ kind: 'component', provider: 'stripe', scripts: [], submit: { action: 'x' } }],
    });
    (ext.pages[1] as any).actions = {
      x: { label: 'X', confirm: 'Sure?', handle: async () => ({ ok: true }) },
    };
    serve([ext]);
    const { ctx, rendered } = fakeCtx();
    await showPage(ctx, findPageById('billing.other')!);
    assert.include(rendered.html ?? '', 'action="/account/invoices/actions/x" data-component-form');
  });

  test('actionTimeoutMs bounds handle()', async ({ assert }) => {
    const ext = sampleExtension();
    (ext.pages[1] as any).actions = {
      slow: { label: 'Slow', handle: () => new Promise(() => {}) },
    };
    serve([ext]);
    const original = console.error;
    console.error = () => {};
    try {
      const { ctx, out } = fakeCtx({
        params: { pageId: 'billing.other', action: 'slow' },
        config: { accountConsole: { actionTimeoutMs: 20 } },
      });
      await apiAction(ctx);
      assert.equal(out.statusCode, 400);
    } finally {
      console.error = original;
    }
  });
});

test.group('account extensions | JSON API', (group) => {
  group.each.teardown(() => resetAccountConsoleState());

  test('page round-trip: resolved blocks and action definitions', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx({ params: { pageId: 'billing.subscription' } });
    await apiPage(ctx);
    const body = JSON.parse(JSON.stringify(out.body));
    assert.equal(body.page.title, 'Billing');
    assert.equal(body.page.blocks.length, 10);
    assert.equal(body.page.blocks[1].rows[0].value.text, '$19.99');
    assert.equal(body.actions.cancel.fields[0].options[0].label, 'Price');
    assert.isTrue(body.actions.cancel.sudo);
    assert.equal(out.headers['cache-control'], 'private, no-store');
  });

  test('unknown page id and signed-out request answer 404', async ({ assert }) => {
    serve([sampleExtension()]);
    const a = fakeCtx({ params: { pageId: 'billing.nope' } });
    await apiPage(a.ctx);
    assert.equal(a.out.statusCode, 404);
    const b = fakeCtx({ accountId: null, params: { pageId: 'billing.subscription' } });
    await apiPage(b.ctx);
    assert.equal(b.out.statusCode, 404);
  });

  test('extensions endpoint lists the localized nav', async ({ assert }) => {
    serve([sampleExtension()]);
    const { ctx, out } = fakeCtx();
    await apiExtensions(ctx);
    const body = out.body as any;
    assert.deepEqual(
      body.pages.map((p: any) => [p.id, p.href, p.label]),
      [
        ['billing.subscription', '/account/billing', 'Billing'],
        ['billing.other', '/account/invoices', 'Other'],
      ],
    );
    assert.includeMembers(
      body.nav.map((n: any) => n.id),
      ['security', 'tokens', 'apps'],
    );
  });
});
