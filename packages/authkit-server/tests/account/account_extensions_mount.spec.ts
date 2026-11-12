import { test } from '@japa/runner';
import { getBootedApp, setBootedApp } from '../../services/booted_app.js';
import type { AccountExtension } from '../../src/account/extension.js';
import {
  accountExtensionRegistry,
  mountAccountExtensions,
  resetAccountExtensionRegistry,
} from '../../src/account/mount.js';
import { resetAccountConsoleState } from '../../src/account/runtime.js';
import { resetAccountPaths, setAccountPaths } from '../../src/host/account_paths.js';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

interface FakeRoute {
  method: string;
  pattern: string;
  middleware: unknown[];
  group: number;
}

function fakeRouter() {
  const routes: FakeRoute[] = [];
  const groupMiddleware: unknown[][] = [];
  let currentGroup = -1;
  const mk = (method: string) => (pattern: string) => {
    const route: FakeRoute = { method, pattern, middleware: [], group: currentGroup };
    routes.push(route);
    const chain: any = {
      as: () => chain,
      use: (m: unknown) => {
        route.middleware.push(...(Array.isArray(m) ? m : [m]));
        return chain;
      },
    };
    return chain;
  };
  return {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    delete: mk('DELETE'),
    put: mk('PUT'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      const index = groupMiddleware.length;
      groupMiddleware.push([]);
      const previous = currentGroup;
      currentGroup = index;
      cb();
      currentGroup = previous;
      const chain: any = {
        as: () => chain,
        prefix: () => chain,
        use: (m: unknown) => {
          groupMiddleware[index]?.push(...(Array.isArray(m) ? m : [m]));
          return chain;
        },
      };
      return chain;
    },
    routes,
    groupMiddleware,
  } as any;
}

const extension = (id = 'billing', segment = 'billing'): AccountExtension => ({
  id,
  contract: 1,
  pages: [{ id: `${id}.main`, segment, title: 'Billing', load: async () => ({ blocks: [] }) }],
});

function savedApp() {
  try {
    return getBootedApp();
  } catch {
    return undefined;
  }
}

test.group('account extensions | mounting', (group) => {
  group.each.setup(() => {
    resetAccountExtensionRegistry();
    resetAccountConsoleState();
    resetAuthHostConfig();
    resetAccountPaths();
    return () => {
      resetAccountExtensionRegistry();
      resetAccountConsoleState();
      resetAuthHostConfig();
      resetAccountPaths();
    };
  });

  test('registerAuthHost mounts the pages and the JSON API behind the account guard', ({
    assert,
  }) => {
    accountExtensionRegistry().register(extension());
    const router = fakeRouter();
    const map = registerAuthHost(router, { mountPath: '/oidc' });
    const find = (method: string, pattern: string) =>
      router.routes.find((r: FakeRoute) => r.method === method && r.pattern === pattern);
    const page = find('GET', '/account/billing');
    const api = find('GET', '/account/api/x/:pageId');
    const post = find('POST', '/account/billing/actions/:action');
    assert.exists(page);
    assert.exists(api);
    assert.exists(find('GET', '/account/billing/actions/:action/confirm'));
    assert.exists(find('GET', '/account/api/extensions'));
    assert.exists(find('POST', '/account/api/x/:pageId/actions/:action'));
    // Same guard as the built-in screens.
    const security = find('GET', '/account/security');
    const guardOf = (r: FakeRoute) => router.groupMiddleware[r.group][0];
    assert.strictEqual(guardOf(page), guardOf(security));
    assert.strictEqual(guardOf(api), guardOf(security));
    // Per-account throttle on action POSTs (rate limit on by default).
    assert.lengthOf(post.middleware, 1);
    // Not exempt from CSRF: browser POSTs with a session.
    assert.isFalse(authkitCsrfExceptions('/account/billing/actions/cancel'));
    assert.isFalse(authkitCsrfExceptions('/account/api/x/billing.main/actions/cancel'));
    assert.deepEqual(map.account.extensions, [
      { id: 'billing.main', href: '/account/billing', label: 'Billing', order: 100 },
    ]);
    assert.isTrue(accountExtensionRegistry().frozen);
  });

  test('account: false mounts no extension routes', ({ assert }) => {
    accountExtensionRegistry().register(extension());
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: false });
    assert.isUndefined(router.routes.find((r: FakeRoute) => r.pattern === '/account/billing'));
    assert.isUndefined(
      router.routes.find((r: FakeRoute) => r.pattern === '/account/api/extensions'),
    );
  });

  test('follows the account prefix', ({ assert }) => {
    accountExtensionRegistry().register(extension());
    setAccountPaths({ prefix: '/conta' });
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', accountRoutes: { prefix: '/conta' } });
    assert.exists(router.routes.find((r: FakeRoute) => r.pattern === '/conta/billing'));
    assert.exists(router.routes.find((r: FakeRoute) => r.pattern === '/conta/api/x/:pageId'));
  });

  test('during the providers boot the pages mount when the app starts', ({ assert }) => {
    const previous = savedApp();
    const starting: Array<() => unknown> = [];
    setBootedApp({
      isBooted: false,
      inProduction: false,
      starting: (fn: () => unknown) => starting.push(fn),
    } as never);
    try {
      const router = fakeRouter();
      const entries: unknown[] = [];
      mountAccountExtensions(router, {
        guard: async () => {},
        builtins: {},
        entries: entries as never,
      });
      // a contributor booting after authkit still registers
      accountExtensionRegistry().register(extension('late', 'late'));
      assert.isUndefined(router.routes.find((r: FakeRoute) => r.pattern === '/account/late'));
      assert.lengthOf(starting, 1);
      starting[0]?.();
      assert.exists(router.routes.find((r: FakeRoute) => r.pattern === '/account/late'));
      assert.throws(
        () => accountExtensionRegistry().register(extension('later', 'later')),
        /boot\(\)/,
      );
    } finally {
      if (previous) setBootedApp(previous);
    }
  });
});
