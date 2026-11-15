/**
 * Outbound half of calls between apps: a plain `fetch` to a configured app carries a
 * service token for that app. Installed by the provider as an undici interceptor composed
 * onto the global dispatcher, so it coexists with the other interceptors (tracing,
 * encryption) and with OpenTelemetry's undici instrumentation.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import diagnostics from 'node:diagnostics_channel';
import { AuthkitTenantToken } from '../tenant_token.js';
import { appResource, type ResolvedAppCalls } from './config.js';
import { appForOrigin } from './discovery.js';

/** Requests made while fetching a service token: never intercepted (no recursion). */
const tokenScope = new AsyncLocalStorage<true>();

/** `fetch` for the token requests: same global dispatcher, outside the interceptor. */
const bypassFetch: typeof fetch = (input, init) =>
  tokenScope.run(true, () => globalThis.fetch(input, init));

/** One cached, refreshed service token per target app. */
export class AppTokens {
  #sources = new Map<string, AuthkitTenantToken>();

  constructor(
    private readonly options: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      tokenEndpoint?: string;
      /** For tests. Default: the global `fetch`, outside the interceptor. */
      fetch?: typeof fetch;
    },
  ) {}

  #source(app: string): AuthkitTenantToken {
    let source = this.#sources.get(app);
    if (!source) {
      source = new AuthkitTenantToken({
        issuer: this.options.issuer,
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        resource: appResource(app),
        ...(this.options.tokenEndpoint ? { tokenEndpoint: this.options.tokenEndpoint } : {}),
        fetch: this.options.fetch ?? bypassFetch,
      });
      this.#sources.set(app, source);
    }
    return source;
  }

  /** The token for `app` (cached while fresh). */
  token(app: string): Promise<string> {
    return this.#source(app).token();
  }

  /** The cached token for `app` when it has not expired, without any I/O. */
  peek(app: string): string | undefined {
    return this.#source(app).peek();
  }

  /** Drops every cached token. */
  reset(): void {
    for (const source of this.#sources.values()) source.reset();
  }
}

/** The origin of an undici dispatch (`opts.origin` is a string or a URL). */
function originOf(origin: unknown): string | null {
  try {
    if (origin instanceof URL) return origin.origin;
    if (typeof origin === 'string') return new URL(origin).origin;
  } catch {
    // not a URL
  }
  return null;
}

/** `true` when the dispatch headers (any undici shape) already set `authorization`. */
export function hasAuthorization(headers: unknown): boolean {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    // Flat `[k, v, k, v]` or `[[k, v], …]`.
    if (headers.length && Array.isArray(headers[0])) {
      return headers.some((pair) => String(pair[0]).toLowerCase() === 'authorization');
    }
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === 'authorization') return true;
    }
    return false;
  }
  if (typeof (headers as Headers).has === 'function') {
    return (headers as Headers).has('authorization');
  }
  if (typeof headers === 'object') {
    if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const pair of headers as Iterable<[string, string]>) {
        if (String(pair?.[0]).toLowerCase() === 'authorization') return true;
      }
      return false;
    }
    return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  }
  return false;
}

/** The headers with `authorization` added, in the shape they came in. */
function withAuthorization(headers: unknown, value: string): unknown {
  if (!headers) return { authorization: value };
  if (Array.isArray(headers)) {
    if (headers.length && Array.isArray(headers[0])) return [...headers, ['authorization', value]];
    return [...headers, 'authorization', value];
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return [...(headers as Iterable<[string, string]>), ['authorization', value]];
  }
  return { ...(headers as Record<string, unknown>), authorization: value };
}

type Dispatch = (opts: any, handler: any) => boolean;

/**
 * The undici interceptor: for a request whose origin is exactly a known app (the static
 * `apps` map, else the published discovery — it runs after discovery rewrote the origin),
 * and that has no `Authorization` of its own, adds `Authorization: Bearer <token for that app>`.
 * Every other request passes untouched. A redirect is a new dispatch with the new origin,
 * so the token never follows a redirect to another origin. When the token cannot be
 * fetched, the request fails with that error instead of leaving unauthenticated.
 */
export function appCallsInterceptor(options: {
  origins: Map<string, string>;
  token: (app: string) => Promise<string>;
}) {
  return (dispatch: Dispatch): Dispatch =>
    function agoraAppCalls(opts, handler) {
      const origin = originOf(opts?.origin);
      const app = origin ? appForOrigin(origin, options.origins) : undefined;
      if (!app || tokenScope.getStore() || hasAuthorization(opts.headers)) {
        return dispatch(opts, handler);
      }
      options.token(app).then(
        (token) => {
          try {
            dispatch(
              { ...opts, headers: withAuthorization(opts.headers, `Bearer ${token}`) },
              handler,
            );
          } catch (error) {
            handler.onResponseError?.(null, error);
          }
        },
        (error) => {
          if (typeof handler.onResponseError === 'function') handler.onResponseError(null, error);
          else handler.onError?.(error);
        },
      );
      return true;
    };
}

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

interface DispatcherLike {
  dispatch: Dispatch;
  compose?: (...interceptors: unknown[]) => DispatcherLike;
}

/**
 * Composes `interceptor` onto the global dispatcher (the one `fetch` uses). Returns a
 * function that takes it out again, or `null` when this Node.js has no composable global
 * dispatcher.
 */
export function composeGlobalDispatcher(
  interceptor: (dispatch: Dispatch) => Dispatch,
): (() => void) | null {
  const store = globalThis as unknown as Record<symbol, DispatcherLike | undefined>;
  // Reading `fetch` loads Node's bundled undici, which installs the default dispatcher.
  void globalThis.fetch;
  const previous = store[DISPATCHER];
  if (!previous || typeof previous.compose !== 'function') return null;
  const composed = previous.compose(interceptor);
  store[DISPATCHER] = composed;
  return () => {
    // Only when nothing else was composed on top of it since.
    if (store[DISPATCHER] === composed) store[DISPATCHER] = previous;
  };
}

/** Minimal shape of a `node:http` `ClientRequest` at creation. */
interface ClientRequestLike {
  protocol?: string;
  host?: string;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): void;
}

/**
 * Opt-in `node:http` / `node:https` hook (axios, got, …): on `http.client.request.created`,
 * a request to a known app with no `Authorization` of its own gets the cached token.
 * Tokens of the static `apps` are fetched ahead; every app's token, once fetched, is kept
 * fresh in the background (the hook cannot wait).
 */
export function installNodeHttpHook(options: {
  origins: Map<string, string>;
  tokens: AppTokens;
  warn?: (message: string) => void;
  refreshEveryMs?: number;
}): () => void {
  const apps = new Set(options.origins.values());
  const warm = () => {
    for (const app of apps) options.tokens.token(app).catch(() => {});
  };
  warm();
  const timer = setInterval(warm, options.refreshEveryMs ?? 30_000);
  timer.unref?.();
  const warned = new Set<string>();

  const onCreated = (message: unknown) => {
    const req = (message as { request?: ClientRequestLike })?.request;
    if (!req || typeof req.setHeader !== 'function' || tokenScope.getStore()) return;
    const port = portOf(req);
    if (port === null) return;
    const origin = originOf(`${req.protocol ?? 'http:'}//${req.host ?? ''}${port}`);
    const app = origin ? appForOrigin(origin, options.origins) : undefined;
    if (!app || req.getHeader('authorization') !== undefined) return;
    const token = options.tokens.peek(app);
    if (token) {
      req.setHeader('authorization', `Bearer ${token}`);
      return;
    }
    // A discovered app: fetch its token now and keep it fresh from here on.
    apps.add(app);
    options.tokens.token(app).catch(() => {});
    if (!warned.has(app)) {
      warned.add(app);
      options.warn?.(
        `authkit: no service token for ${app} yet; a node:http request to it left without one`,
      );
    }
  };
  diagnostics.subscribe('http.client.request.created', onCreated);
  return () => {
    clearInterval(timer);
    diagnostics.unsubscribe('http.client.request.created', onCreated);
  };
}

/**
 * `:port` of a `ClientRequest`. Node keeps it only in the `host` header; it is used only
 * when that header names the host the request really connects to (`req.host`).
 */
function portOf(req: ClientRequestLike): string | null {
  const header = req.getHeader('host');
  if (typeof header !== 'string') return '';
  const at = header.lastIndexOf(':');
  const hasPort = at > header.lastIndexOf(']');
  const hostname = hasPort ? header.slice(0, at) : header;
  if (hostname.toLowerCase() !== String(req.host ?? '').toLowerCase()) return null;
  return hasPort ? header.slice(at) : '';
}

/** Everything the outbound side installs, in one call. Returns how to take it out. */
export function installAppCalls(options: {
  calls: ResolvedAppCalls;
  issuer: string;
  tokenEndpoint?: string;
  warn?: (message: string) => void;
}): { tokens: AppTokens; uninstall: () => void } | null {
  const { calls } = options;
  // Without a static map, the targets come from the published discovery.
  if (!calls.clientId || !calls.clientSecret) return null;
  const tokens = new AppTokens({
    issuer: options.issuer,
    clientId: calls.clientId,
    clientSecret: calls.clientSecret,
    ...(options.tokenEndpoint ? { tokenEndpoint: options.tokenEndpoint } : {}),
  });
  const undo: Array<() => void> = [];
  const restore = composeGlobalDispatcher(
    appCallsInterceptor({ origins: calls.origins, token: (app) => tokens.token(app) }),
  );
  if (restore) undo.push(restore);
  else
    options.warn?.(
      'authkit: the global fetch dispatcher cannot be composed; fetch calls between apps are not authenticated',
    );
  if (calls.nodeHttp) {
    undo.push(installNodeHttpHook({ origins: calls.origins, tokens, warn: options.warn }));
  }
  return {
    tokens,
    uninstall: () => {
      for (const fn of undo.reverse()) fn();
    },
  };
}
