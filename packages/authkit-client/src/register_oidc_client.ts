import { ACCOUNT_EXTENSIONS_WELL_KNOWN, type Identity } from '@adonis-agora/authkit-core';
import type { HttpContext, Router } from '@adonisjs/core/http';
import appService from '@adonisjs/core/services/app';
import { announceAgoraSignOut, type ConsolesAppLike } from './agora_consoles.js';
import { OidcCallbackError } from './authorization.js';
import type { OidcEndpoints } from './discovery.js';
import { buildEndSessionUrl } from './oidc_login.js';
import type { TokenSet } from './types.js';

/**
 * Mapa role → rota de redirect pós-login. `byGlobalRole` checa as roles globais do
 * IdP (claim do token) — a primeira correspondência vence; sem match → `default`.
 * Autorização por app-role/permissão saiu do AuthKit — use `@adonis-agora/authz`
 * (ex.: no `afterLogin`) se o destino depender disso.
 */
export interface PostLoginRedirects {
  byGlobalRole?: Record<string, string>;
  default?: string;
}

export interface RegisterOidcClientOptions {
  /** Prefixo das rotas. Default `/auth` → `/auth/login`, `/auth/signup`, `/auth/callback`, `/auth/logout`, … */
  prefix?: string;
  /**
   * Hook após troca de code bem-sucedida. Retorne uma STRING para redirecionar
   * para uma rota específica; retorne void para cair em `redirects`/`/`.
   */
  afterLogin?: (
    ctx: HttpContext,
    identity: Identity | null,
  ) => Promise<string | undefined> | string | undefined;
  /** Redirect pós-login por papel (usado quando `afterLogin` não retorna string). */
  redirects?: PostLoginRedirects;
  /** Destino pós-logout. Default: origem do redirectUri + '/'. */
  postLogoutRedirect?: string | ((ctx: HttpContext) => string);
  /** Registra também `POST {prefix}/backchannel-logout` (OIDC Back-Channel Logout). Default: true. */
  backchannelLogout?: boolean;
  /**
   * Registra também `GET`/`POST /.well-known/agora-account-extensions` (account console pages this
   * app serves to the IdP; 404 until `accountConsole.remote` is on). Default: true.
   */
  accountExtensions?: boolean;
  /**
   * Middleware(s) aplicados às rotas de login e de signup (ex.: `middleware.guest()`). Array no
   * formato aceito por `.use()` do AdonisJS.
   */
  loginMiddleware?: any;
  /** Query param repassado como hint ao authorize (ex.: `audience`). Default: `['audience']`. */
  passthroughParams?: string[];
  /**
   * Announce `POST {prefix}/logout` as the sign-out of every `@adonis-agora` console
   * (`account.signOut` on the `'agora.consoles'` registry). Skipped when authkit-server runs
   * in this app (it announces its own) or when something announced one first. Default: `true`.
   */
  announceSignOut?: boolean;
  /**
   * The application to announce on, and where `registerOidcClient` looks for authkit-server
   * (embedded topology). Default: `@adonisjs/core/services/app`.
   */
  app?: ConsolesAppLike;
}

/** A route handler of {@link oidcClientRoutes}: mount it on any route of your app. */
export type OidcClientHandler = (ctx: HttpContext) => Promise<unknown>;

/** The handlers {@link registerOidcClient} mounts, for apps that mount the routes themselves. */
export interface OidcClientRoutes {
  /** Starts the authorize flow (state, nonce, PKCE) and redirects to the identity server. */
  login: OidcClientHandler;
  /** Same flow as `login`, asking the identity server for its sign-up screen (`prompt=create`). */
  signup: OidcClientHandler;
  /** Finishes the authorize flow, starts the session and redirects into the app. */
  callback: OidcClientHandler;
  /** Ends the local session and sends the browser to the identity server's end-session endpoint. */
  logout: OidcClientHandler;
  /** OIDC Back-Channel Logout receiver (`POST`). */
  backchannelLogout: OidcClientHandler;
  /** Redirects to the identity server's account pages, keeping the wildcard rest and the query. */
  account: OidcClientHandler;
  /** Redirects to the identity server's forgot-password page, keeping the query. */
  forgotPassword: OidcClientHandler;
  /** Redirects to the identity server's reset-password page, keeping the wildcard rest and the query. */
  resetPassword: OidcClientHandler;
  /** Redirects to the identity server's admin console, keeping the wildcard rest and the query. */
  admin: OidcClientHandler;
}

/**
 * The identity pages of the issuer the redirect handlers point at. Each one comes from the
 * issuer's discovery document (`authkit_*_uri`, see the server docs) or the `endpoints`
 * overrides, falling back to the authkit-server defaults on the issuer origin.
 */
type IssuerPage =
  | 'accountUri'
  | 'accountHomeUri'
  | 'adminUri'
  | 'forgotPasswordUri'
  | 'resetPasswordUri';

const ISSUER_PAGE_DEFAULTS: Record<IssuerPage, string> = {
  accountUri: '/account',
  accountHomeUri: '/account/security',
  adminUri: '/admin',
  forgotPasswordUri: '/auth/forgot-password',
  resetPasswordUri: '/auth/reset-password',
};

/**
 * The client routes as standalone handlers, built from the same options as
 * {@link registerOidcClient} (which mounts exactly these). Use it to mount only some of
 * them, or at your own paths:
 *
 * ```ts
 * // start/routes.ts
 * import { oidcClientRoutes } from '@adonis-agora/authkit-client'
 * const oidc = oidcClientRoutes({ redirects: { default: '/dashboard' } })
 * router.get('/auth/login', oidc.login).use(middleware.guest()).as('auth.login')
 * router.get('/auth/callback', oidc.callback).as('auth.callback')
 * router.post('/auth/logout', oidc.logout).as('auth.logout')
 * ```
 *
 * The redirect handlers (`account`, `resetPassword`, `admin`) append the route's wildcard
 * (`/*`) to the issuer page, so mount them on a wildcard route to keep the rest of the path.
 * `prefix` is only used to restart a failed callback at `{prefix}/login`.
 */
export function oidcClientRoutes(options: RegisterOidcClientOptions = {}): OidcClientRoutes {
  const prefix = options.prefix ?? '/auth';
  const passthrough = options.passthroughParams ?? ['audience'];
  const pkceKey = 'authkit_pkce';

  // Todo redirect destes handlers vai para uma URL que a PRÓPRIA lib monta (authorize,
  // /login, destino do app, end-session, página do issuer), então nenhum deve encaminhar
  // a query da request atual. Isso precisa ser o builder `withQs(false)`, NÃO o segundo
  // argumento de `redirect(path, forwardQueryString)`: quando o app liga
  // `redirect.forwardQueryString` no config/app.ts — que é o caso comum — o
  // positional é ignorado e o Redirect herda a config global, encaminhando mesmo
  // assim. Sem o opt-out explícito o `code`/`state`/`iss` do callback vazam para o
  // destino (o app termina em `/?code=…`) e o `/auth/login` de um callback falho
  // arrasta o code antigo para o authorize seguinte. Os redirects para o issuer
  // repassam a query por conta própria, já dentro da URL montada.
  const startAuthorize = async (ctx: HttpContext, forced: Record<string, string>) => {
    const manager = await ctx.containerResolver.make('authkit.client');

    const extraParams: Record<string, string> = {};
    for (const param of passthrough) {
      const v = ctx.request.input(param);
      if (v !== undefined && v !== null && v !== '') extraParams[param] = String(v);
    }
    Object.assign(extraParams, forced);

    const { url, pending } = await manager.createAuthorizationRequest({ extraParams });
    (ctx as any).session?.put(pkceKey, pending);
    return ctx.response.redirect().withQs(false).toPath(url);
  };

  const toIssuerPage =
    (page: IssuerPage, options: { rest?: boolean; home?: IssuerPage } = {}): OidcClientHandler =>
    async (ctx) => {
      const manager = await ctx.containerResolver.make('authkit.client');
      const rest = options.rest ? wildcardRest(ctx) : '';
      const target =
        rest === '' && options.home
          ? await issuerPage(manager, options.home)
          : await issuerPage(manager, page);
      if (rest) target.pathname = `${target.pathname.replace(/\/+$/, '')}${rest}`;
      const query = rawQuery(ctx);
      if (query) target.search = target.search ? `${target.search}&${query}` : `?${query}`;
      return ctx.response.redirect().withQs(false).toPath(target.toString());
    };

  return {
    login: (ctx) => startAuthorize(ctx, {}),

    // OpenID Connect "Initiating User Registration via OpenID Connect 1.0".
    signup: (ctx) => startAuthorize(ctx, { prompt: 'create' }),

    callback: async (ctx) => {
      const manager = await ctx.containerResolver.make('authkit.client');
      const pending = (ctx as any).session?.get(pkceKey);
      // Single use, whatever the outcome.
      (ctx as any).session?.forget(pkceKey);

      let tokenSet: TokenSet;
      try {
        ({ tokens: tokenSet } = await manager.completeAuthorization({
          pending,
          callbackParams: ctx.request.qs(),
        }));
      } catch (error) {
        // Stale/expired callback (lost state, no code) or the IdP sent the user back
        // with an error (access_denied…) → restart the login, as before. A failed
        // id_token check or token exchange is a real failure and propagates.
        if (error instanceof OidcCallbackError && error.restartable) {
          return ctx.response.redirect().withQs(false).toPath(`${prefix}/login`);
        }
        throw error;
      }
      // startSession, não `put(sessionKey)`: um login novo no mesmo cookie jar não pode
      // herdar a credencial de impersonação parqueada pela sessão anterior.
      manager.startSession(ctx, tokenSet);

      const authenticator = await manager.createAuthenticator(ctx);
      const identity = await authenticator.getIdentity();

      // 1) Hook do app tem prioridade quando retorna uma rota.
      const hook = await options.afterLogin?.(ctx, identity);
      if (typeof hook === 'string') return ctx.response.redirect().withQs(false).toPath(hook);

      // 2) Redirect por role global (do token).
      const dest = resolveDestination(identity, options.redirects);
      return ctx.response.redirect().withQs(false).toPath(dest);
    },

    logout: async (ctx) => {
      const manager = await ctx.containerResolver.make('authkit.client');
      const cfg = manager.clientConfig;
      const idToken = manager.getIdToken(ctx);
      // Leva junto a credencial de impersonação parqueada — era este logout que a
      // deixava para trás, viva, para a próxima identidade do mesmo cookie jar.
      manager.endSession(ctx);

      const postLogoutRedirectUri =
        typeof options.postLogoutRedirect === 'function'
          ? options.postLogoutRedirect(ctx)
          : (options.postLogoutRedirect ?? `${new URL(cfg.redirectUri).origin}/`);

      // The local session is already gone. With no end_session_endpoint to send the
      // browser to — the IdP publishes none (some Auth0 tenants) or discovery is
      // failing right now — go straight to the destination instead of erroring.
      const endSessionEndpoint = await manager.endpoints().then(
        (endpoints: OidcEndpoints) => endpoints.endSessionEndpoint,
        () => undefined,
      );
      if (!endSessionEndpoint) {
        return ctx.response.redirect().withQs(false).toPath(postLogoutRedirectUri);
      }
      const endSessionUrl = buildEndSessionUrl({
        issuer: cfg.issuer,
        idToken,
        postLogoutRedirectUri,
        clientId: cfg.clientId,
        endSessionEndpoint,
      });
      return ctx.response.redirect().withQs(false).toPath(endSessionUrl);
    },

    backchannelLogout: async (ctx) => {
      const manager = await ctx.containerResolver.make('authkit.client');
      return manager.handleBackchannelLogout(ctx);
    },

    account: toIssuerPage('accountUri', { rest: true, home: 'accountHomeUri' }),
    forgotPassword: toIssuerPage('forgotPasswordUri'),
    resetPassword: toIssuerPage('resetPasswordUri', { rest: true }),
    admin: toIssuerPage('adminUri', { rest: true }),
  };
}

/**
 * Registra as rotas OIDC de CLIENT — tudo o que um app relying party precisa para que a
 * identidade fique no identity server:
 *
 * - `GET {prefix}/login`, `GET {prefix}/signup` (`prompt=create`), `GET {prefix}/callback`,
 *   `POST {prefix}/logout`, `POST {prefix}/backchannel-logout`;
 * - redirects para as páginas do issuer (path restante + query preservados):
 *   `GET /account` e `/account/*`, `GET {prefix}/forgot-password`,
 *   `GET {prefix}/reset-password[/*]`, `GET {prefix}/admin[/*]`;
 * - `GET`/`POST /.well-known/agora-account-extensions`.
 *
 * When authkit-server runs in this same app (embedded topology) it serves those pages
 * itself, so the redirects are not mounted.
 *
 * Para montar só uma parte (ou em outros paths), use {@link oidcClientRoutes}.
 *
 * ```ts
 * // start/routes.ts
 * import { registerOidcClient } from '@adonis-agora/authkit-client'
 * registerOidcClient(router, {
 *   loginMiddleware: middleware.guest(),
 *   redirects: { byGlobalRole: { ADMIN: '/admin' }, default: '/' },
 * })
 * ```
 */
export function registerOidcClient(router: Router, options: RegisterOidcClientOptions = {}): void {
  const prefix = options.prefix ?? '/auth';
  const routes = oidcClientRoutes(options);

  const loginRoute = router.get(`${prefix}/login`, routes.login).as('auth.login');
  const signupRoute = router.get(`${prefix}/signup`, routes.signup).as('auth.signup');
  if (options.loginMiddleware) {
    loginRoute.use(options.loginMiddleware);
    signupRoute.use(options.loginMiddleware);
  }

  router.get(`${prefix}/callback`, routes.callback).as('auth.callback');
  router.post(`${prefix}/logout`, routes.logout).as('auth.logout');

  if (options.backchannelLogout !== false) {
    router
      .post(`${prefix}/backchannel-logout`, routes.backchannelLogout)
      .as('auth.backchannel_logout');
  }

  // The identity server owns these pages; old links (e-mails, bookmarks) land on the issuer.
  // Embedded topology: this app IS the issuer and already serves them.
  if (!hostsAuthkitServer(options.app)) {
    router.get('/account', routes.account).as('auth.account');
    router.get('/account/*', routes.account).as('auth.account.page');
    router.get(`${prefix}/forgot-password`, routes.forgotPassword).as('auth.forgot_password');
    router.get(`${prefix}/reset-password`, routes.resetPassword).as('auth.reset_password');
    router.get(`${prefix}/reset-password/*`, routes.resetPassword).as('auth.reset_password.token');
    router.get(`${prefix}/admin`, routes.admin).as('auth.admin');
    router.get(`${prefix}/admin/*`, routes.admin).as('auth.admin.page');
  }

  if (options.accountExtensions !== false) registerAccountExtensionsEndpoint(router);

  if (options.announceSignOut !== false) {
    void announceRpSignOut(options.app, `${prefix}/logout`);
  }
}

/**
 * The issuer page `page` as a URL on the issuer origin: what the issuer publishes (or the
 * `endpoints` override) when it is on that origin, else the authkit-server default. Never a
 * URL on another origin, so no redirect handler can be pointed off the identity server.
 */
async function issuerPage(manager: any, page: IssuerPage): Promise<URL> {
  const origin = new URL(manager.clientConfig.issuer).origin;
  const endpoints: Partial<OidcEndpoints> | undefined = await manager
    .endpoints()
    .catch(() => undefined);
  const published = endpoints?.[page];
  if (published) {
    try {
      const url = new URL(published, origin);
      if (url.origin === origin) return url;
    } catch {
      // not a URL: use the default
    }
  }
  return new URL(ISSUER_PAGE_DEFAULTS[page], origin);
}

/**
 * The route's wildcard (`/*`) as a path suffix (`/a/b`), each segment re-encoded. A `.` or
 * `..` segment drops the whole rest, so the suffix always stays under the issuer page.
 */
function wildcardRest(ctx: HttpContext): string {
  const raw = (ctx.params as Record<string, unknown> | undefined)?.['*'];
  const segments = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('/') : [])
    .map(String)
    .filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) return '';
  return segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
}

/** The request's raw query string, without the `?`. */
function rawQuery(ctx: HttpContext): string {
  const url = ctx.request.url(true);
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index + 1);
}

/** Whether authkit-server runs in this app (it binds `authkit.server`). Never throws. */
function hostsAuthkitServer(app: ConsolesAppLike | undefined): boolean {
  try {
    const target = app ?? (appService as unknown as ConsolesAppLike | undefined);
    return target?.container?.hasBinding('authkit.server') === true;
  } catch {
    return false;
  }
}

/**
 * Announces the RP logout on the consoles registry, unless authkit-server (which announces
 * its account sign-out) runs in this app. Best effort: never throws.
 */
async function announceRpSignOut(app: ConsolesAppLike | undefined, action: string): Promise<void> {
  try {
    const target = app ?? (appService as unknown as ConsolesAppLike | undefined);
    if (!target?.container) return;
    if (target.container.hasBinding('authkit.server')) return;
    await announceAgoraSignOut(target, action);
  } catch {
    // no booted app (a bare router in tests) or a registry of another shape
  }
}

/**
 * Mounts `GET`/`POST /.well-known/agora-account-extensions`, where the IdP's account console
 * fetches this app's account extension pages (answers 404 until `accountConsole.remote` is on).
 * {@link registerOidcClient} calls it; call it yourself when you mount the client routes by hand.
 * The IdP POSTs without a CSRF token: add the path to shield's `csrf.exceptRoutes`.
 */
export function registerAccountExtensionsEndpoint(router: Router): void {
  const handle = async (ctx: HttpContext) => {
    const manager = await ctx.containerResolver.make('authkit.client');
    return manager.handleAccountExtensions(ctx);
  };
  router.get(ACCOUNT_EXTENSIONS_WELL_KNOWN, handle).as('authkit.account_extensions');
  router.post(ACCOUNT_EXTENSIONS_WELL_KNOWN, handle).as('authkit.account_extensions.call');
}

/** Resolve o destino pós-login a partir do mapa de redirects por role global (do token). */
function resolveDestination(identity: Identity | null, redirects?: PostLoginRedirects): string {
  if (!redirects) return '/';
  const globalRoles = identity?.globalRoles ?? [];
  if (redirects.byGlobalRole) {
    for (const [role, path] of Object.entries(redirects.byGlobalRole)) {
      if (globalRoles.includes(role)) return path;
    }
  }
  return redirects.default ?? '/';
}
