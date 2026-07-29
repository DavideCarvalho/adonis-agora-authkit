import { symbols } from '@adonisjs/auth';
import type { AuthClientResponse, GuardConfigProvider, GuardContract } from '@adonisjs/auth/types';
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types';
import type { EmitterLike } from '@adonisjs/core/types/events';
import { ACCOUNT_SESSION_KEY } from './middleware/account_auth.js';

type RealUser<UserProvider> = UserProvider extends SessionUserProviderContract<infer U> ? U : never;

export type OidcRpGuardOptions<UserProvider extends SessionUserProviderContract<unknown>> = {
  provider: UserProvider | ConfigProvider<UserProvider>;
  sessionKey?: string;
};

export type OidcRpGuardEvents<User> = {
  'oidc_rp:login_succeeded': { ctx: HttpContext; guardName: string; user: User };
  'oidc_rp:authentication_succeeded': { ctx: HttpContext; guardName: string; user: User };
  'oidc_rp:authentication_failed': { ctx: HttpContext; guardName: string };
  'oidc_rp:logged_out': { ctx: HttpContext; guardName: string; user: User | null };
};

/**
 * Guard de `@adonisjs/auth` pra Relying Parties OIDC — o app não autentica
 * ninguém (sem senha, sem remember-me); a identidade vem da sessão gravada
 * pelo callback OIDC (`account_user_id`). O guard só LÊ essa chave e resolve
 * o user via provider.
 *
 * ```ts
 * // config/auth.ts
 * import { oidcRpGuard } from '@adonis-agora/authkit-server'
 * import { sessionUserProvider } from '@adonisjs/auth/session'
 *
 * const authConfig = defineConfig({
 *   default: 'web',
 *   guards: {
 *     web: oidcRpGuard({
 *       provider: sessionUserProvider({ model: () => import('#models/user') }),
 *     }),
 *   },
 * })
 * ```
 *
 * O callback OIDC do RP chama `ctx.auth.use('web').login(user)` pra gravar a
 * sessão; a partir daí `ctx.auth.user`, `auth.check()`, `middleware.auth()` —
 * tudo funciona nativamente.
 */
export class OidcRpGuard<UserProvider extends SessionUserProviderContract<unknown>>
  implements GuardContract<RealUser<UserProvider>>
{
  #name: string;
  #ctx: HttpContext;
  #sessionKey: string;
  #emitter: EmitterLike<OidcRpGuardEvents<RealUser<UserProvider>>>;
  #userProvider: UserProvider;

  [symbols.GUARD_KNOWN_EVENTS]: OidcRpGuardEvents<RealUser<UserProvider>> = {} as any;

  driverName = 'oidc_rp' as const;
  authenticationAttempted = false;
  isAuthenticated = false;
  isLoggedOut = false;
  user?: RealUser<UserProvider>;

  constructor(
    name: string,
    ctx: HttpContext,
    sessionKey: string,
    emitter: EmitterLike<OidcRpGuardEvents<RealUser<UserProvider>>>,
    userProvider: UserProvider,
  ) {
    this.#name = name;
    this.#ctx = ctx;
    this.#sessionKey = sessionKey;
    this.#emitter = emitter;
    this.#userProvider = userProvider;
  }

  getUserOrFail(): RealUser<UserProvider> {
    if (!this.user) {
      throw new RuntimeException(
        'Cannot access user. Authentication has not been attempted or failed.',
      );
    }
    return this.user;
  }

  /**
   * Grava a identidade na sessão. Chamado pelo callback OIDC após validar o
   * grant — o guard NÃO verifica credenciais, só persiste o id do user.
   */
  async login(user: RealUser<UserProvider>): Promise<void> {
    const guardUser = await this.#userProvider.createUserForGuard(user);
    this.#ctx.session.put(this.#sessionKey, String(guardUser.getId()));
    this.user = user;
    this.isAuthenticated = true;
    this.authenticationAttempted = true;
    this.#emitter.emit('oidc_rp:login_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      user,
    });
  }

  /**
   * Limpa a identidade da sessão. O RP-initiated logout (redirect pro
   * `end_session` do issuer) é responsabilidade do controller — o guard só
   * cuida da sessão local.
   */
  async logout(): Promise<void> {
    const user = this.user ?? null;
    this.#ctx.session.forget(this.#sessionKey);
    this.user = undefined;
    this.isAuthenticated = false;
    this.isLoggedOut = true;
    this.#emitter.emit('oidc_rp:logged_out', {
      ctx: this.#ctx,
      guardName: this.#name,
      user,
    });
  }

  async authenticate(): Promise<RealUser<UserProvider>> {
    if (this.authenticationAttempted) {
      return this.getUserOrFail();
    }
    this.authenticationAttempted = true;

    const userId = this.#ctx.session.get(this.#sessionKey) as string | undefined;
    if (!userId) {
      this.#emitter.emit('oidc_rp:authentication_failed', {
        ctx: this.#ctx,
        guardName: this.#name,
      });
      throw new RuntimeException('Unauthorized', { cause: 'E_UNAUTHORIZED_ACCESS' });
    }

    const guardUser = await this.#userProvider.findById(userId);
    if (!guardUser) {
      this.#ctx.session.forget(this.#sessionKey);
      this.#emitter.emit('oidc_rp:authentication_failed', {
        ctx: this.#ctx,
        guardName: this.#name,
      });
      throw new RuntimeException('Unauthorized', { cause: 'E_UNAUTHORIZED_ACCESS' });
    }

    this.user = guardUser.getOriginal() as RealUser<UserProvider>;
    this.isAuthenticated = true;
    this.#emitter.emit('oidc_rp:authentication_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      user: this.user,
    });
    return this.user;
  }

  async check(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  async authenticateAsClient(user: RealUser<UserProvider>): Promise<AuthClientResponse> {
    const guardUser = await this.#userProvider.createUserForGuard(user);
    return { session: { [this.#sessionKey]: String(guardUser.getId()) } };
  }
}

/**
 * Factory de config pro `oidcRpGuard` — mesmo padrão do `sessionGuard()` de
 * `@adonisjs/auth/session`. Retorna um `GuardConfigProvider` que o
 * `defineConfig` de `config/auth.ts` resolve no boot.
 */
export function oidcRpGuard<UserProvider extends SessionUserProviderContract<unknown>>(
  config: OidcRpGuardOptions<UserProvider>,
): GuardConfigProvider<(ctx: HttpContext) => OidcRpGuard<UserProvider>> {
  return {
    async resolver(name: string, app: ApplicationService) {
      const emitter = await app.container.make('emitter');
      const sessionKey = config.sessionKey ?? ACCOUNT_SESSION_KEY;

      let userProvider: UserProvider;
      if (typeof (config.provider as ConfigProvider<UserProvider>).resolver === 'function') {
        userProvider = await (config.provider as ConfigProvider<UserProvider>).resolver(app);
      } else {
        userProvider = config.provider as UserProvider;
      }

      return (ctx: HttpContext) => {
        return new OidcRpGuard(
          name,
          ctx,
          sessionKey,
          emitter as EmitterLike<OidcRpGuardEvents<RealUser<UserProvider>>>,
          userProvider,
        );
      };
    },
  };
}
