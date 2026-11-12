import {
  ACCOUNT_EXTENSIONS_SCOPE,
  ACCOUNT_EXTENSIONS_TOKEN_TYP,
  type AccountExtension,
  BaseAccountExtensionRegistry,
  buildAccountExtensionsManifest,
  parseAccountExtensionCall,
  runAccountExtensionCall,
} from '@adonis-agora/authkit-core';
import { test } from '@japa/runner';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import { apiPage, postAction, showPage } from '../../src/account/http.js';
import { AccountExtensionRegistryImpl } from '../../src/account/registry.js';
import {
  RemoteAccountExtensions,
  type RemoteSigningSource,
  signRemoteExtensionToken,
} from '../../src/account/remote.js';
import {
  accountExtensionPages,
  buildAccountNav,
  findPageById,
  remoteAccountPageBySegment,
  setAccountConsoleState,
} from '../../src/account/runtime.js';
import { fakeCtx, resetAccountConsoleState, serve } from './helpers.js';

const ISSUER = 'https://idp.test/oidc';

async function signing(): Promise<{ source: RemoteSigningSource; publicJwks: { keys: any[] } }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const priv = { ...(await exportJWK(privateKey)), alg: 'ES256', kid: 'k1' };
  const pub = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'k1' };
  return { source: { issuer: ISSUER, signingJwks: { keys: [priv] } }, publicJwks: { keys: [pub] } };
}

/** The app side: owned subscriptions per account, re-checked by the handler. */
const OWNED: Record<string, string[]> = { 'acc-1': ['sub-a'], 'acc-2': ['sub-b'] };

function appExtension(calls: string[] = []): AccountExtension {
  return {
    id: 'billing',
    contract: 1,
    messages: { en: { 'billing.title': 'Billing' } },
    pages: [
      {
        id: 'billing.plan',
        segment: 'plan',
        title: { key: 'billing.title' },
        nav: { group: 'billing', order: 5 },
        visible: async (ctx) => (OWNED[ctx.account.id] ?? []).length > 0,
        load: async (ctx) => {
          calls.push(`load:${ctx.subject.type}:${ctx.subject.id}:${ctx.tenant?.id ?? '-'}`);
          return {
            blocks: [
              {
                kind: 'notice',
                tone: 'info',
                text: `Plan of ${ctx.account.email} <b>pro</b> ${ctx.url('billing.plan')}`,
              },
              { kind: 'actions', items: [{ action: 'cancel', target: 'sub-a' }] },
            ],
          };
        },
        actions: {
          cancel: {
            label: 'Cancel',
            tone: 'danger',
            confirm: 'Sure?',
            sudo: true,
            handle: async (ctx, input) => {
              calls.push(`cancel:${input.target}`);
              if (!(OWNED[ctx.account.id] ?? []).includes(input.target ?? '')) {
                return { ok: false, error: 'Not found', status: 404 };
              }
              return { ok: true, flash: 'Cancelled' };
            },
          },
        },
      },
    ],
  };
}

/**
 * A fake app: answers `/.well-known/agora-account-extensions` with the same code authkit-client
 * runs (manifest, token checks, call), verifying against the IdP's public keys.
 */
async function fakeApp(options: {
  publicJwks: { keys: any[] };
  extensions: AccountExtension[];
  clientId?: string;
  down?: () => boolean;
  requests?: string[];
}) {
  // The app side is authkit-client's own code (resolved at runtime only: the two packages
  // typecheck separately).
  const clientModule: string = new URL(
    '../../../authkit-client/src/account_extensions.ts',
    import.meta.url,
  ).href;
  const { serveAccountExtensions } = (await import(clientModule)) as {
    serveAccountExtensions: (input: any) => Promise<{ status: number; body: unknown }>;
  };
  const keys = createLocalJWKSet(options.publicJwks as never);
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    options.requests?.push(`${init.method ?? 'GET'} ${url}`);
    if (options.down?.()) throw new TypeError('fetch failed');
    const headers = init.headers as Record<string, string>;
    const answer = await serveAccountExtensions({
      method: init.method ?? 'GET',
      authorization: headers.authorization,
      rawBody: typeof init.body === 'string' ? init.body : null,
      extensions: options.extensions,
      contract: 1,
      verifier: { issuer: ISSUER, clientId: options.clientId ?? 'app', keys },
      config: {
        remote: true,
        subject: (account: { id: string }) => ({ type: 'Member', id: `m-${account.id}` }),
      },
      make: async () => null,
      log: () => {},
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return fetchImpl;
}

async function idpWith(options: {
  extensions?: AccountExtension[];
  local?: AccountExtension[];
  down?: () => boolean;
  requests?: string[];
  ttlMs?: number;
  now?: () => number;
  logs?: string[];
}) {
  const keys = await signing();
  const fetchImpl = await fakeApp({
    publicJwks: keys.publicJwks,
    extensions: options.extensions ?? [appExtension()],
    ...(options.down ? { down: options.down } : {}),
    ...(options.requests ? { requests: options.requests } : {}),
  });
  const remote = new RemoteAccountExtensions(
    [
      {
        clientId: 'app',
        url: 'https://app.test',
        ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
      },
    ],
    {
      signing: () => keys.source,
      fetch: fetchImpl,
      pathOf: (segment) => `/account/${segment}`,
      log: (m) => options.logs?.push(m),
      ...(options.now ? { now: options.now } : {}),
    },
  );
  const { registry, pages } = serve(options.local ?? []);
  setAccountConsoleState({
    pages,
    registry,
    remote,
    builtinSegments: ['security', 'mfa', 'tokens', 'apps', 'orgs', 'login', 'logout', 'confirm'],
  });
  await remote.start();
  return { remote, keys };
}

test.group('remote account extensions | wire', () => {
  test('the manifest describes pages and actions, never handlers', ({ assert }) => {
    const manifest = buildAccountExtensionsManifest([appExtension()], 1);
    assert.equal(manifest.version, 1);
    const page = manifest.extensions[0]!.pages[0]!;
    assert.equal(page.segment, 'plan');
    assert.isTrue(page.conditional);
    assert.deepEqual(page.actions.cancel, {
      label: 'Cancel',
      tone: 'danger',
      confirm: 'Sure?',
      sudo: true,
      fields: [],
    });
    assert.notInclude(JSON.stringify(manifest), 'handle');
  });

  test('malformed calls are refused', ({ assert }) => {
    assert.isNull(parseAccountExtensionCall(null));
    assert.isNull(parseAccountExtensionCall({ op: 'load', account: { id: 'a' } }));
    assert.isNull(parseAccountExtensionCall({ op: 'nope', pageId: 'x.y', account: { id: 'a' } }));
    const call = parseAccountExtensionCall({
      op: 'load',
      pageId: 'billing.plan',
      account: { id: 'acc-1', roles: ['a', 3] },
      urls: { 'billing.plan': '/account/plan', evil: '//evil.test' },
      query: { tab: '<x>' },
    });
    assert.deepEqual(call?.account.roles, ['a']);
    assert.deepEqual((call as any).urls, { 'billing.plan': '/account/plan' });
    assert.deepEqual((call as any).query, {});
  });

  test('a call that throws stays a 502 without details', async ({ assert }) => {
    const ext = appExtension();
    (ext.pages[0] as any).load = async () => {
      throw new Error('db password leaked');
    };
    const call = parseAccountExtensionCall({
      op: 'load',
      pageId: 'billing.plan',
      account: { id: 'acc-1' },
    })!;
    const answer = await runAccountExtensionCall([ext], call, {
      make: async () => null,
      log: () => {},
    });
    assert.equal(answer.status, 502);
    assert.notInclude(JSON.stringify(answer.body), 'password');
  });

  test('tokens carry the dedicated typ, audience, scope and body hash', async ({ assert }) => {
    const keys = await signing();
    const token = await signRemoteExtensionToken(keys.source, {
      audience: 'app',
      subject: 'acc-1',
      bodyHash: 'abc',
    });
    assert.equal(decodeProtectedHeader(token).typ, ACCOUNT_EXTENSIONS_TOKEN_TYP);
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys.publicJwks as never), {
      issuer: ISSUER,
      audience: 'app',
    });
    assert.equal(payload.scope, ACCOUNT_EXTENSIONS_SCOPE);
    assert.equal(payload.bh, 'abc');
    assert.equal(payload.sub, 'acc-1');
    assert.isAtMost((payload.exp as number) - (payload.iat as number), 60);
  });

  test('the remote source list is validated', ({ assert }) => {
    const deps = {
      signing: () => ({ issuer: ISSUER, signingJwks: { keys: [] } }),
      pathOf: (s: string) => s,
    };
    assert.throws(
      () => new RemoteAccountExtensions([{ clientId: '', url: 'https://a' }], deps),
      /clientId/,
    );
    assert.throws(
      () =>
        new RemoteAccountExtensions([{ clientId: 'a', url: 'http://a.test' }], {
          ...deps,
          production: true,
        }),
      /https/,
    );
    assert.throws(
      () =>
        new RemoteAccountExtensions(
          [
            { clientId: 'a', url: 'https://a.test' },
            { clientId: 'a', url: 'https://b.test' },
          ],
          deps,
        ),
      /twice/,
    );
  });
});

test.group('remote account extensions | IdP console', (group) => {
  group.each.teardown(() => resetAccountConsoleState());

  test('renders a remote page end to end, with the subject and urls mapped by the app', async ({
    assert,
  }) => {
    const calls: string[] = [];
    await idpWith({ extensions: [appExtension(calls)] });
    const page = remoteAccountPageBySegment('plan');
    assert.exists(page);
    const { ctx, rendered } = fakeCtx();
    await showPage(ctx, page!);
    const html = rendered.html ?? '';
    assert.include(html, 'Plan of ana@example.com &lt;b&gt;pro&lt;/b&gt; /account/plan');
    assert.deepEqual(calls, ['load:Member:m-acc-1:-']);
  });

  test('visible() runs on the app: an account with nothing owned sees no page', async ({
    assert,
  }) => {
    await idpWith({});
    const own = fakeCtx();
    const nav = await buildAccountNav(own.ctx, null);
    assert.isTrue(nav.some((entry) => entry.id === 'billing.plan' && entry.group === 'billing'));
    const other = fakeCtx({
      accountId: 'acc-3',
      accounts: { 'acc-3': { id: 'acc-3', email: 'c@x.test' } },
    });
    const otherNav = await buildAccountNav(other.ctx, null);
    assert.isFalse(otherNav.some((entry) => entry.id === 'billing.plan'));
    const json = fakeCtx({
      accountId: 'acc-3',
      accounts: { 'acc-3': { id: 'acc-3', email: 'c@x.test' } },
      params: { pageId: 'billing.plan' },
    });
    json.ctx.request.accepts = () => 'json';
    await apiPage(json.ctx);
    assert.equal(json.out.statusCode, 404);
  });

  test('sudo and confirm are enforced by the IdP before the app is called', async ({ assert }) => {
    const calls: string[] = [];
    await idpWith({ extensions: [appExtension(calls)] });
    const page = findPageById('billing.plan')!;
    const { ctx, out } = fakeCtx({ params: { action: 'cancel' }, body: { target: 'sub-a' } });
    await postAction(ctx, page);
    assert.equal(out.statusCode, 302);
    assert.include(out.location ?? '', '/account/confirm?return_to=');
    assert.notInclude(calls.join(','), 'cancel');

    const ok = fakeCtx({ sudo: true, params: { action: 'cancel' }, body: { target: 'sub-a' } });
    await postAction(ok.ctx, page);
    assert.deepEqual(ok.flashed.get('authkit_account_extension'), {
      tone: 'success',
      text: 'Cancelled',
    });
    assert.include(calls, 'cancel:sub-a');
  });

  test('IDOR: the app re-derives ownership from the signed account', async ({ assert }) => {
    await idpWith({});
    const page = findPageById('billing.plan')!;
    const { ctx, flashed } = fakeCtx({
      sudo: true,
      params: { action: 'cancel' },
      body: { target: 'sub-b' },
    });
    await postAction(ctx, page);
    assert.deepEqual(flashed.get('authkit_account_extension'), {
      tone: 'danger',
      text: 'Not found',
    });
  });

  test('impersonation refuses sensitive remote actions on the IdP', async ({ assert }) => {
    const calls: string[] = [];
    await idpWith({ extensions: [appExtension(calls)] });
    const { ctx } = fakeCtx({
      sudo: true,
      impersonator: 'admin-1',
      params: { action: 'cancel' },
      body: { target: 'sub-a' },
    });
    await postAction(ctx, findPageById('billing.plan')!);
    assert.notInclude(calls.join(','), 'cancel');
  });

  test('manifest is cached, refreshed after its ttl, and a down app keeps its last pages', async ({
    assert,
  }) => {
    let now = Date.now();
    let down = false;
    const requests: string[] = [];
    const logs: string[] = [];
    await idpWith({
      requests,
      logs,
      ttlMs: 60_000,
      now: () => now,
      down: () => down,
    });
    const manifests = () => requests.filter((r) => r.startsWith('GET')).length;
    assert.equal(manifests(), 1);
    accountExtensionPages();
    assert.equal(manifests(), 1);
    now += 61_000;
    down = true;
    accountExtensionPages();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manifests(), 2);
    assert.isTrue(logs.some((m) => m.includes('could not be fetched')));
    // the last good manifest still serves; the page shows the load-failure notice
    const page = remoteAccountPageBySegment('plan');
    assert.exists(page);
    const { ctx, rendered } = fakeCtx();
    await showPage(ctx, page!);
    assert.include(rendered.html ?? '', 'data-block="notice"');
  });

  test('an app never reached contributes nothing and breaks nothing', async ({ assert }) => {
    const local: AccountExtension = {
      id: 'local',
      contract: 1,
      pages: [
        { id: 'local.p', segment: 'local', title: 'Local', load: async () => ({ blocks: [] }) },
      ],
    };
    await idpWith({ local: [local], down: () => true });
    assert.deepEqual(
      accountExtensionPages().map((p) => p.page.id),
      ['local.p'],
    );
    const nav = await buildAccountNav(fakeCtx().ctx, null);
    assert.isTrue(nav.some((e) => e.id === 'local.p'));
  });

  test('segment and id collisions with in-process pages skip the remote page', async ({
    assert,
  }) => {
    const local: AccountExtension = {
      id: 'mine',
      contract: 1,
      pages: [
        { id: 'mine.plan', segment: 'plan', title: 'Mine', load: async () => ({ blocks: [] }) },
      ],
    };
    const logs: string[] = [];
    await idpWith({ local: [local], logs });
    assert.deepEqual(
      accountExtensionPages().map((p) => `${p.page.id}@${p.segment}`),
      ['mine.plan@plan'],
    );
    assert.isTrue(logs.some((m) => m.includes('segment "plan"')));

    resetAccountConsoleState();
    const same: AccountExtension = {
      id: 'billing',
      contract: 1,
      pages: [
        { id: 'billing.x', segment: 'other', title: 'X', load: async () => ({ blocks: [] }) },
      ],
    };
    await idpWith({ local: [same], logs });
    assert.isFalse(accountExtensionPages().some((p) => p.remote !== undefined));
  });

  test('an invalid remote extension is skipped and logged', async ({ assert }) => {
    const bad = appExtension();
    (bad.pages[0] as any).segment = 'security';
    const logs: string[] = [];
    await idpWith({ extensions: [bad], logs });
    assert.lengthOf(accountExtensionPages(), 0);
    assert.isTrue(logs.some((m) => m.includes('skipped')));
  });

  test('the app refuses tokens for another audience', async ({ assert }) => {
    const keys = await signing();
    const fetchImpl = await fakeApp({
      publicJwks: keys.publicJwks,
      extensions: [appExtension()],
      clientId: 'other-app',
    });
    const logs: string[] = [];
    const remote = new RemoteAccountExtensions([{ clientId: 'app', url: 'https://app.test' }], {
      signing: () => keys.source,
      fetch: fetchImpl,
      pathOf: (s) => `/account/${s}`,
      log: (m) => logs.push(m),
    });
    await remote.start();
    assert.lengthOf(remote.extensions(), 0);
    assert.isTrue(logs.some((m) => m.includes('not valid')));
  });

  test('both registries share one shape', ({ assert }) => {
    const server = new AccountExtensionRegistryImpl();
    const base = new BaseAccountExtensionRegistry();
    assert.equal(server.contract, base.contract);
    assert.deepEqual(server.blockKinds, base.blockKinds);
    assert.instanceOf(server, BaseAccountExtensionRegistry);
  });
});
