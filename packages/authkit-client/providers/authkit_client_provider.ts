import type { SessionResolver } from '@adonis-agora/authkit-core';
import { configProvider } from '@adonisjs/core';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { Authenticator } from '../src/authenticator.js';
import { validateLogoutToken } from '../src/backchannel_logout.js';
import type { ResolvedClientConfig } from '../src/define_config.js';
import { exchangeToken, refreshTokens } from '../src/oidc_login.js';
import type { TokenSet } from '../src/types.js';

interface SessionLike {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  forget(key: string): void;
}

type CtxWithSession = HttpContext & { session?: SessionLike };

/** Margem (ms) antes do `expiresAt` em que o access token é renovado proativamente. */
const REFRESH_SKEW_MS = 60_000;

/** Deps injetáveis (relógio/fetch) para testar `maybeRefresh` sem rede/tempo real. */
export interface RefreshDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class AuthkitClientManager {
  #resolverCache?: SessionResolver;
  constructor(private config: ResolvedClientConfig) {}

  async #getResolver(): Promise<SessionResolver> {
    if (!this.#resolverCache) {
      this.#resolverCache = await this.config.resolverFactory.resolver({
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        sessionKey: this.config.sessionKey,
        globalRolesClaim: this.config.globalRolesClaim,
      });
    }
    return this.#resolverCache;
  }

  get clientConfig(): ResolvedClientConfig {
    return this.config;
  }

  /**
   * Lê o id_token armazenado no token set da sessão. Usado pelo logout federado
   * (RP-initiated) como `id_token_hint` ao redirecionar para `end_session_endpoint`.
   */
  getIdToken(ctx: HttpContext): string | undefined {
    const tokenSet = (ctx as CtxWithSession).session?.get(this.config.sessionKey) as
      | TokenSet
      | undefined;
    return tokenSet?.idToken || undefined;
  }

  /**
   * Renova o TokenSet da sessão proativamente se o access token estiver perto de
   * expirar (dentro de REFRESH_SKEW_MS) e houver refresh_token. Persiste o TokenSet
   * renovado — incluindo o refresh_token ROTACIONADO — de volta na sessão. Preserva
   * o id_token / refresh_token anteriores quando o IdP não os reemite.
   *
   * Best-effort: qualquer falha (token revogado, IdP fora) é silenciosa — o resolver
   * lida com a sessão expirada no fluxo normal. Chamado pelo middleware por request.
   */
  async maybeRefresh(ctx: HttpContext, deps: RefreshDeps = {}): Promise<void> {
    const session = (ctx as CtxWithSession).session;
    if (!session) return;
    const tokenSet = session.get(this.config.sessionKey) as TokenSet | undefined;
    if (!tokenSet?.refreshToken) return;

    const now = deps.now ?? Date.now;
    // Sem expiresAt conhecido, não renova proativamente (evita refresh a cada request).
    if (!tokenSet.expiresAt || tokenSet.expiresAt - now() > REFRESH_SKEW_MS) return;

    try {
      const next = await refreshTokens({
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: tokenSet.refreshToken,
        fetchImpl: deps.fetchImpl,
        resilience: this.config.resilience,
      });
      session.put(this.config.sessionKey, {
        idToken: next.idToken || tokenSet.idToken,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? tokenSet.refreshToken,
        expiresAt: next.expiresAt,
      } satisfies TokenSet);
    } catch {
      // Renovação falhou — deixa o TokenSet como está; o resolver decide a sessão.
    }
  }

  /**
   * Recebe o POST `application/x-www-form-urlencoded` de OIDC Back-Channel Logout. Lê o
   * `logout_token` do body, valida (assinatura + regras do spec), consulta o SessionIndex
   * (se houver) e invoca `onBackchannelLogout` p/ o host destruir as sessões locais.
   *
   * Retorna 200 em sucesso e 400 `{ error: 'invalid_request' }` em validação inválida.
   * Sempre seta `Cache-Control: no-store` (exigência do spec).
   */
  async handleBackchannelLogout(ctx: HttpContext): Promise<unknown> {
    const { request, response } = ctx;
    response.header('Cache-Control', 'no-store');

    const token = request.input('logout_token') as string | undefined;
    if (!token || typeof token !== 'string') {
      return response.badRequest({ error: 'invalid_request' });
    }

    let validated: { sid?: string; sub?: string };
    try {
      validated = await validateLogoutToken(token, {
        issuer: this.config.issuer,
        clientId: this.config.clientId,
      });
    } catch {
      return response.badRequest({ error: 'invalid_request' });
    }

    // Atualiza o índice local (se configurado) — revoga as sessões mapeadas.
    const index = this.config.sessionIndex;
    if (index) {
      if (validated.sid) await index.revokeBySid(validated.sid);
      else if (validated.sub) await index.revokeBySub(validated.sub);
    }

    // Delega ao host a destruição efetiva das sessões locais.
    await this.config.onBackchannelLogout?.({
      sid: validated.sid,
      sub: validated.sub,
    });

    return {};
  }

  /** Chave de sessão onde o token set ORIGINAL fica guardado durante a impersonação. */
  get #impersonatorKey(): string {
    return `${this.config.sessionKey}_impersonator`;
  }

  /**
   * Impersona `requestedSubject` via token-exchange (RFC 8693): guarda o token set
   * atual e o substitui pelo do alvo. Encapsula o malabarismo de session keys que o
   * consumidor fazia à mão. A AUTORIZAÇÃO (quem pode impersonar quem) é responsabilidade
   * do chamador (ex.: Bouncer) ANTES de chamar este método.
   */
  async impersonate(ctx: HttpContext, requestedSubject: string): Promise<void> {
    const session = (ctx as CtxWithSession).session;
    if (!session) throw new Error('Sem sessão ativa para impersonar a partir dela');
    const current = session.get(this.config.sessionKey) as TokenSet | undefined;
    if (!current?.accessToken) {
      throw new Error('Sem sessão ativa para impersonar a partir dela');
    }
    const impersonated = await exchangeToken({
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      subjectToken: current.accessToken,
      requestedSubject,
      resilience: this.config.resilience,
    });
    session.put(this.#impersonatorKey, current);
    session.put(this.config.sessionKey, impersonated);
  }

  /** Encerra a impersonação restaurando o token set original. Retorna false se não havia impersonação. */
  async stopImpersonating(ctx: HttpContext): Promise<boolean> {
    const session = (ctx as CtxWithSession).session;
    if (!session) return false;
    const original = session.get(this.#impersonatorKey) as TokenSet | undefined;
    if (!original) return false;
    session.put(this.config.sessionKey, original);
    session.forget(this.#impersonatorKey);
    return true;
  }

  /** Indica se a request corrente está impersonando (p/ exibir banner na UI). */
  isImpersonating(ctx: HttpContext): boolean {
    return Boolean((ctx as CtxWithSession).session?.get(this.#impersonatorKey));
  }

  async createAuthenticator(ctx: HttpContext): Promise<Authenticator> {
    const resolver = await this.#getResolver();
    const sessionKey = this.config.sessionKey;
    return new Authenticator(ctx, {
      resolver,
      resolveUser: this.config.resolveUser,
      getAccessToken: () => {
        const tokenSet = (ctx as CtxWithSession).session?.get(sessionKey) as TokenSet | undefined;
        return tokenSet?.accessToken;
      },
    });
  }
}

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'authkit.client': AuthkitClientManager;
  }
}

export default class AuthkitClientProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('authkit.client', async () => {
      const value = this.app.config.get('authkit_client');
      const config = (await configProvider.resolve(this.app, value)) as ResolvedClientConfig | null;
      if (!config) {
        throw new RuntimeException(
          'Config inválido em "config/authkit_client.ts". Use defineConfig de @adonis-agora/authkit-client.',
        );
      }
      return new AuthkitClientManager(config);
    });
  }
}
