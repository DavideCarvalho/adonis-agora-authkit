import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../services/booted_app.js';
import { accountPathsMap, accountPrefix, joinAccountPath } from '../host/account_paths.js';
import type { AccountExtensionOverride } from './extension.js';
import { AccountExtensionRegistryImpl } from './registry.js';
import { accountExtensionPages, type BuiltinNavId, setAccountConsoleState } from './runtime.js';

type Middleware = (ctx: HttpContext, next: () => Promise<void>) => Promise<unknown>;

function inProduction(): boolean {
  try {
    return getBootedApp().inProduction === true;
  } catch {
    return false;
  }
}

interface LifecycleApp {
  isBooted?: boolean;
  starting?: (fn: () => unknown) => unknown;
}

function lifecycleApp(): LifecycleApp | null {
  try {
    return getBootedApp() as unknown as LifecycleApp;
  } catch {
    return null;
  }
}

let registry: AccountExtensionRegistryImpl | null = null;

/** The process registry bound at `authkit.accountExtensions`. */
export function accountExtensionRegistry(): AccountExtensionRegistryImpl {
  registry ??= new AccountExtensionRegistryImpl({ production: inProduction });
  return registry;
}

/** A fresh registry (tests). */
export function resetAccountExtensionRegistry(next?: AccountExtensionRegistryImpl): void {
  registry = next ?? null;
}

/** One extension page in {@link AuthHostRouteMap}. */
export interface AccountExtensionRouteEntry {
  id: string;
  href: string;
  label: string;
  order: number;
}

export interface MountAccountExtensionsOptions {
  guard: Middleware;
  /** Per-account bucket for action POSTs: `[html, json]` variants (same count). */
  throttle?: { html: Middleware; json: Middleware };
  overrides?: Readonly<Record<string, AccountExtensionOverride>>;
  builtins: Partial<Record<BuiltinNavId, string>>;
  /** Filled in place once the routes are mounted. */
  entries: AccountExtensionRouteEntry[];
}

const H = () => import('./http.js');

function builtinSegments(): string[] {
  const prefix = accountPrefix() === '/' ? '' : accountPrefix();
  return Object.values(accountPathsMap()).map(
    (path) =>
      (path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path).split('/')[0] ?? '',
  );
}

/**
 * Mounts the JSON API of the extensions now, and the page routes once every provider booted
 * (contributors register from their `boot()`; pages mount when the app starts), then freezes the
 * registry.
 */
export function mountAccountExtensions(router: any, options: MountAccountExtensionsOptions): void {
  const apiBase = joinAccountPath('api');
  const withJsonThrottle = (route: any) => {
    if (options.throttle) route.use([options.throttle.json]);
    return route;
  };
  router
    .group(() => {
      router.get(`${apiBase}/extensions`, async (ctx: HttpContext) =>
        (await H()).apiExtensions(ctx),
      );
      router.get(`${apiBase}/x/:pageId`, async (ctx: HttpContext) => (await H()).apiPage(ctx));
      withJsonThrottle(
        router.post(`${apiBase}/x/:pageId/actions/:action`, async (ctx: HttpContext) =>
          (await H()).apiAction(ctx),
        ),
      );
    })
    .use([options.guard]);

  const mountPages = () => {
    const reg = accountExtensionRegistry();
    const pages = reg.freeze({
      overrides: options.overrides,
      builtinSegments: builtinSegments(),
      production: inProduction(),
    });
    setAccountConsoleState({ pages, builtins: options.builtins, registry: reg });
    if (pages.length === 0) return;
    router
      .group(() => {
        for (const page of pages) {
          const base = joinAccountPath(page.segment);
          router.get(base, async (ctx: HttpContext) => (await H()).showPage(ctx, page));
          router.get(`${base}/actions/:action/confirm`, async (ctx: HttpContext) =>
            (await H()).showActionStep(ctx, page),
          );
          const post = router.post(`${base}/actions/:action`, async (ctx: HttpContext) =>
            (await H()).postAction(ctx, page),
          );
          if (options.throttle) post.use([options.throttle.html]);
        }
      })
      .use([options.guard]);
    for (const page of accountExtensionPages()) {
      if (page.page.nav === false) continue;
      const label = page.page.nav?.label ?? page.page.title;
      options.entries.push({
        id: page.page.id,
        href: joinAccountPath(page.segment),
        label: typeof label === 'string' ? label : label.key,
        order: page.order,
      });
    }
  };

  setAccountConsoleState({ builtins: options.builtins, registry: accountExtensionRegistry() });
  // During the providers' boot (auto-mount from `config.routes`) contributors may not have
  // registered yet: mount the pages when the app starts, before the preloads and the router commit.
  const app = lifecycleApp();
  if (app && app.isBooted === false && typeof app.starting === 'function') {
    app.starting(mountPages);
  } else {
    mountPages();
  }
}
