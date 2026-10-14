// Single source of this package's container bindings (see container_bindings.ts).
// A bare side-effect import so the declaration survives into the emitted `.d.ts`.
import '../container_bindings.js';
import { randomUUID } from 'node:crypto';
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

/**
 * O que fica guardado em `${sessionKey}_impersonator` durante uma impersonação:
 * o token set do ATOR mais o vínculo com a sessão que o guardou.
 *
 * Versões <= 0.14 guardavam o TokenSet cru, sem vínculo — ver {@link readParked}.
 */
interface ParkedImpersonation {
  tokenSet: TokenSet;
  binding: string;
}

/** Aceita só o formato COM vínculo; o formato legado (TokenSet cru) vira `null`. */
function readParked(value: unknown): ParkedImpersonation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ParkedImpersonation>;
  if (typeof candidate.binding !== 'string' || !candidate.binding) return null;
  if (!candidate.tokenSet || typeof candidate.tokenSet !== 'object') return null;
  return candidate as ParkedImpersonation;
}

/** Deps injetáveis (relógio/fetch) para testar `maybeRefresh` sem rede/tempo real. */
export interface RefreshDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class AuthkitClientManager {
  #resolverCache?: SessionResolver;
  /**
   * Refreshes in-flight por sessionId (dedup thundering herd). A promise resolve com o
   * TokenSet renovado (já mesclado) ou `null` se falhou — nunca rejeita. Guarda também
   * o refresh token de origem, pra quem espera saber se é da mesma linhagem.
   */
  #refreshPromises = new Map<string, { refreshToken: string; promise: Promise<TokenSet | null> }>();
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
   * Preserva TAMBÉM o `impersonationBinding`: renovar o token do alvo não muda a
   * sessão, então não pode invalidar o vínculo e trancar o ator na impersonação.
   *
   * Dedup por sessionId: requests concorrentes da mesma sessão (ex.: autosave + vários
   * GETs chegando juntos quando o access token vence) disparam UM refresh só. Quem
   * chegou depois espera o refresh in-flight e grava o TokenSet renovado na SUA
   * PRÓPRIA sessão — cada request tem seu objeto de sessão, e sem isso ele seguiria
   * com o access token vencido (→ 401) e com o refresh token antigo, já invalidado
   * pela rotação, que ele poderia gravar de volta e envenenar a sessão.
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

    // Dedup: se já há um refresh in-flight pra esta sessão, espera ele ao invés de
    // disparar outro. O refresh token ROTACIONA — N requests concorrentes chegando
    // juntos fariam N refreshes + N-1 falhas com refresh token já inválido.
    const sessionId = (session as unknown as { sessionId?: string }).sessionId;
    if (sessionId) {
      const inFlight = this.#refreshPromises.get(sessionId);
      // Só aproveita o refresh in-flight se ele partiu do MESMO refresh token que esta
      // request tem — senão o TokenSet renovado é de outra linhagem (ex.: a sessão
      // trocou de token set no meio do caminho) e não pode ser gravado aqui.
      if (inFlight && inFlight.refreshToken === tokenSet.refreshToken) {
        const refreshed = await inFlight.promise;
        if (refreshed) {
          session.put(this.config.sessionKey, {
            ...refreshed,
            // O vínculo é por sessão (mesmo sessionId → mesmo vínculo); mantém o desta
            // request e só cai no do refresh se esta não tiver.
            impersonationBinding: tokenSet.impersonationBinding ?? refreshed.impersonationBinding,
          } satisfies TokenSet);
        }
        return;
      }
      // Linhagem diferente: segue e faz o próprio refresh (a entrada do mapa passa a
      // ser a desta request; a anterior não a apaga — ver o `finally`).
    }

    // Promise que NUNCA rejeita: resolve com o TokenSet gravado, ou `null` se a
    // renovação falhou — aí o TokenSet original fica como está (o resolver decide).
    const promise: Promise<TokenSet | null> = refreshTokens({
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: tokenSet.refreshToken,
      fetchImpl: deps.fetchImpl,
      resilience: this.config.resilience,
    })
      .then((next) => {
        const merged = {
          idToken: next.idToken || tokenSet.idToken,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? tokenSet.refreshToken,
          expiresAt: next.expiresAt,
          impersonationBinding: tokenSet.impersonationBinding,
        } satisfies TokenSet;
        session.put(this.config.sessionKey, merged);
        return merged;
      })
      .catch(() => null);

    if (!sessionId) {
      await promise;
      return;
    }

    const entry = { refreshToken: tokenSet.refreshToken, promise };
    this.#refreshPromises.set(sessionId, entry);
    try {
      await promise;
    } finally {
      // Só remove se a entrada ainda é a nossa.
      if (this.#refreshPromises.get(sessionId) === entry) this.#refreshPromises.delete(sessionId);
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
    // Vínculo: o mesmo nonce nos dois lados. O lado ATIVO mora dentro do token set
    // da sessão, o único slot que todo caminho de fim-de-sessão já limpa.
    const binding = randomUUID();
    session.put(this.#impersonatorKey, {
      tokenSet: current,
      binding,
    } satisfies ParkedImpersonation);
    session.put(this.config.sessionKey, { ...impersonated, impersonationBinding: binding });
  }

  /**
   * Encerra a impersonação restaurando o token set do ator — SE a sessão que pede
   * ainda for aquela para a qual a credencial foi guardada.
   *
   * A credencial parqueada é um refresh token vivo; sem essa conferência o restore
   * a entrega a quem estiver de posse do cookie jar depois (logout do ator + login
   * de outra identidade). A prova é o `impersonationBinding`: um nonce escrito ao
   * mesmo tempo dentro do token set ATIVO e do registro parqueado. Só `impersonate()`
   * o escreve e só o `maybeRefresh` o propaga — qualquer troca de identidade
   * reescreve o slot da sessão e o vínculo some.
   *
   * As conferências ÓBVIAS não servem, e é por isso que o vínculo existe:
   *  - `sub === sub do ator`: durante uma impersonação legítima a sessão é a do
   *    ALVO, então isso nunca é verdade — trancaria o ator dentro da impersonação;
   *  - "o token parqueado é de um admin?": sempre verdade; o atacante não alega
   *    ser o ator, ele pede a credencial do ator;
   *  - gate por papel: o ator impersonando carrega os papéis do ALVO nesse momento.
   *
   * Recusa é FAIL-CLOSED: a credencial órfã é DESCARTADA (nunca devolvida) e o
   * token set da sessão também cai — uma recusa não é uma tentativa a repetir, e
   * ninguém fica preso impersonando.
   *
   * LIMITE HONESTO: quem controla o cookie jar DURANTE uma impersonação ativa é
   * indistinguível do ator — é literalmente a mesma sessão, e o vínculo viaja nela.
   * Isso é o modelo de sessão, não esta conferência. O que fecha é a janela em que
   * a credencial sobrevive à sessão que a guardou.
   *
   * @returns `true` só quando o ator foi restaurado.
   */
  async stopImpersonating(ctx: HttpContext): Promise<boolean> {
    const session = (ctx as CtxWithSession).session;
    if (!session) return false;

    const raw = session.get(this.#impersonatorKey);
    if (raw === undefined || raw === null) return false;

    const parked = readParked(raw);
    const live = session.get(this.config.sessionKey) as TokenSet | undefined;

    // `parked === null` cobre o formato pré-0.15 (TokenSet cru, sem vínculo nenhum):
    // é justamente a credencial que não dá pra atribuir. Recusada como qualquer outra.
    if (!parked || !live?.impersonationBinding || live.impersonationBinding !== parked.binding) {
      session.forget(this.#impersonatorKey);
      session.forget(this.config.sessionKey);
      return false;
    }

    const { impersonationBinding: _binding, ...original } = parked.tokenSet;
    session.put(this.config.sessionKey, original satisfies TokenSet);
    session.forget(this.#impersonatorKey);
    return true;
  }

  /**
   * Indica se a request corrente está impersonando (p/ exibir banner na UI). Exige o
   * mesmo vínculo do `stopImpersonating` — uma credencial órfã de outra sessão não
   * faz o banner aparecer para quem não está impersonando ninguém.
   */
  isImpersonating(ctx: HttpContext): boolean {
    const session = (ctx as CtxWithSession).session;
    if (!session) return false;
    const parked = readParked(session.get(this.#impersonatorKey));
    if (!parked) return false;
    const live = session.get(this.config.sessionKey) as TokenSet | undefined;
    return live?.impersonationBinding === parked.binding;
  }

  /**
   * Encerra a sessão do AuthKit: remove o token set E qualquer credencial de
   * impersonação parqueada. Todo caminho da lib que derruba a sessão passa por aqui
   * — logout RP-initiated (`registerOidcClient`) e revogação back-channel.
   *
   * Existe porque um `session.forget(sessionKey)` solto deixava o refresh token do
   * ATOR parqueado no browser depois de uma revogação central — o mecanismo que o
   * operador usa justamente para matar a sessão.
   */
  endSession(ctx: HttpContext): void {
    const session = (ctx as CtxWithSession).session;
    if (!session) return;
    session.forget(this.config.sessionKey);
    session.forget(this.#impersonatorKey);
  }

  /**
   * Instala o token set de um login recém-concluído, descartando o que sobrou da
   * sessão anterior no mesmo cookie jar.
   *
   * O `stopImpersonating` já recusa uma credencial órfã — o token set novo nasce sem
   * `impersonationBinding`, então o vínculo não fecha. Mas recusar é só não DEVOLVER:
   * sem esta limpeza o refresh token do ator continua serializado no cookie de sessão
   * de outra identidade até a sessão expirar. Não devolver e não guardar são coisas
   * diferentes, e a segunda é a que mantém a invariante — a credencial parqueada nunca
   * sobrevive à sessão que a parqueou.
   */
  startSession(ctx: HttpContext, tokenSet: TokenSet): void {
    const session = (ctx as CtxWithSession).session;
    if (!session) return;
    session.forget(this.#impersonatorKey);
    session.put(this.config.sessionKey, tokenSet);
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
