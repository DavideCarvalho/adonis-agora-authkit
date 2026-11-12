import type { Identity, SessionResolver } from '@adonis-agora/authkit-core';
import { AUTHKIT_METRICS, type MetricsRecorder, NoopRecorder } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { type ClientTenancyOptions, populateContext } from './observability/context_bridge.js';

/** Contexto opcional repassado a `resolveUser` (extensão backward-compatible). */
export interface ResolveUserContext {
  accessToken?: string;
}

export interface AuthenticatorDeps {
  resolver: SessionResolver;
  resolveUser?: (identity: Identity, context: ResolveUserContext) => Promise<unknown>;
  /** lê o access token do token set da sessão (opcional; usado por resolvers userinfo) */
  getAccessToken?: () => string | null | undefined;
  /** Opções de tenancy (`config/authkit_client.ts` → `tenancy`) usadas ao publicar o tenant. */
  tenancy?: ClientTenancyOptions;
}

/**
 * Autenticador do request. O parâmetro `TUser` é o tipo do usuário do app que `resolveUser`
 * devolve — o app o fixa pela interface `AuthkitUserType`, e aí `getUser()` passa a devolver
 * `AppUser | null` em todo call-site, sem cast. Default `unknown`.
 */
export class Authenticator<TUser = unknown> {
  #identity: Identity | null = null;
  #resolved = false;
  #user: TUser | null = null;
  #userResolved = false;

  #recorder: MetricsRecorder;

  constructor(
    private ctx: HttpContext,
    private deps: AuthenticatorDeps,
    recorder: MetricsRecorder = new NoopRecorder(),
  ) {
    this.#recorder = recorder;
  }

  async getIdentity(): Promise<Identity | null> {
    if (!this.#resolved) {
      const start = Date.now();
      try {
        this.#identity = await this.deps.resolver.resolve(this.ctx);
      } catch (error) {
        this.#recorder.increment(AUTHKIT_METRICS.resolveErrors);
        throw error;
      } finally {
        this.#recorder.record(AUTHKIT_METRICS.resolveDuration, Date.now() - start);
      }
      this.#resolved = true;
      // Ponte estrutural: popula o contexto do Agora quando há sessão de fato
      // (best-effort, no-op sem o slot `@agora/context:set`). Apenas no caminho
      // de sucesso — não força resolução para requests anônimas.
      if (this.#identity) populateContext(this.#identity, this.deps.tenancy);
    }
    return this.#identity;
  }

  get identity(): Identity | null {
    return this.#identity;
  }

  async authenticate(): Promise<Identity> {
    const identity = await this.getIdentity();
    if (!identity) throw new Error('Not authenticated');
    return identity;
  }

  async check(): Promise<boolean> {
    return (await this.getIdentity()) !== null;
  }

  /** `true` when the app configured `resolveUser` (e.g. `lucidMirror`) for this client. */
  get resolvesUser(): boolean {
    return typeof this.deps.resolveUser === 'function';
  }

  hasGlobalRole(role: string): boolean {
    return this.#identity?.globalRoles.includes(role) ?? false;
  }

  async getUser(): Promise<TUser | null> {
    if (this.#userResolved) return this.#user;
    const identity = await this.getIdentity();
    if (identity && this.deps.resolveUser) {
      const accessToken = this.deps.getAccessToken?.() ?? undefined;
      // `resolveUser` é tipado `Promise<unknown>` (a lib não conhece o model do app); o `TUser`
      // é a asserção do consumidor, feita UMA vez aqui em vez de em cada call-site de `getUser()`.
      this.#user = (await this.deps.resolveUser(identity, {
        accessToken,
      })) as TUser;
    } else {
      this.#user = null;
    }
    this.#userResolved = true;
    return this.#user;
  }

  /**
   * O `TUser` autenticado, NÃO-nulo. Fail-closed: lança quando não há sessão (ou quando `resolveUser`
   * não devolve usuário) — pensado para rotas atrás do middleware de auth, onde `null` seria uma
   * rota mal-configurada, não um visitante. Espelha `authenticate()` (que devolve a `Identity`); este
   * devolve o usuário do app. Substitui o wrapper `currentUser(auth)` que cada app reescrevia sobre
   * `getUser()`. Para rotas que aceitam visitante, use `getUser()` (devolve `TUser | null`).
   */
  async getUserOrFail(): Promise<TUser> {
    const user = await this.getUser();
    if (user === null) {
      throw new Error('Not authenticated: no user for the current session');
    }
    return user;
  }

  /**
   * Monta o objeto pronto para compartilhar com o frontend (ex.: Inertia share),
   * casando com o `AuthSharedProps` que o `@adonis-agora/authkit-react` consome.
   * Retorna `null` quando não há sessão. Autorização (roles de app/permissões)
   * é responsabilidade do `@adonis-agora/authz` — o AuthKit só autentica.
   */
  async toSharedProps(): Promise<{
    user: TUser | null;
    globalRoles: string[];
  } | null> {
    const identity = await this.getIdentity();
    if (!identity) return null;
    const user = await this.getUser();
    return { user, globalRoles: identity.globalRoles ?? [] };
  }
}
