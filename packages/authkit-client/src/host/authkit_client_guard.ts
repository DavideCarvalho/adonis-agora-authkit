// `import type` só para tudo que vem de `@adonisjs/auth` — apagado no build.
// `@adonisjs/auth` é um peer OPCIONAL: este módulo precisa importar limpo em um
// host que não o instalou (é o que o smoke de empacotamento verifica), então o
// único import de runtime é o `await import('@adonisjs/auth')` lá dentro do
// `resolver()`, que só roda quando o HOST resolve o `config/auth.ts` — ou seja,
// quando ele já escolheu usar `@adonisjs/auth`. Mesmo idioma do
// `authkitUserProvider()` do @adonis-agora/authkit-server.
import type { symbols } from '@adonisjs/auth';
import type { AuthClientResponse, GuardConfigProvider } from '@adonisjs/auth/types';
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types';
import type { Authenticator } from '../authenticator.js';
import { getAuthkit } from './request_authenticator.js';

/**
 * Construtor do `E_UNAUTHORIZED_ACCESS` do `@adonisjs/auth`, capturado no boot
 * (ver {@link authkitClientGuard}) para que `getUserOrFail()` — que o contrato
 * exige SÍNCRONO — possa lançá-lo sem um `await import()`.
 */
export type UnauthorizedAccessConstructor = new (
  message: string,
  options: { guardDriverName: string; redirectTo?: string },
) => Error;

/** O tipo de usuário REAL por trás de um user provider do `@adonisjs/auth`. */
type RealUser<UserProvider> = UserProvider extends SessionUserProviderContract<infer User>
  ? User
  : never;

/**
 * Guard de `@adonisjs/auth` apoiado na sessão OIDC do `@adonis-agora/authkit-client`.
 *
 * A fonte da verdade de "quem está logado" é o `SessionResolver` do authkit
 * (JWT/opaco/PAT, conforme `config/authkit_client.ts`) — o guard NÃO reimplementa
 * resolução de sessão nem lê a sessão por conta própria. Ele só faz a ponte:
 * pega o `sub` da `Identity` (`identity.userId`) e pede o usuário do app ao
 * `provider`, exatamente como o `sessionGuard` nativo faria com o id que ele
 * guarda na sessão.
 *
 * Consequência: `middleware.auth()`, `ctx.auth.user`, `auth.check()` e o Bouncer
 * passam a funcionar sobre uma sessão do authkit.
 */
export class AuthkitClientGuard<UserProvider extends SessionUserProviderContract<unknown>> {
  #ctx: HttpContext;
  #userProvider: UserProvider;
  #unauthorized: UnauthorizedAccessConstructor;
  #authkit?: Authenticator;

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
    unauthorized: UnauthorizedAccessConstructor,
  ) {
    this.#ctx = ctx;
    this.#userProvider = userProvider;
    this.#unauthorized = unauthorized;
  }

  /**
   * O {@link Authenticator} do authkit desta request (a `Identity` crua,
   * `hasGlobalRole`, `toSharedProps`). Só existe depois de uma tentativa de
   * autenticação; use `ctx.authkit` (via `authkit_context_middleware`) quando
   * precisar dele em rota pública.
   */
  get authkit(): Authenticator | undefined {
    return this.#authkit;
  }

  #failed(): Error {
    this.isAuthenticated = false;
    this.user = undefined;
    return new this.#unauthorized('Invalid or expired user session', {
      guardDriverName: this.driverName,
    });
  }

  /**
   * Autentica a request: resolve a sessão do authkit e mapeia o `sub` para o
   * usuário do app via `provider.findById`. Lança `E_UNAUTHORIZED_ACCESS` (o
   * MESMO erro dos guards nativos, então o `middleware.auth()` e o handler de
   * exceção do host tratam igual) quando não há sessão OU quando a sessão é
   * válida mas não existe usuário local correspondente (fail-closed).
   */
  async authenticate(): Promise<RealUser<UserProvider>> {
    if (this.authenticationAttempted) return this.getUserOrFail();
    this.authenticationAttempted = true;

    const authkit = await getAuthkit(this.#ctx);
    this.#authkit = authkit;

    const identity = await authkit.getIdentity();
    if (!identity) throw this.#failed();

    // `identity.userId` É a claim `sub` — o único id estável por conta que a
    // `Identity` tem. (Ela NÃO tem `id`.)
    const providerUser = await this.#userProvider.findById(identity.userId);
    if (!providerUser) throw this.#failed();

    this.user = providerUser.getOriginal() as RealUser<UserProvider>;
    this.isAuthenticated = true;
    return this.user;
  }

  /** Igual aos guards nativos: `authenticate()` sem lançar. */
  async check(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch (error) {
      if (error instanceof this.#unauthorized) return false;
      throw error;
    }
  }

  /** O usuário autenticado, ou `E_UNAUTHORIZED_ACCESS`. */
  getUserOrFail(): RealUser<UserProvider> {
    if (!this.user) {
      throw new this.#unauthorized('Invalid or expired user session', {
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
 * import { authkitClientGuard } from '@adonis-agora/authkit-client'
 *
 * export default defineConfig({
 *   default: 'web',
 *   guards: {
 *     web: authkitClientGuard({
 *       provider: sessionUserProvider({ model: () => import('#models/user') }),
 *     }),
 *   },
 * })
 * ```
 *
 * O `provider` é o MESMO contrato do `sessionGuard` nativo, então qualquer user
 * provider de session serve. O `findById` recebe `identity.userId` (a claim
 * `sub`) — a coluna de id do model precisa ser essa (é o que o `lucidMirror()`
 * grava).
 *
 * Precedência com `resolveUser` de `config/authkit_client.ts`: são superfícies
 * SEPARADAS e ambas continuam valendo. `ctx.auth.user` (framework) vem SEMPRE do
 * `provider`; `ctx.authkit.getUser()` (authkit) continua vindo do `resolveUser`.
 * O guard nunca chama `resolveUser`. Com o guard configurado, o normal é apagar
 * o `resolveUser` e deixar só o `provider`.
 */
export function authkitClientGuard<
  UserProvider extends SessionUserProviderContract<unknown>,
>(config: {
  provider: UserProvider | ConfigProvider<UserProvider>;
}): GuardConfigProvider<(ctx: HttpContext) => AuthkitClientGuard<UserProvider>> {
  return {
    async resolver(name: string, app: ApplicationService) {
      let unauthorized: UnauthorizedAccessConstructor;
      try {
        const auth = (await import('@adonisjs/auth')) as {
          errors: { E_UNAUTHORIZED_ACCESS: UnauthorizedAccessConstructor };
        };
        unauthorized = auth.errors.E_UNAUTHORIZED_ACCESS;
      } catch (error) {
        throw new RuntimeException(
          'authkitClientGuard() precisa de "@adonisjs/auth" instalado (é um peer opcional do ' +
            '@adonis-agora/authkit-client, só necessário se você plugar este guard em config/auth.ts). ' +
            'Rode `npm i @adonisjs/auth` (ou pnpm/yarn).',
          { cause: error },
        );
      }

      const provider =
        'resolver' in config.provider
          ? ((await config.provider.resolver(app)) as UserProvider)
          : config.provider;

      return (ctx: HttpContext) => new AuthkitClientGuard(name, ctx, provider, unauthorized);
    },
  };
}
