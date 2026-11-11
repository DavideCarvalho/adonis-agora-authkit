import type { Identity } from '@adonis-agora/authkit-core';
import { errors, type symbols } from '@adonisjs/auth';
import type { AuthClientResponse, GuardConfigProvider } from '@adonisjs/auth/types';
import type { SessionGuardUser, SessionUserProviderContract } from '@adonisjs/auth/types/session';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types';
import type { Authenticator } from '../authenticator.js';
import type { ResolverFactory } from '../resolvers/factory.js';
import { type AuthkitUser, getAuthkit } from './request_authenticator.js';

/** O tipo de usuário REAL por trás de um user provider do `@adonisjs/auth`. */
type RealUser<UserProvider> =
  UserProvider extends SessionUserProviderContract<infer User> ? User : never;

/**
 * User provider que pode montar o usuário direto da `Identity` (sem banco). É o
 * que {@link authkitIdentityProvider} devolve; o guard o usa antes de `findById`.
 */
export interface IdentityUserProviderContract<User> extends SessionUserProviderContract<User> {
  fromIdentity(identity: Identity): Promise<SessionGuardUser<User> | null>;
}

function canBuildFromIdentity<User>(
  provider: SessionUserProviderContract<User>,
): provider is IdentityUserProviderContract<User> {
  return (
    typeof (provider as Partial<IdentityUserProviderContract<User>>).fromIdentity === 'function'
  );
}

/**
 * Guard de `@adonisjs/auth` apoiado na sessão do `@adonis-agora/authkit-client`.
 *
 * A fonte da verdade de "quem está logado" é o `SessionResolver` do authkit
 * (sessão OIDC, bearer JWT, opaco/introspecção ou PAT, conforme
 * `config/authkit_client.ts` ou a opção `resolver` do guard). O guard não lê a
 * sessão por conta própria.
 *
 * O usuário vem, nesta ordem: do `resolveUser` de `config/authkit_client.ts`
 * (ex.: `lucidMirror`, que cria a linha local no primeiro login; é a MESMA
 * instância de `ctx.authkit.getUser()`), do provider montando o usuário da
 * `Identity` ({@link authkitIdentityProvider}), ou de `provider.findById(sub)`.
 *
 * Consequência: `middleware.auth()`, `ctx.auth.user`, `auth.check()` e o Bouncer
 * passam a funcionar sobre uma sessão do authkit.
 */
export class AuthkitClientGuard<UserProvider extends SessionUserProviderContract<unknown>> {
  #ctx: HttpContext;
  #userProvider: UserProvider;
  #resolver?: ResolverFactory;
  #authkit?: Authenticator<AuthkitUser>;

  /** Eventos do guard. Não emitimos nenhum (ainda) — o slot existe pro contrato. */
  declare [symbols.GUARD_KNOWN_EVENTS]: unknown;

  readonly driverName = 'authkit_client';

  authenticationAttempted = false;
  isAuthenticated = false;
  user?: RealUser<UserProvider>;

  constructor(
    _name: string,
    ctx: HttpContext,
    userProvider: UserProvider,
    options: { resolver?: ResolverFactory } = {},
  ) {
    this.#ctx = ctx;
    this.#userProvider = userProvider;
    this.#resolver = options.resolver;
  }

  /**
   * O {@link Authenticator} do authkit que este guard usou (a `Identity` crua,
   * `hasGlobalRole`, `toSharedProps`). Só existe depois de uma tentativa de
   * autenticação; use `ctx.authkit` (via `authkit_context_middleware`) quando
   * precisar dele em rota pública.
   */
  get authkit(): Authenticator<AuthkitUser> | undefined {
    return this.#authkit;
  }

  #failed(): Error {
    this.isAuthenticated = false;
    this.user = undefined;
    return new errors.E_UNAUTHORIZED_ACCESS('Invalid or expired user session', {
      guardDriverName: this.driverName,
    });
  }

  /**
   * The authenticator for this request. Without a `resolver` option it is the
   * request's shared `ctx.authkit`. With one, it is a separate authenticator over
   * that resolver; it becomes `ctx.authkit` only when nothing set it yet.
   */
  async #authenticator(): Promise<Authenticator<AuthkitUser>> {
    if (!this.#resolver) return getAuthkit(this.#ctx);

    const manager = await this.#ctx.containerResolver.make('authkit.client');
    const authenticator = (await manager.createAuthenticator(this.#ctx, {
      resolver: this.#resolver,
    })) as Authenticator<AuthkitUser>;
    const ctx = this.#ctx as unknown as { authkit?: Authenticator<AuthkitUser> };
    if (!ctx.authkit) ctx.authkit = authenticator;
    return authenticator;
  }

  /**
   * Autentica a request. Lança `E_UNAUTHORIZED_ACCESS` (o MESMO erro dos guards
   * nativos, então o `middleware.auth()` e o handler de exceção do host tratam
   * igual) quando não há sessão OU quando a sessão é válida mas nenhuma fonte
   * devolve usuário (fail-closed).
   */
  async authenticate(): Promise<RealUser<UserProvider>> {
    if (this.authenticationAttempted) return this.getUserOrFail();
    this.authenticationAttempted = true;

    const authkit = await this.#authenticator();
    this.#authkit = authkit;

    const identity = await authkit.getIdentity();
    if (!identity) throw this.#failed();

    // `resolveUser` (ex.: `lucidMirror`) provisiona a linha local no primeiro
    // login e devolve o usuário enriquecido; reaproveitá-lo mantém UMA instância
    // por request, compartilhada com `ctx.authkit.getUser()`.
    let user: unknown = null;
    if (authkit.resolvesUser) user = await authkit.getUser();

    if (user === null || user === undefined) {
      const provider = this.#userProvider as SessionUserProviderContract<unknown>;
      // `identity.userId` É a claim `sub` — o único id estável por conta que a
      // `Identity` tem. (Ela NÃO tem `id`.)
      const guardUser = canBuildFromIdentity(provider)
        ? await provider.fromIdentity(identity)
        : await provider.findById(identity.userId);
      user = guardUser?.getOriginal() ?? null;
    }
    if (user === null || user === undefined) throw this.#failed();

    this.user = user as RealUser<UserProvider>;
    this.isAuthenticated = true;
    return this.user;
  }

  /** Igual aos guards nativos: `authenticate()` sem lançar. */
  async check(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch (error) {
      if (error instanceof errors.E_UNAUTHORIZED_ACCESS) return false;
      throw error;
    }
  }

  /** O usuário autenticado, ou `E_UNAUTHORIZED_ACCESS`. */
  getUserOrFail(): RealUser<UserProvider> {
    if (!this.user) {
      throw new errors.E_UNAUTHORIZED_ACCESS('Invalid or expired user session', {
        guardDriverName: this.driverName,
      });
    }
    return this.user;
  }

  /**
   * Não implementado de propósito: a sessão deste guard é um TokenSet OIDC, e
   * forjar um `id_token` assinado pelo IdP não é algo que a lib possa fazer a
   * partir de um objeto de usuário. Use `@adonis-agora/authkit-testing`
   * (`mintTestIdToken`) e plante o TokenSet na sessão, ou injete um
   * `fakeAuthenticator()` em `ctx.authkit`.
   */
  async authenticateAsClient(): Promise<AuthClientResponse> {
    throw new RuntimeException(
      'authkitClientGuard não suporta "loginAs" nos plugins de teste: a sessão é um TokenSet OIDC ' +
        'assinado pelo IdP. Use mintTestIdToken() de @adonis-agora/authkit-testing e plante o ' +
        'TokenSet na sessão, ou injete fakeAuthenticator() em ctx.authkit.',
    );
  }
}

/**
 * Configura o {@link AuthkitClientGuard} em `config/auth.ts`:
 *
 * ```ts
 * import { defineConfig } from '@adonisjs/auth'
 * import { sessionUserProvider } from '@adonisjs/auth/session'
 * import { authkitClientGuard, authkitIdentityProvider } from '@adonis-agora/authkit-client/auth'
 * import { resolvers } from '@adonis-agora/authkit-client'
 *
 * export default defineConfig({
 *   default: 'web',
 *   guards: {
 *     web: authkitClientGuard({
 *       provider: sessionUserProvider({ model: () => import('#models/user') }),
 *     }),
 *     // API routes authenticated by a bearer access token.
 *     api: authkitClientGuard({
 *       provider: authkitIdentityProvider(),
 *       resolver: resolvers.jwt({ tokenSource: 'bearer' }),
 *     }),
 *   },
 * })
 * ```
 *
 * - `provider`: any session user provider. Its `findById` receives `identity.userId`
 *   (the `sub` claim). With `resolveUser` in `config/authkit_client.ts`, the guard
 *   uses that user first and the provider is the fallback.
 * - `resolver`: replaces the resolver of `config/authkit_client.ts` for this guard
 *   only (bearer JWT, opaque, PAT). Without it the guard uses the configured one.
 */
export function authkitClientGuard<
  UserProvider extends SessionUserProviderContract<unknown>,
>(config: {
  provider: UserProvider | ConfigProvider<UserProvider>;
  resolver?: ResolverFactory;
}): GuardConfigProvider<(ctx: HttpContext) => AuthkitClientGuard<UserProvider>> {
  return {
    async resolver(name: string, app: ApplicationService) {
      const provider =
        'resolver' in config.provider
          ? ((await config.provider.resolver(app)) as UserProvider)
          : config.provider;

      return (ctx: HttpContext) =>
        new AuthkitClientGuard(name, ctx, provider, { resolver: config.resolver });
    },
  };
}

/**
 * User provider with no database: `ctx.auth.user` is the AuthKit {@link Identity}
 * of the request (`userId`, `email`, `globalRoles`, `profile`, the raw claims).
 * Use it when the app keeps no local user table, or for API guards that only need
 * the token's subject. When `config/authkit_client.ts` sets `resolveUser`, the
 * guard uses that user instead.
 */
export function authkitIdentityProvider(): IdentityUserProviderContract<Identity> {
  return new AuthkitIdentityProvider();
}

class AuthkitIdentityProvider implements IdentityUserProviderContract<Identity> {
  declare [symbols.PROVIDER_REAL_USER]: Identity;

  #wrap(identity: Identity): SessionGuardUser<Identity> {
    return { getId: () => identity.userId, getOriginal: () => identity };
  }

  async fromIdentity(identity: Identity) {
    return this.#wrap(identity);
  }

  async createUserForGuard(identity: Identity) {
    return this.#wrap(identity);
  }

  /** There is no store to look an id up in: only the request's identity exists. */
  async findById() {
    return null;
  }
}
