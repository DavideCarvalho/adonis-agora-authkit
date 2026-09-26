// `import type` para TUDO que vem de `@adonisjs/auth` — apagado no build. Mesmo
// motivo do `oidc_rp_guard.ts`: `@adonisjs/auth` é peer OPCIONAL e este módulo é
// reexportado pelo `index.ts`; o único acesso de runtime é o `import()` dinâmico
// de `loadUnauthorizedAccess`, que só roda quando o host resolve `config/auth.ts`.
import type { symbols } from '@adonisjs/auth';
import type { AuthClientResponse, GuardConfigProvider, GuardContract } from '@adonisjs/auth/types';
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types';
import type { EmitterLike } from '@adonisjs/core/types/events';
import {
  type AccessTokenVerifier,
  type InProcessIssuer,
  type IssueAccessTokenOptions,
  inProcessAccessTokenVerifier,
  type RemoteAccessTokenVerifierOptions,
  remoteAccessTokenVerifier,
  type VerifiedAccessToken,
} from './access_token_verifier.js';
import {
  clearBearerAccountId,
  setBearerAccountId,
  setBearerImpersonation,
} from './bearer_account.js';
import {
  cachedUnauthorizedAccessConstructor,
  loadUnauthorizedAccess,
  type UnauthorizedAccessConstructor,
} from './oidc_rp_guard.js';

type RealUser<UserProvider> = UserProvider extends SessionUserProviderContract<infer U> ? U : never;

/**
 * Driver do `E_UNAUTHORIZED_ACCESS` lançado pelo guard. `access_tokens` é o
 * renderer do `@adonisjs/auth` para o guard NATIVO de access tokens: 401 com
 * `{ errors: [{ message }] }` em JSON (ou texto/JSON:API) e NUNCA redirect — o que
 * uma API consumida por app mobile espera.
 */
const ERROR_RENDERER = 'access_tokens';

/** Política de aceitação do token, além de "é válido e não expirou". */
export interface OidcBearerGuardPolicy {
  /** Escopos exigidos (TODOS). Token sem algum deles → 401 `insufficient_scope`. */
  scopes?: string[];
  /**
   * Audience(s) aceitas (RFC 8707 resource indicators). Quando definido, o `aud`
   * do token precisa conter pelo menos uma. Token opaco emitido SEM `resource`
   * não tem `aud` e é recusado.
   */
  audience?: string | string[];
  /** Allowlist de `client_id` cujos tokens são aceitos. Ausente = qualquer client. */
  clientIds?: string[];
}

export type OidcBearerGuardOptions<UserProvider extends SessionUserProviderContract<unknown>> =
  OidcBearerGuardPolicy & {
    /**
     * User provider — o MESMO tipo do `oidcRpGuard` (`sessionUserProvider(...)`
     * ou `authkitUserProvider()`): o `sub` do token vai para `findById`.
     */
    provider: UserProvider | ConfigProvider<UserProvider>;
    /**
     * Modo resource server REMOTO (a API não hospeda o issuer): JWT access tokens
     * via JWKS do issuer (RFC 9068) e/ou tokens opacos via introspecção (RFC 7662).
     * Ausente = modo IN-PROCESS: verifica contra o issuer embarcado
     * (`authkit.server`), opaco e JWT.
     */
    remote?: RemoteAccessTokenVerifierOptions;
    /** Verificador próprio (avançado). Tem precedência sobre `remote`. */
    verifier?: AccessTokenVerifier;
  };

export type OidcBearerGuardEvents<User> = {
  'oidc_bearer:authentication_succeeded': {
    ctx: HttpContext;
    guardName: string;
    user: User;
    token: VerifiedAccessToken;
  };
  'oidc_bearer:authentication_failed': { ctx: HttpContext; guardName: string; error: Error };
};

/** `Authorization: Bearer <token>` (RFC 6750 §2.1). Esquema case-insensitive. */
const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i;

/**
 * Guard de `@adonisjs/auth` para APIs chamadas com access token do issuer do
 * authkit — o par do {@link OidcRpGuard} para clientes SEM sessão web: apps
 * nativos (React Native/Expo, RFC 8252), SPAs que falam direto com a API,
 * serviços. Lê `Authorization: Bearer <token>`, verifica o token (assinatura ou
 * adapter, expiração, revogação), aplica a política (escopos, audience, clients)
 * e resolve o user pelo `sub` no user provider.
 *
 * ```ts
 * // config/auth.ts
 * import { oidcBearerGuard, oidcRpGuard } from '@adonis-agora/authkit-server'
 * import { sessionUserProvider } from '@adonisjs/auth/session'
 *
 * const provider = sessionUserProvider({ model: () => import('#models/user') })
 *
 * const authConfig = defineConfig({
 *   default: 'web',
 *   guards: {
 *     web: oidcRpGuard({ provider }),
 *     api: oidcBearerGuard({ provider, scopes: ['openid'] }),
 *   },
 * })
 *
 * // start/routes.ts — aceita sessão OU bearer:
 * router.get('/me', ...).use(middleware.auth({ guards: ['web', 'api'] }))
 * ```
 *
 * Falha SEMPRE vira `E_UNAUTHORIZED_ACCESS` (401, sem redirect), com o header
 * `WWW-Authenticate: Bearer …` da RFC 6750 §3.
 */
export class OidcBearerGuard<UserProvider extends SessionUserProviderContract<unknown>>
  implements GuardContract<RealUser<UserProvider>>
{
  #name: string;
  #ctx: HttpContext;
  #emitter: EmitterLike<OidcBearerGuardEvents<RealUser<UserProvider>>>;
  #userProvider: UserProvider;
  #verifier: AccessTokenVerifier;
  #policy: OidcBearerGuardPolicy;
  #unauthorized?: UnauthorizedAccessConstructor;

  declare [symbols.GUARD_KNOWN_EVENTS]: OidcBearerGuardEvents<RealUser<UserProvider>>;

  driverName = 'oidc_bearer' as const;
  authenticationAttempted = false;
  isAuthenticated = false;
  user?: RealUser<UserProvider>;
  /** O access token verificado desta request (após `authenticate()` com sucesso). */
  accessToken?: VerifiedAccessToken;

  constructor(
    name: string,
    ctx: HttpContext,
    emitter: EmitterLike<OidcBearerGuardEvents<RealUser<UserProvider>>>,
    userProvider: UserProvider,
    verifier: AccessTokenVerifier,
    policy: OidcBearerGuardPolicy = {},
    unauthorized?: UnauthorizedAccessConstructor,
  ) {
    this.#name = name;
    this.#ctx = ctx;
    this.#emitter = emitter;
    this.#userProvider = userProvider;
    this.#verifier = verifier;
    this.#policy = policy;
    this.#unauthorized = unauthorized ?? cachedUnauthorizedAccessConstructor();
  }

  #unauthorizedError(message: string): Error {
    const Unauthorized = this.#unauthorized ?? cachedUnauthorizedAccessConstructor();
    if (!Unauthorized) return new RuntimeException(message);
    return new Unauthorized(message, { guardDriverName: ERROR_RENDERER });
  }

  /**
   * Falha de autenticação: header `WWW-Authenticate` (RFC 6750 §3), evento, e o
   * `E_UNAUTHORIZED_ACCESS`. Sem token → só o desafio `Bearer`; token recusado →
   * `error="invalid_token"` / `"insufficient_scope"`.
   */
  #fail(bearerError?: 'invalid_token' | 'insufficient_scope'): Error {
    let challenge = 'Bearer';
    if (bearerError) challenge += ` error="${bearerError}"`;
    if (bearerError === 'insufficient_scope' && this.#policy.scopes?.length) {
      challenge += `, scope="${this.#policy.scopes.join(' ')}"`;
    }
    this.#ctx.response?.header?.('WWW-Authenticate', challenge);
    clearBearerAccountId(this.#ctx);
    const error = this.#unauthorizedError('Unauthorized access');
    this.#emitter.emit('oidc_bearer:authentication_failed', {
      ctx: this.#ctx,
      guardName: this.#name,
      error,
    });
    return error;
  }

  getUserOrFail(): RealUser<UserProvider> {
    if (!this.user) {
      throw this.#unauthorizedError(
        'Cannot access user. Authentication has not been attempted or failed.',
      );
    }
    return this.user;
  }

  /** `true` quando o token autenticado tem TODOS os escopos pedidos. */
  hasScopes(...scopes: string[]): boolean {
    const granted = new Set(this.accessToken?.scopes ?? []);
    return scopes.every((s) => granted.has(s));
  }

  #bearerToken(): string | undefined {
    const header = this.#ctx.request.header('authorization');
    if (!header) return undefined;
    return BEARER.exec(header)?.[1];
  }

  #policyError(token: VerifiedAccessToken): 'invalid_token' | 'insufficient_scope' | null {
    const { clientIds, audience, scopes } = this.#policy;
    if (clientIds && (!token.clientId || !clientIds.includes(token.clientId))) {
      return 'invalid_token';
    }
    if (audience !== undefined) {
      const accepted = Array.isArray(audience) ? audience : [audience];
      if (!token.audience.some((a) => accepted.includes(a))) return 'invalid_token';
    }
    if (scopes?.length) {
      const granted = new Set(token.scopes);
      if (!scopes.every((s) => granted.has(s))) return 'insufficient_scope';
    }
    return null;
  }

  async authenticate(): Promise<RealUser<UserProvider>> {
    if (this.authenticationAttempted) {
      return this.getUserOrFail();
    }
    this.authenticationAttempted = true;
    this.#unauthorized ??= await loadUnauthorizedAccess('oidcBearerGuard');

    const raw = this.#bearerToken();
    if (!raw) throw this.#fail();

    const token = await this.#verifier.verify(raw);
    if (!token) throw this.#fail('invalid_token');

    const policyError = this.#policyError(token);
    if (policyError) throw this.#fail(policyError);

    const guardUser = await this.#userProvider.findById(token.sub);
    if (!guardUser) throw this.#fail('invalid_token');
    // Token de impersonation: o ator (o admin) também tem que existir AGORA. Conta
    // apagada/desativada depois da troca derruba o acesso na próxima request, sem
    // esperar o `exp` do token.
    if (token.actor && !(await this.#userProvider.findById(token.actor))) {
      throw this.#fail('invalid_token');
    }

    this.user = guardUser.getOriginal() as RealUser<UserProvider>;
    this.accessToken = token;
    this.isAuthenticated = true;
    setBearerAccountId(this.#ctx, String(guardUser.getId()));
    if (token.actor) {
      setBearerImpersonation(this.#ctx, { actorId: token.actor, exp: token.exp, jti: token.jti });
    }
    this.#emitter.emit('oidc_bearer:authentication_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      user: this.user,
      token,
    });
    return this.user;
  }

  /**
   * `authenticate()` sem lançar — só para falha de AUTENTICAÇÃO (mesma regra do
   * `OidcRpGuard#check`): erro de infraestrutura (banco, rede) é relançado.
   */
  async check(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch (error) {
      const Unauthorized = this.#unauthorized ?? cachedUnauthorizedAccessConstructor();
      if (Unauthorized && error instanceof Unauthorized) return false;
      throw error;
    }
  }

  /**
   * Para testes (`client.get('/api').loginAs(user)`): emite um access token REAL
   * no issuer embarcado e devolve o header `Authorization`. Só no modo in-process
   * — um resource server remoto não emite tokens.
   */
  async authenticateAsClient(
    user: RealUser<UserProvider>,
    options?: IssueAccessTokenOptions,
  ): Promise<AuthClientResponse> {
    if (!this.#verifier.issue) {
      throw new RuntimeException(
        'oidcBearerGuard: authenticateAsClient só funciona no modo in-process (o app hospeda o issuer).',
      );
    }
    const guardUser = await this.#userProvider.createUserForGuard(user);
    const token = await this.#verifier.issue(String(guardUser.getId()), {
      ...options,
      scopes: options?.scopes ?? this.#policy.scopes,
    });
    return { headers: { authorization: `Bearer ${token}` } };
  }
}

/**
 * Factory de config pro {@link OidcBearerGuard} — mesmo padrão do `oidcRpGuard()`
 * e do `sessionGuard()` nativo.
 */
export function oidcBearerGuard<UserProvider extends SessionUserProviderContract<unknown>>(
  config: OidcBearerGuardOptions<UserProvider>,
): GuardConfigProvider<(ctx: HttpContext) => OidcBearerGuard<UserProvider>> {
  return {
    async resolver(name: string, app: ApplicationService) {
      const emitter = await app.container.make('emitter');
      const unauthorized = await loadUnauthorizedAccess('oidcBearerGuard');

      let userProvider: UserProvider;
      if (typeof (config.provider as ConfigProvider<UserProvider>).resolver === 'function') {
        userProvider = await (config.provider as ConfigProvider<UserProvider>).resolver(app);
      } else {
        userProvider = config.provider as UserProvider;
      }

      // In-process: o `authkit.server` é resolvido na PRIMEIRA verificação (não
      // aqui) — a config do auth pode ser resolvida antes do provider do authkit
      // terminar o boot.
      const verifier =
        config.verifier ??
        (config.remote
          ? remoteAccessTokenVerifier(config.remote)
          : inProcessAccessTokenVerifier(
              async () => (await app.container.make('authkit.server')) as InProcessIssuer,
            ));

      const policy: OidcBearerGuardPolicy = {
        scopes: config.scopes,
        audience: config.audience,
        clientIds: config.clientIds,
      };

      return (ctx: HttpContext) =>
        new OidcBearerGuard(
          name,
          ctx,
          emitter as EmitterLike<OidcBearerGuardEvents<RealUser<UserProvider>>>,
          userProvider,
          verifier,
          policy,
          unauthorized,
        );
    },
  };
}
