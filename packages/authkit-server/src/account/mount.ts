import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../services/booted_app.js';
import { accountPathsMap, accountPrefix, joinAccountPath } from '../host/account_paths.js';
import type { AccountExtensionOverride } from './extension.js';
import { AccountExtensionRegistryImpl } from './registry.js';
import { type RemoteAccountExtensionSource, RemoteAccountExtensions } from './remote.js';
import {
  accountExtensionPages,
  type BuiltinNavId,
  remoteAccountPageBySegment,
  setAccountConsoleState,
} from './runtime.js';

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
  /** `accountConsole.remote`: apps that serve pages for this console. */
  remote?: readonly RemoteAccountExtensionSource[];
  /** `accountConsole.actionTimeoutMs`. */
  actionTimeoutMs?: number;
}

/** The IdP's issuer and signing keys, from the OIDC service of the booted app. */
async function signingSource() {
  const service = (await getBootedApp().container.make('authkit.server' as never)) as any;
  return { issuer: service.config.issuer as string, signingJwks: service.signingJwks };
}

/**
 * A route matcher that only accepts the segments remote pages currently use, so the catch-all
 * routes never shadow another route under the account prefix.
 */
function liveSegmentMatcher(): RegExp {
  const matcher = /^[a-z0-9][a-z0-9-]{0,63}$/;
  Object.defineProperty(matcher, 'test', {
    value: (segment: string) => remoteAccountPageBySegment(segment) !== undefined,
  });
  return matcher;
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

  const remote =
    options.remote && options.remote.length > 0
      ? new RemoteAccountExtensions(options.remote, {
          signing: signingSource,
          pathOf: (segment) => joinAccountPath(segment),
          production: inProduction(),
          ...(options.actionTimeoutMs !== undefined
            ? { actionTimeoutMs: options.actionTimeoutMs }
            : {}),
        })
      : null;

  const pushEntries = (pages: readonly { page: any; segment: string; order: number }[]) => {
    for (const page of pages) {
      if (page.page.nav === false) continue;
      if (options.entries.some((entry) => entry.id === page.page.id)) continue;
      const label = page.page.nav?.label ?? page.page.title;
      options.entries.push({
        id: page.page.id,
        href: joinAccountPath(page.segment),
        label: typeof label === 'string' ? label : label.key,
        order: page.order,
      });
    }
  };

  const mountRemote = () => {
    if (!remote) return;
    const segment = { xsegment: { match: liveSegmentMatcher() } };
    const page = (ctx: HttpContext) => remoteAccountPageBySegment(String(ctx.params.xsegment));
    router
      .group(() => {
        router
          .get(joinAccountPath(':xsegment'), async (ctx: HttpContext) =>
            (await H()).showRemotePage(ctx, page(ctx)),
          )
          .where('xsegment', segment.xsegment);
        router
          .get(joinAccountPath(':xsegment/actions/:action/confirm'), async (ctx: HttpContext) =>
            (await H()).showRemoteActionStep(ctx, page(ctx)),
          )
          .where('xsegment', segment.xsegment);
        const post = router
          .post(joinAccountPath(':xsegment/actions/:action'), async (ctx: HttpContext) =>
            (await H()).postRemoteAction(ctx, page(ctx)),
          )
          .where('xsegment', segment.xsegment);
        if (options.throttle) post.use([options.throttle.html]);
      })
      .use([options.guard]);
  };

  const mountPages = () => {
    const reg = accountExtensionRegistry();
    const pages = reg.freeze({
      overrides: options.overrides,
      builtinSegments: builtinSegments(),
      production: inProduction(),
    });
    setAccountConsoleState({
      pages,
      builtins: options.builtins,
      registry: reg,
      remote,
      builtinSegments: builtinSegments(),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    });
    mountRemote();
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
    pushEntries(pages);
  };

  // Remote manifests: fetched when the app starts (bounded), refreshed in the background after.
  const startRemote = async () => {
    if (!remote) return;
    await remote.start();
    pushEntries(accountExtensionPages().filter((page) => page.remote !== undefined));
  };

  setAccountConsoleState({ builtins: options.builtins, registry: accountExtensionRegistry() });
  // During the providers' boot (auto-mount from `config.routes`) contributors may not have
  // registered yet: mount the pages when the app starts, before the preloads and the router commit.
  const app = lifecycleApp();
  if (app && app.isBooted === false && typeof app.starting === 'function') {
    app.starting(mountPages);
    if (remote) app.starting(startRemote);
  } else {
    mountPages();
    if (remote) void startRemote();
  }
}
