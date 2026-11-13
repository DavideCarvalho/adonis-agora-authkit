import { test } from '@japa/runner';
import { getBootedApp, setBootedApp } from '../services/booted_app.js';
import {
  AGORA_CONSOLES_BINDING,
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  announceAgoraSignOut,
  countOtherConsoles,
  isAgoraProbe,
  listVisibleConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../src/console_switcher.js';
import { resetAccountPaths, setAccountPaths } from '../src/host/account_paths.js';
import {
  ADMIN_CONSOLE_ID,
  adminConsoleEntry,
  searchAdminConsole,
} from '../src/host/admin_console/admin_console_entry.js';
import AdminShellController from '../src/host/admin_console/admin_shell_controller.js';
import ConsoleSwitcherController from '../src/host/admin_console/console_switcher_controller.js';
import { setAdminPrefix } from '../src/host/admin_prefix.js';
import { adminConsoleDecision, registerAuthHost } from '../src/host/register_auth_host.js';

/** A container with just what the registry helper uses. */
function fakeApp() {
  const values = new Map<string, unknown>();
  const warnings: string[] = [];
  const app = {
    inProduction: false,
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => values.set(key, value),
      make: async (key: string) => {
        if (key === 'logger') return { warn: (m: string) => warnings.push(m) };
        return values.get(key);
      },
    },
  };
  return { app, values, warnings, logger: { warn: (m: string) => warnings.push(m) } };
}

function entry(id: string, overrides: Partial<AgoraConsoleEntry> = {}): AgoraConsoleEntry {
  return {
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    icon: 'generic',
    path: `/${id}`,
    order: 50,
    authorize: async () => ({ allowed: true }),
    ...overrides,
  };
}

function registryOf(...entries: AgoraConsoleEntry[]): AgoraConsoleRegistry {
  return { version: 1, entries };
}

const ctx = () => ({}) as any;

/** The booted app other suites may have left in place, so this file restores it. */
function currentBootedApp(): any {
  try {
    return getBootedApp();
  } catch {
    return undefined;
  }
}

test.group('registerAgoraConsole', () => {
  test('creates the binding when absent and reuses it when present', async ({ assert }) => {
    const { app, values } = fakeApp();
    assert.isTrue(await registerAgoraConsole(app, entry('durable')));
    // A second copy of the helper (another lib) adds to the same registry.
    assert.isTrue(await registerAgoraConsole(app, entry('payments')));
    const registry = values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    assert.equal(registry.version, 1);
    assert.deepEqual(
      registry.entries.map((e) => e.id),
      ['durable', 'payments'],
    );
  });

  test('skips a registry of another version, never throws', async ({ assert }) => {
    const { app, values } = fakeApp();
    values.set(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    assert.isFalse(await registerAgoraConsole(app, entry('durable')));
    assert.lengthOf((values.get(AGORA_CONSOLES_BINDING) as any).entries, 0);
  });

  test('warns and skips a duplicate id', async ({ assert }) => {
    const { app, values, warnings, logger } = fakeApp();
    await registerAgoraConsole(app, entry('durable'), logger);
    assert.isFalse(await registerAgoraConsole(app, entry('durable', { title: 'Other' }), logger));
    assert.lengthOf((values.get(AGORA_CONSOLES_BINDING) as any).entries, 1);
    assert.match(warnings[0]!, /console id "durable" already registered/);
  });

  test('rejects a bad id or path', async ({ assert }) => {
    const { app } = fakeApp();
    await assert.rejects(() => registerAgoraConsole(app, entry('Durable')), /must match/);
    await assert.rejects(
      () => registerAgoraConsole(app, entry('x', { path: 'durable' })),
      /same-origin/,
    );
    await assert.rejects(
      () => registerAgoraConsole(app, entry('x', { path: '//evil.test' })),
      /same-origin/,
    );
    await assert.rejects(
      () => registerAgoraConsole(app, entry('x', { path: 'https://evil.test/' })),
      /same-origin/,
    );
  });

  test('countOtherConsoles excludes self', ({ assert }) => {
    assert.equal(countOtherConsoles(null, 'authkit'), 0);
    assert.equal(countOtherConsoles(registryOf(entry('authkit')), 'authkit'), 0);
    assert.equal(countOtherConsoles(registryOf(entry('authkit'), entry('durable')), 'authkit'), 1);
  });
});

test.group('listVisibleConsoles', () => {
  test('only allowed consoles, self excluded, sorted by order then id', async ({ assert }) => {
    const registry = registryOf(
      entry('authkit', { order: 90 }),
      entry('media', { order: 50, icon: 'media' }),
      entry('durable', { order: 10, icon: 'workflow' }),
      entry('telescope', {
        order: 20,
        authorize: async () => ({ allowed: false, reason: 'forbidden' }),
      }),
      entry('payments', {
        order: 40,
        authorize: async () => ({ allowed: false, redirectTo: '/login' }),
      }),
      entry('agent', { order: 50, authorize: async () => Promise.reject(new Error('boom')) }),
      entry('aaa', { order: 50 }),
    );
    const body = await listVisibleConsoles(registry, 'authkit', ctx());
    assert.equal(body.version, 1);
    assert.equal(body.current, 'authkit');
    assert.deepEqual(
      body.consoles.map((c) => c.id),
      ['durable', 'aaa', 'media'],
    );
    assert.deepEqual(body.consoles[0], {
      id: 'durable',
      title: 'Durable',
      icon: 'workflow',
      href: '/durable',
    });
  });

  test('runs gates in parallel; one slower than 300 ms is hidden', async ({ assert }) => {
    const slow = (ms: number) => () =>
      new Promise<{ allowed: boolean }>((r) => setTimeout(() => r({ allowed: true }), ms));
    const registry = registryOf(
      entry('a', { authorize: slow(150) }),
      entry('b', { authorize: slow(150) }),
      entry('c', { authorize: slow(150) }),
      entry('late', { authorize: slow(1_000) }),
    );
    const started = Date.now();
    const body = await listVisibleConsoles(registry, 'authkit', ctx());
    const elapsed = Date.now() - started;
    assert.deepEqual(
      body.consoles.map((c) => c.id),
      ['a', 'b', 'c'],
    );
    assert.isBelow(elapsed, 450, 'total ≈ the slowest gate (capped at 300 ms), not the sum');
  });

  test('sets ctx.agoraProbe while gates run, then restores it', async ({ assert }) => {
    const seen: unknown[] = [];
    const c = ctx();
    await listVisibleConsoles(
      registryOf(
        entry('a', {
          authorize: async (x: any) => (seen.push(isAgoraProbe(x)), { allowed: true }),
        }),
      ),
      'authkit',
      c,
    );
    assert.deepEqual(seen, [true]);
    assert.notProperty(c, 'agoraProbe');
    assert.isFalse(isAgoraProbe(c));
  });

  test('unknown icon → generic; unsafe path dropped', async ({ assert }) => {
    const registry = registryOf(
      entry('a', { icon: 'rocket' as any }),
      entry('b', { path: '//evil.test' }),
    );
    const body = await listVisibleConsoles(registry, 'authkit', ctx());
    assert.deepEqual(
      body.consoles.map((c) => [c.id, c.icon]),
      [['a', 'generic']],
    );
  });

  test('no registry → empty list', async ({ assert }) => {
    const body = await listVisibleConsoles(null, 'authkit', ctx());
    assert.deepEqual(body.consoles, []);
  });
});

test.group('searchConsoles', () => {
  test('searches self without its gate and the others only when allowed', async ({ assert }) => {
    let selfGate = 0;
    const registry = registryOf(
      entry('authkit', {
        order: 90,
        authorize: async () => {
          selfGate += 1;
          return { allowed: false };
        },
        search: async (_c, q) => [{ title: `user ${q}`, href: '/admin?view=users' }],
      }),
      entry('durable', {
        order: 10,
        search: async (_c, _q, limit) =>
          Array.from({ length: 9 }, (_, i) => ({
            title: `run ${i}`,
            href: `/durable#/runs/${i}`,
          })).slice(0, limit + 3),
      }),
      entry('payments', {
        authorize: async () => ({ allowed: false }),
        search: async () => [{ title: 'secret', href: '/payments' }],
      }),
      entry('media', { search: async () => [{ title: 'evil', href: 'https://evil.test' }] }),
      entry('telescope'),
    );
    const body = await searchConsoles(registry, 'authkit', ctx(), '  ana  ');
    assert.equal(body.query, 'ana');
    assert.equal(selfGate, 0);
    assert.deepEqual(
      body.groups.map((g) => [g.id, g.hits.length]),
      [
        ['durable', 5],
        ['authkit', 1],
      ],
    );
    assert.equal(body.groups[1]!.hits[0]!.title, 'user ana');
  });

  test('gates run as a probe; the searches themselves do not', async ({ assert }) => {
    const seen: Array<[string, boolean]> = [];
    await searchConsoles(
      registryOf(
        entry('a', {
          authorize: async (c: any) => (
            seen.push(['authorize', isAgoraProbe(c)]), { allowed: true }
          ),
          search: async (c: any) => (seen.push(['search', isAgoraProbe(c)]), []),
        }),
      ),
      'authkit',
      ctx(),
      'q',
    );
    assert.deepEqual(seen, [
      ['authorize', true],
      ['search', false],
    ]);
  });

  test('empty query → no groups, nothing called', async ({ assert }) => {
    let called = false;
    const body = await searchConsoles(
      registryOf(entry('a', { search: async () => ((called = true), []) })),
      'authkit',
      ctx(),
      '   ',
    );
    assert.deepEqual(body.groups, []);
    assert.isFalse(called);
  });

  test('a slow or failing search is skipped', async ({ assert }) => {
    const body = await searchConsoles(
      registryOf(
        entry('a', {
          search: () =>
            new Promise((r) => setTimeout(() => r([{ title: 'x', href: '/a' }]), 1_000)),
        }),
        entry('b', { search: async () => Promise.reject(new Error('down')) }),
        entry('c', { search: async () => [{ title: 'ok', subtitle: 'sub', href: '/c' }] }),
      ),
      'authkit',
      ctx(),
      'q',
    );
    assert.deepEqual(body.groups, [
      {
        id: 'c',
        title: 'C',
        icon: 'generic',
        hits: [{ title: 'ok', subtitle: 'sub', href: '/c' }],
      },
    ]);
  });
});

/** Minimal ctx for the admin gate, as `tests/host/admin_guard.spec.ts` builds it. */
function adminCtx(opts: {
  sessionUserId?: string;
  roles?: string[];
  authorize?: unknown;
  lastSeen?: number;
  idleMinutes?: number;
}) {
  const writes: string[] = [];
  const ctx = {
    session: {
      get: (key: string) => (key === 'authkit_last_seen' ? opts.lastSeen : opts.sessionUserId),
      put: (key: string) => writes.push(`put:${key}`),
      forget: (key: string) => writes.push(`forget:${key}`),
    },
    request: {
      url: () => '/durable',
      parsedUrl: { search: '' },
      accepts: () => 'json',
      header: () => undefined,
    },
    response: {},
    containerResolver: {
      make: async (key: unknown) =>
        typeof key === 'function'
          ? new (key as any)()
          : {
              config: {
                admin: { enabled: true, roles: ['ADMIN'], authorize: opts.authorize ?? null },
                accountStore: {
                  findById: async (id: string) => ({
                    id,
                    email: 'a@x.com',
                    globalRoles: opts.roles ?? [],
                  }),
                },
              },
            },
    },
  } as any;
  return { ctx, writes };
}

test.group('adminConsoleDecision (the admin console entry gate)', (group) => {
  group.each.setup(() => {
    const previous = currentBootedApp();
    setBootedApp({ inProduction: false } as any);
    return () => setBootedApp(previous);
  });

  test('admin → allowed', async ({ assert }) => {
    const { ctx } = adminCtx({ sessionUserId: 'u1', roles: ['ADMIN'] });
    assert.deepEqual(await adminConsoleDecision(ctx), { allowed: true });
  });

  test('signed out → unauthenticated; non-admin → forbidden', async ({ assert }) => {
    assert.deepEqual(await adminConsoleDecision(adminCtx({}).ctx), {
      allowed: false,
      reason: 'unauthenticated',
    });
    assert.deepEqual(
      await adminConsoleDecision(adminCtx({ sessionUserId: 'u1', roles: ['X'] }).ctx),
      {
        allowed: false,
        reason: 'forbidden',
      },
    );
  });

  test('admin.roles first, then admin.authorize', async ({ assert }) => {
    const denied = adminCtx({ sessionUserId: 'u1', roles: ['ADMIN'], authorize: () => false });
    assert.deepEqual(await adminConsoleDecision(denied.ctx), {
      allowed: false,
      reason: 'forbidden',
    });
    const login = adminCtx({
      sessionUserId: 'u1',
      roles: ['ADMIN'],
      authorize: () => ({ redirectTo: '/login' }),
    });
    assert.deepEqual(await adminConsoleDecision(login.ctx), {
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  test('in production with no admin.authorize → forbidden', async ({ assert }) => {
    setBootedApp({ inProduction: true } as any);
    const { ctx } = adminCtx({ sessionUserId: 'u1', roles: ['ADMIN'] });
    assert.deepEqual(await adminConsoleDecision(ctx), { allowed: false, reason: 'forbidden' });
  });

  test('never writes the session (probe)', async ({ assert }) => {
    const { ctx, writes } = adminCtx({
      sessionUserId: 'u1',
      roles: ['ADMIN'],
      lastSeen: Date.now(),
    });
    await adminConsoleDecision(ctx);
    assert.deepEqual(writes, []);
  });

  test('never throws', async ({ assert }) => {
    const ctx = {
      containerResolver: { make: async () => Promise.reject(new Error('down')) },
    } as any;
    assert.deepEqual(await adminConsoleDecision(ctx), { allowed: false, reason: 'forbidden' });
  });
});

test.group('admin console entry', () => {
  test('id, product title, package, icon, order, path', ({ assert }) => {
    const e = adminConsoleEntry('/admin', async () => ({ allowed: true }));
    assert.equal(e.id, ADMIN_CONSOLE_ID);
    assert.equal(e.title, 'Identity');
    assert.equal(e.package, '@adonis-agora/authkit-server');
    assert.equal(e.icon, 'identity');
    assert.equal(e.order, 90);
    assert.equal(e.path, '/admin');
    assert.isFunction(e.search);
  });

  test('search finds users and organizations, links open their drawers', async ({ assert }) => {
    const store = {
      listAccounts: async ({ search, size }: any) => ({
        data: [{ id: 'u 1', email: `${search}@x.com`, name: 'Ana' }].slice(0, size),
        total: 1,
      }),
      listOrgsForAccount: async () => [],
      createOrg: async () => ({}),
      listOrgMembers: async () => [],
      listAllOrgsWithMemberCount: async () => [
        { id: 'o1', name: 'Anatomy Lab', slug: 'anatomy' },
        { id: 'o2', name: 'Other', slug: 'other' },
      ],
    };
    const c = {
      containerResolver: { make: async () => ({ config: { accountStore: store } }) },
    } as any;
    const hits = await searchAdminConsole(c, '/admin', 'ana', 5);
    assert.deepEqual(hits[0], {
      title: 'ana@x.com',
      subtitle: 'User · Ana',
      href: '/admin?view=users&user=u%201',
    });
    assert.lengthOf(hits, 2);
    assert.deepEqual(hits[1], {
      title: 'Anatomy Lab',
      subtitle: 'Organization · anatomy',
      href: '/admin?view=orgs&org=o1',
    });
  });
});

test.group('admin console switcher routes and shell', (group) => {
  let previous: any;
  group.each.setup(() => {
    previous = currentBootedApp();
  });
  group.each.teardown(() => {
    setBootedApp(previous);
    setAdminPrefix('/admin');
  });

  function fakeRouter(routes: Array<{ method: string; pattern: string }>) {
    const mk = (method: string) => (pattern: string) => {
      routes.push({ method, pattern });
      return { as: () => ({ as: () => {} }), middleware: () => {}, use: () => {} } as any;
    };
    const chain: any = {
      as: () => chain,
      prefix: () => chain,
      middleware: () => chain,
      use: () => chain,
    };
    return {
      get: mk('GET'),
      post: mk('POST'),
      patch: mk('PATCH'),
      delete: mk('DELETE'),
      put: mk('PUT'),
      any: mk('ANY'),
      group: (cb: () => void) => (cb(), chain),
    } as any;
  }

  test('mounting the admin console registers the routes (before the catch-all) and the entry', async ({
    assert,
  }) => {
    const { app, values } = fakeApp();
    setBootedApp(app as any);
    const routes: Array<{ method: string; pattern: string }> = [];
    registerAuthHost(fakeRouter(routes), { mountPath: '/oidc', admin: { prefix: '/idp-admin' } });
    const index = (p: string) => routes.findIndex((r) => r.method === 'GET' && r.pattern === p);
    assert.isAbove(index('/idp-admin/api/consoles'), -1);
    assert.isAbove(index('/idp-admin/api/consoles/search'), -1);
    assert.isBelow(index('/idp-admin/api/consoles'), index('/idp-admin/*'));
    assert.isBelow(index('/idp-admin/api/consoles/search'), index('/idp-admin/api/consoles'));
    await new Promise((r) => setImmediate(r));
    const registry = values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    assert.deepEqual(
      registry.entries.map((e) => [e.id, e.path]),
      [['authkit', '/idp-admin']],
    );
  });

  test('GET api/consoles answers the visible list with Cache-Control: private, no-store', async ({
    assert,
  }) => {
    const { app } = fakeApp();
    setBootedApp(app as any);
    await registerAgoraConsole(app, entry('authkit', { order: 90 }));
    await registerAgoraConsole(app, entry('durable', { order: 10, icon: 'workflow' }));
    await registerAgoraConsole(
      app,
      entry('payments', { authorize: async () => ({ allowed: false }) }),
    );
    const headers: Record<string, string> = {};
    const c = {
      request: { input: () => '' },
      response: { header: (k: string, v: string) => (headers[k] = v) },
      logger: { warn() {}, debug() {} },
    } as any;
    const body = await new ConsoleSwitcherController().index(c);
    assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(body, {
      version: 1,
      current: 'authkit',
      consoles: [{ id: 'durable', title: 'Durable', icon: 'workflow', href: '/durable' }],
    });
  });

  test('GET api/consoles/search fans out', async ({ assert }) => {
    const { app } = fakeApp();
    setBootedApp(app as any);
    await registerAgoraConsole(
      app,
      entry('durable', { search: async (_c, q) => [{ title: q, href: '/durable#/runs/1' }] }),
    );
    const c = {
      request: { input: () => 'run-1' },
      response: { header: () => {} },
      logger: { warn() {}, debug() {} },
    } as any;
    const body = await new ConsoleSwitcherController().search(c);
    assert.deepEqual(body.groups, [
      {
        id: 'durable',
        title: 'Durable',
        icon: 'generic',
        hits: [{ title: 'run-1', href: '/durable#/runs/1' }],
      },
    ]);
  });

  async function shellConfig(
    app: unknown,
    opts: { account?: { id: string; email: string; globalRoles: string[] }; csrf?: string } = {},
  ) {
    setBootedApp(app as any);
    setAdminPrefix('/admin');
    let html = '';
    const accountStore = {
      findById: async (id: string) => (id === opts.account?.id ? opts.account : null),
    };
    const c = {
      session: { get: () => opts.account?.id },
      request: opts.csrf ? { csrfToken: opts.csrf } : {},
      response: { type: () => ({ send: (h: string) => (html = h) }) },
      containerResolver: { make: async () => ({ config: { accountStore, messages: {} } }) },
    } as any;
    await new AdminShellController().serve(c);
    const json = /<script type="application\/json" id="authkit-admin-config">(.*?)<\/script>/s.exec(
      html,
    )?.[1];
    return JSON.parse(json ?? '{}');
  }

  test('the shell config carries `switcher` only when other consoles are registered', async ({
    assert,
  }) => {
    const alone = fakeApp();
    await registerAgoraConsole(alone.app, entry('authkit'));
    const lonely = await shellConfig(alone.app);
    assert.notProperty(lonely, 'switcher');
    assert.deepEqual(lonely.search, { endpoint: '/admin/api/consoles/search' });

    const many = fakeApp();
    await registerAgoraConsole(many.app, entry('authkit'));
    await registerAgoraConsole(many.app, entry('durable'));
    await registerAgoraConsole(many.app, entry('media'));
    const config = await shellConfig(many.app);
    assert.deepEqual(config.switcher, { endpoint: '/admin/api/consoles', others: 2 });
  });

  test('the shell config carries `viewer` and `signOut` (POST + csrf) for the signed-in admin', async ({
    assert,
  }) => {
    const { app } = fakeApp();
    const config = await shellConfig(app, {
      account: { id: 'a1', email: 'ann@x.test', globalRoles: ['admin', 'support'] },
      csrf: 'tok-1',
    });
    assert.deepEqual(config.viewer, { label: 'ann@x.test', email: 'ann@x.test', role: 'admin' });
    assert.deepEqual(config.signOut, { action: '/account/logout', csrfToken: 'tok-1' });
    // Kept for older SPA builds / hosts reading it.
    assert.equal(config.currentUser.email, 'ann@x.test');
    assert.equal(config.csrfToken, 'tok-1');
  });

  test('signed out → no viewer; no csrf → signOut without a token', async ({ assert }) => {
    const { app } = fakeApp();
    const config = await shellConfig(app);
    assert.notProperty(config, 'viewer');
    assert.deepEqual(config.signOut, { action: '/account/logout' });
  });

  test('signOut follows the account prefix and disappears with the login screen', async ({
    assert,
  }) => {
    const { app } = fakeApp();
    setBootedApp(app as any);
    try {
      registerAuthHost(fakeRouter([]), {
        mountPath: '/oidc',
        accountRoutes: { prefix: '/conta' },
      } as any);
      assert.deepEqual((await shellConfig(app)).signOut, { action: '/conta/logout' });

      registerAuthHost(fakeRouter([]), { mountPath: '/oidc', account: { login: false } } as any);
      assert.notProperty(await shellConfig(app), 'signOut');
    } finally {
      resetAccountPaths();
    }
  });
});

test.group('authkit announces its sign-out on the agora.consoles registry', (group) => {
  let previous: any;
  group.each.setup(() => {
    previous = currentBootedApp();
  });
  group.each.teardown(() => {
    setBootedApp(previous);
    resetAccountPaths();
  });

  function bareRouter() {
    const chain: any = {
      as: () => chain,
      prefix: () => chain,
      middleware: () => chain,
      use: () => chain,
    };
    const route = () => chain;
    return {
      get: route,
      post: route,
      patch: route,
      delete: route,
      put: route,
      any: route,
      group: (cb: () => void) => (cb(), chain),
    } as any;
  }

  /** What durable's `console_shell.ts` (`announcedSignOut`) reads, verbatim in shape. */
  function durableReads(registry: unknown) {
    const account = (registry as { account?: any }).account;
    const signOut = account?.signOut;
    if (typeof signOut === 'string') return signOut;
    if (typeof signOut?.action === 'string') return { action: signOut.action };
    if (typeof signOut?.href === 'string') return { href: signOut.href };
    return undefined;
  }

  test('mounting the account login announces POST <account>/logout, read as durable reads it', async ({
    assert,
  }) => {
    const { app, values } = fakeApp();
    setBootedApp(app as any);
    setAccountPaths({ prefix: '/conta', paths: { logout: 'sair' } });
    registerAuthHost(bareRouter(), { mountPath: '/oidc' });
    await new Promise((r) => setImmediate(r));
    const registry = values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    assert.deepEqual(registry.account, { signOut: { action: '/conta/sair', method: 'POST' } });
    assert.deepEqual(durableReads(registry), { action: '/conta/sair' });
    assert.equal(registry.version, 1);
    assert.isArray(registry.entries);
  });

  test('no login screen → nothing announced', async ({ assert }) => {
    const { app, values } = fakeApp();
    setBootedApp(app as any);
    registerAuthHost(bareRouter(), { mountPath: '/oidc', account: { login: false } } as any);
    await new Promise((r) => setImmediate(r));
    const registry = values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry | undefined;
    assert.isUndefined(registry?.account);
  });

  test('announceAgoraSignOut keeps an existing announcement and the entries', async ({
    assert,
  }) => {
    const { app, values } = fakeApp();
    await registerAgoraConsole(app, entry('durable'));
    assert.isTrue(await announceAgoraSignOut(app, '/account/logout'));
    assert.isFalse(await announceAgoraSignOut(app, '/other/logout'));
    const registry = values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    assert.deepEqual(registry.account?.signOut, { action: '/account/logout', method: 'POST' });
    assert.deepEqual(
      registry.entries.map((e) => e.id),
      ['durable'],
    );
  });

  test('announceAgoraSignOut skips a foreign registry and rejects an unsafe action', async ({
    assert,
  }) => {
    const { app, values } = fakeApp();
    values.set(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    assert.isFalse(await announceAgoraSignOut(app, '/account/logout'));
    assert.notProperty(values.get(AGORA_CONSOLES_BINDING) as object, 'account');
    for (const bad of ['//evil.test/logout', 'https://evil.test', '/\\evil', '']) {
      await assert.rejects(() => announceAgoraSignOut(fakeApp().app, bad));
    }
  });
});
