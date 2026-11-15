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
import { type AgoraDiscovery, agoraDiscovery, appForOrigin, namesOf } from './discovery.js';

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

  /** The cached token for `app` when it stays valid for 5 s more, without any I/O. */
  peek(app: string): string | undefined {
    return this.#source(app).peek(5_000);
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
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set('authorization', value);
    return copy;
  }
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

/** Fails a dispatch, whichever handler API (undici 7/8 controller-style, or legacy) it has. */
function failHandler(handler: any, error: unknown): void {
  if (typeof handler?.onResponseError === 'function') handler.onResponseError(null, error);
  else handler?.onError?.(error);
}

/**
 * The undici interceptor: for a request whose origin is exactly a known app (the static
 * `apps` map, else the published discovery), and that has no `Authorization` of its own, adds `Authorization: Bearer <token for that app>`.
 * Every other request passes untouched. A redirect is a new dispatch with the new origin,
 * so the token never follows a redirect to another origin. When the token cannot be
 * fetched, the request fails with that error instead of leaving unauthenticated.
 *
 * Works on either side of a discovery rewrite (`http://billing/…` → billing's origin): after
 * it, the origin is matched with `appOf`; before it, `http://<name>` is matched when
 * discovery `resolve`s that name (the token is then for the app the rewrite targets).
 */
export function appCallsInterceptor(options: {
  origins: Map<string, string>;
  token: (app: string) => Promise<string>;
}) {
  return (dispatch: Dispatch): Dispatch =>
    function agoraAppCalls(opts, handler) {
      const origin = originOf(opts?.origin);
      if (origin === PROBE_ORIGIN) {
        probeHits += 1;
        failHandler(handler, new Error('agora app-calls probe'));
        return true;
      }
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
            failHandler(handler, error);
          }
        },
        (error) => failHandler(handler, error),
      );
      return true;
    };
}

/**
 * Where Node's bundled undici keeps the global dispatcher. undici 7 (Node 24 up to its
 * 7.x line) reads `.1`; undici 8 (Node 26, recent Node 24) reads `.2` for `fetch` and keeps
 * a legacy wrapper on `.1` for undici@7 code. Every slot present is composed: a request
 * that went through two of them still gets one token (the second sees `Authorization`).
 */
const DISPATCHER_SLOTS = [
  Symbol.for('undici.globalDispatcher.2'),
  Symbol.for('undici.globalDispatcher.1'),
];

interface DispatcherLike {
  dispatch: Dispatch;
  compose?: (...interceptors: unknown[]) => DispatcherLike;
}

/**
 * Node's bundled undici installs the global dispatcher when it loads, which happens on the
 * first `fetch()` CALL (reading `fetch` is not enough on Node 26). It must be loaded before
 * composing: undici 8, on load, finds no `.2` and REPLACES `.1` too (with a wrapper of a new
 * Agent), dropping whatever had been composed onto a `.1` set earlier (e.g. by the npm
 * `undici@7`). A `data:` URL loads it without touching the network.
 */
function loadBundledUndici(store: Record<symbol, unknown>): void {
  if (store[DISPATCHER_SLOTS[0]!]) return;
  try {
    globalThis.fetch('data:,').catch(() => {});
  } catch {
    // no fetch: nothing to compose
  }
}

/**
 * Composes `interceptor` onto the global dispatcher(s) `fetch` uses. Returns a function that
 * takes it out again, or `null` when this Node.js has no composable global dispatcher.
 */
export function composeGlobalDispatcher(
  interceptor: (dispatch: Dispatch) => Dispatch,
): (() => void) | null {
  const store = globalThis as unknown as Record<symbol, DispatcherLike | undefined>;
  loadBundledUndici(store);
  const undo: Array<() => void> = [];
  for (const slot of DISPATCHER_SLOTS) {
    const previous = store[slot];
    if (!previous || typeof previous.compose !== 'function') continue;
    const composed = previous.compose(interceptor);
    store[slot] = composed;
    // Only when nothing else was composed on top of it since.
    undo.push(() => {
      if (store[slot] === composed) store[slot] = previous;
    });
  }
  if (!undo.length) return null;
  return () => {
    for (const fn of undo) fn();
  };
}

/** The global `fetch` does not go through the app-calls interceptor. Fails the start. */
export class AppCallsInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCallsInstallError';
  }
}

/** Origin the self-check fetches: answered by the interceptor, never by the network. */
const PROBE_ORIGIN = 'http://agora-app-calls-probe.invalid';
let probeHits = 0;

/**
 * `true` when the global `fetch` really goes through the app-calls interceptor (a request
 * to a reserved `.invalid` origin that only the interceptor answers; no network).
 */
export async function fetchPassesThroughAppCalls(): Promise<boolean> {
  const before = probeHits;
  try {
    await globalThis.fetch(`${PROBE_ORIGIN}/`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    // expected: the interceptor fails the probe on purpose
  }
  return probeHits > before;
}

/** Minimal shape of a `node:http` `ClientRequest` at creation. */
interface ClientRequestLike {
  protocol?: string;
  host?: string;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): void;
  destroy(error?: Error): unknown;
}

/** Thrown on a `node:http` request to a known app when no token is ready for it. */
export class AppTokenUnavailableError extends Error {
  readonly code = 'E_AGORA_APP_TOKEN_UNAVAILABLE';
  constructor(
    readonly app: string,
    options?: { cause?: unknown },
  ) {
    super(
      `authkit: no service token for app "${app}" yet; the request was not sent (a node:http request cannot wait for one). Retry, or use fetch.`,
      options,
    );
    this.name = 'AppTokenUnavailableError';
  }
}

/**
 * Opt-in `node:http` / `node:https` hook (axios, got, …). On `http.client.request.created`,
 * a request to a known app with no `Authorization` of its own gets that app's cached
 * token. The hook cannot wait, so tokens are fetched ahead: at install for every app of
 * the static map, when discovery announces apps (its `subscribe`), and on every tick
 * (which also refreshes them before they expire). A request to a known app with no token
 * ready is destroyed with {@link AppTokenUnavailableError}; it never leaves without one.
 */
export function installNodeHttpHook(options: {
  origins: Map<string, string>;
  tokens: AppTokens;
  warn?: (message: string) => void;
  /** How often tokens are refreshed (and discovery re-checked). Default: 15 s. */
  refreshEveryMs?: number;
}): () => void {
  const apps = new Set(options.origins.values());
  const lastErrors = new Map<string, unknown>();
  const warmOne = (app: string) => {
    apps.add(app);
    options.tokens.token(app).then(
      () => lastErrors.delete(app),
      (error) => {
        if (!lastErrors.has(app)) {
          options.warn?.(
            `authkit: could not get a service token for app "${app}": ${String((error as Error)?.message ?? error)}`,
          );
        }
        lastErrors.set(app, error);
      },
    );
  };

  // Discovery may be published after this hook: subscribed to on first sight.
  let subscribedTo: AgoraDiscovery | undefined;
  let unsubscribe: (() => void) | undefined;
  const watchDiscovery = () => {
    const discovery = agoraDiscovery();
    if (!discovery || discovery === subscribedTo || typeof discovery.subscribe !== 'function') {
      return;
    }
    unsubscribe?.();
    subscribedTo = discovery;
    try {
      const off = discovery.subscribe((known?: unknown) => {
        for (const app of namesOf(known)) warmOne(app);
      });
      unsubscribe = typeof off === 'function' ? (off as () => void) : undefined;
    } catch {
      unsubscribe = undefined;
    }
  };

  const tick = () => {
    watchDiscovery();
    for (const app of apps) warmOne(app);
  };
  tick();
  const timer = setInterval(tick, options.refreshEveryMs ?? 15_000);
  timer.unref?.();

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
    // A known app without a token ready: fetch one for next time, never send this bare.
    warmOne(app);
    req.destroy(new AppTokenUnavailableError(app, { cause: lastErrors.get(app) }));
  };
  diagnostics.subscribe('http.client.request.created', onCreated);
  return () => {
    clearInterval(timer);
    unsubscribe?.();
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
