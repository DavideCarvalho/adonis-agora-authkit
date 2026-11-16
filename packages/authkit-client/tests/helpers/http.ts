import {
  type RegisterOidcClientOptions,
  registerOidcClient,
} from '../../src/register_oidc_client.js';

/**
 * Map-backed session with the surface the client uses. `sessionId` turns on the
 * per-session refresh dedup; leave it out to exercise the path without it.
 */
export function fakeSession(
  options: { sessionId?: string; initial?: Record<string, unknown> } = {},
) {
  const store = new Map<string, unknown>(Object.entries(options.initial ?? {}));
  return {
    store,
    sessionId: options.sessionId,
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => void store.set(key, value),
    forget: (key: string) => void store.delete(key),
    pull: (key: string) => {
      const value = store.get(key);
      store.delete(key);
      return value;
    },
  };
}

export type FakeSession = ReturnType<typeof fakeSession>;

export type Redirect = { url: string; forward: boolean };

/**
 * Response whose redirects record whether the request query was forwarded.
 *
 * Only the `withQs(false)` builder counts as opting out: with
 * `redirect.forwardQueryString: true` in config/app.ts (the common case) the
 * positional `redirect(path, forward)` argument is IGNORED and the Redirect
 * inherits the global config — so the positional form records a forward.
 */
function fakeResponse(redirects: Redirect[]) {
  return {
    header: () => {},
    redirect(path?: string, _forward?: boolean) {
      if (typeof path === 'string') {
        redirects.push({ url: path, forward: true });
        return undefined as any;
      }
      let forward = true;
      const builder = {
        withQs(value: boolean) {
          forward = value;
          return builder;
        },
        status: () => builder,
        toPath(url: string) {
          redirects.push({ url, forward });
        },
        back() {
          redirects.push({ url: 'back', forward });
        },
      };
      return builder;
    },
  };
}

/**
 * HttpContext for the client routes: container (→ `manager`), query string, session, the
 * route's wildcard (`params['*']`) and the raw URL (`url`, query included).
 */
export function fakeHttpCtx(options: {
  manager?: unknown;
  qs?: Record<string, string>;
  session?: FakeSession;
  wildcard?: string[];
  url?: string;
}) {
  const redirects: Redirect[] = [];
  const qs = options.qs ?? {};
  const rawUrl = options.url ?? '/';
  const ctx = {
    containerResolver: { make: async () => options.manager },
    request: {
      qs: () => qs,
      input: (key: string) => qs[key],
      url: (withQuery?: boolean) => (withQuery ? rawUrl : rawUrl.split('?')[0]),
    },
    params: options.wildcard ? { '*': options.wildcard } : {},
    session: options.session,
    response: fakeResponse(redirects),
  } as any;
  return { ctx, redirects };
}

type Handler = (ctx: any) => Promise<unknown>;

/** A route registered on the fake router: method, pattern, name and middleware. */
export interface FakeRoute {
  method: 'GET' | 'POST';
  pattern: string;
  handler: Handler;
  name?: string;
  middleware: unknown[];
}

/** Registers the real client routes on a fake router; returns the routes it got. */
export function registeredOidcRoutes(options?: RegisterOidcClientOptions): FakeRoute[] {
  const routes: FakeRoute[] = [];
  const add = (method: FakeRoute['method']) => (pattern: string, handler: Handler) => {
    const route: FakeRoute = { method, pattern, handler, middleware: [] };
    routes.push(route);
    const chain = {
      use: (middleware: unknown) => {
        route.middleware.push(middleware);
        return chain;
      },
      as: (name: string) => {
        route.name = name;
        return chain;
      },
    };
    return chain;
  };
  registerOidcClient({ get: add('GET'), post: add('POST') } as any, options);
  return routes;
}

/** Registers the real client routes on a fake router; returns their handlers by pattern. */
export function oidcRoutes(options?: RegisterOidcClientOptions): (pattern: string) => Handler {
  const routes = registeredOidcRoutes(options);
  return (pattern) => {
    const route = routes.find((r) => r.pattern === pattern);
    if (!route) throw new Error(`no route ${pattern}`);
    return route.handler;
  };
}
