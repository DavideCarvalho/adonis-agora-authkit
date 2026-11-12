import { fileURLToPath } from 'node:url';
import { Edge } from 'edge.js';
import type { AccountExtension } from '../../src/account/extension.js';
import { AccountExtensionRegistryImpl } from '../../src/account/registry.js';
import { resetAccountConsoleState, setAccountConsoleState } from '../../src/account/runtime.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import { DEFAULT_MESSAGES, translate } from '../../src/host/i18n.js';
import { renderEdgeView } from '../../src/host/renderers/edge_renderer.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

const viewsDir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));

/** A real Edge with authkit's views mounted, like production. */
export function makeEdge(): Edge {
  const edge = new Edge();
  edge.mount('authkit', viewsDir);
  edge.global('t', (key: string, params?: Record<string, string | number>) =>
    translate({ ...DEFAULT_MESSAGES }, key, params),
  );
  return edge;
}

export interface FakeCtxOptions {
  accountId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  sudo?: boolean;
  impersonator?: string;
  nonce?: string;
  config?: Record<string, unknown>;
  accounts?: Record<string, { id: string; email: string; name?: string; globalRoles?: string[] }>;
  audit?: Array<Record<string, unknown>>;
  bindings?: Record<string, unknown>;
}

export interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  location: string | null;
}

/** A fake HttpContext good enough for the extension handlers (session, render, redirects). */
export function fakeCtx(options: FakeCtxOptions = {}) {
  const session = new Map<string, unknown>();
  if (options.accountId !== null) session.set(ACCOUNT_SESSION_KEY, options.accountId ?? 'acc-1');
  if (options.sudo) {
    session.set(SUDO_SESSION_KEY, Date.now());
    session.set(SUDO_ACCOUNT_SESSION_KEY, options.accountId ?? 'acc-1');
  }
  if (options.impersonator) session.set('impersonator_user_id', options.impersonator);
  const flashed = new Map<string, unknown>();
  const out: FakeResponse = { statusCode: 200, body: undefined, headers: {}, location: null };
  const edge = makeEdge();
  const accounts = options.accounts ?? {
    'acc-1': { id: 'acc-1', email: 'ana@example.com', name: 'Ana', globalRoles: ['member'] },
    'acc-2': { id: 'acc-2', email: 'bob@example.com', name: 'Bob', globalRoles: [] },
  };
  const rendered: { view?: string; props?: Record<string, unknown>; html?: string } = {};
  const ctx: any = {
    session: {
      get: (k: string) => session.get(k),
      put: (k: string, v: unknown) => session.set(k, v),
      forget: (k: string) => session.delete(k),
      flash: (k: string, v: unknown) => flashed.set(k, v),
      flashMessages: { get: (k: string) => flashed.get(k) },
    },
    request: {
      qs: () => options.query ?? {},
      param: (k: string) => options.params?.[k],
      body: () => options.body ?? {},
      accepts: () => 'html',
      csrfToken: 'csrf-token',
      ip: () => '127.0.0.1',
      header: () => undefined,
      cookie: () => null,
      url: () => '/account/x',
    },
    response: {
      ...(options.nonce ? { nonce: options.nonce } : {}),
      status(code: number) {
        out.statusCode = code;
        return this;
      },
      send(body: unknown) {
        out.body = body;
        return body;
      },
      header(name: string, value: string) {
        out.headers[name.toLowerCase()] = value;
        return this;
      },
      redirect(url: string) {
        out.statusCode = 302;
        out.location = url;
        return url;
      },
    },
    view: {
      render: (name: string, props: Record<string, unknown>) =>
        edge.render(name, props).then((html) => {
          rendered.html = html;
          return html;
        }),
    },
    containerResolver: {
      make: async (binding: string) => {
        if (binding === 'authkit.server') {
          return {
            config: {
              locale: 'en',
              messages: { ...DEFAULT_MESSAGES },
              accountStore: {
                findById: async (id: string) => accounts[id] ?? null,
              },
              audit: {
                record: async (event: Record<string, unknown>) => options.audit?.push(event),
              },
              render: async (c: any, view: string, props: Record<string, unknown>) => {
                rendered.view = view;
                rendered.props = props;
                return renderEdgeView(c, view, props);
              },
              ...(options.config ?? {}),
            },
          };
        }
        if (options.bindings && binding in options.bindings) return options.bindings[binding];
        throw new Error(`no binding ${binding}`);
      },
    },
  };
  return { ctx, out, flashed, rendered, session };
}

/** Registers `extensions`, freezes, and installs them as the served pages. */
export function serve(
  extensions: AccountExtension[],
  options: {
    builtins?: Record<string, string>;
    overrides?: Record<string, any>;
    production?: boolean;
  } = {},
) {
  const registry = new AccountExtensionRegistryImpl({
    production: () => options.production ?? false,
  });
  for (const extension of extensions) registry.register(extension);
  const pages = registry.freeze({
    overrides: options.overrides,
    builtinSegments: ['security', 'mfa', 'tokens', 'apps', 'orgs', 'login', 'logout', 'confirm'],
    production: options.production ?? false,
  });
  setAccountConsoleState({
    pages,
    registry,
    builtins: (options.builtins ?? {
      security: '/account/security',
      tokens: '/account/tokens',
      apps: '/account/apps',
    }) as never,
  });
  return { registry, pages };
}

export { resetAccountConsoleState };
