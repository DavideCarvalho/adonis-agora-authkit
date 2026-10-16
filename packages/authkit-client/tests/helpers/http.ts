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

/** HttpContext for the client routes: container (→ `manager`), query string, session. */
export function fakeHttpCtx(options: {
  manager?: unknown;
  qs?: Record<string, string>;
  session?: FakeSession;
}) {
  const redirects: Redirect[] = [];
  const qs = options.qs ?? {};
  const ctx = {
    containerResolver: { make: async () => options.manager },
    request: { qs: () => qs, input: (key: string) => qs[key] },
    session: options.session,
    response: fakeResponse(redirects),
  } as any;
  return { ctx, redirects };
}

type Handler = (ctx: any) => Promise<unknown>;

/** Registers the real client routes on a fake router; returns their handlers by pattern. */
export function oidcRoutes(options?: RegisterOidcClientOptions): (pattern: string) => Handler {
  const table = new Map<string, Handler>();
  const add = (pattern: string, handler: Handler) => {
    table.set(pattern, handler);
    const chain = { use: () => chain, as: () => chain };
    return chain;
  };
  registerOidcClient({ get: add, post: add } as any, options);
  return (pattern) => {
    const handler = table.get(pattern);
    if (!handler) throw new Error(`no route ${pattern}`);
    return handler;
  };
}
