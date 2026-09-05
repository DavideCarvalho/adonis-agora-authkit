import { getBootedApp } from '../../services/booted_app.js';
import type { AccountStore } from '../accounts/account_store.js';
import type { EnumeratedArtifact, OidcAdapter } from '../adapters/adapter_contract.js';
import { pickModelAdapterClass } from '../adapters/factory.js';
import type { OidcService } from '../provider/oidc_service.js';

/** Uma sessão ativa do IdP (login do usuário no provider), apresentada ao admin. */
export interface AdminSession {
  /** Id do artefato `Session` no adapter. */
  id: string;
  accountId: string;
  /**
   * Email da conta — resolvido pelo `listAllSessions()` na listagem global.
   * Ausente em `listSessions(accountId)` (já é implícito pelo contexto).
   */
  email?: string | null;
  /** Epoch (segundos) do login, quando presente no payload. */
  loginTs?: number;
  /** Métodos de autenticação registrados na sessão (amr), quando presentes. */
  amr?: string[];
  /**
   * User-agent bruto do login, recuperado do audit `login.success` por join
   * accountId+loginTs ({@link enrichSessionsWithContext}). Ausente quando o sink de
   * auditoria não consulta ou não há evento correlacionável.
   */
  userAgent?: string | null;
  /** Família do browser derivada do user-agent (ex.: 'Chrome'). */
  browser?: string | null;
  /** Sistema operacional derivado do user-agent (ex.: 'macOS'). */
  os?: string | null;
  /** IP do login (do mesmo audit `login.success`). */
  ip?: string | null;
  /** Localização legível resolvida via o hook `resolveGeo` (null sem hook/resolução). */
  location?: string | null;
}

/** Um grant (autorização concedida a um client), com a contagem de tokens vivos. */
export interface AdminGrant {
  /** Id do artefato `Grant` no adapter (== grantId dos tokens). */
  id: string;
  accountId: string;
  clientId?: string;
  /** Tokens de acesso vivos que referenciam este grant. */
  accessTokens: number;
  /** Refresh tokens vivos que referenciam este grant. */
  refreshTokens: number;
}

/** Resultado de uma revogação em massa das sessões/grants de uma conta. */
export interface RevokeResult {
  sessions: number;
  grants: number;
  accessTokens: number;
  refreshTokens: number;
}

/**
 * Serviço de inspeção/revogação das SESSÕES e GRANTS ativos de uma conta.
 * Lê/escreve via `pickModelAdapterClass` (a MESMA regra do provider): com
 * `session:` configurado, Session/Grant/tokens saem do adapter da sessão, não
 * do default. Encapsula:
 *   - a enumeração via a capacidade opcional `list` do adapter (degrada quando
 *     ausente, igual ao CRUD de clients);
 *   - a destruição das sessões + grants da conta. Destruir um grant CASCATEIA a
 *     invalidação dos tokens no oidc-provider: os consumidores de access/refresh
 *     token carregam `Grant.find(token.grantId)` e lançam `InvalidToken('grant not
 *     found')` quando o grant some (verificado em oidc-provider v9). Mesmo assim,
 *     por garantia (belt-and-braces), também destruímos as linhas de AT/RT que
 *     referenciam os grants revogados quando o adapter enumera.
 */
/** Limite máximo de sessões retornadas na listagem global (proteção contra explosão de memória). */
const GLOBAL_SESSION_LIMIT = 500;

export class AdminSessionsService {
  #AdapterClass: any;
  #SessionAdapterClass: any;
  #accountStore: AccountStore;
  /** Conexão Lucid das tabelas authkit (schema `auth`) — onde vive auth_session_revocations. */
  #schemaConnection?: string;

  constructor(oidc: OidcService) {
    this.#AdapterClass = oidc.config.AdapterClass;
    // `Session`/`Grant`/tokens vivem no adapter da sessão quando `session:`
    // está configurado (default: o mesmo do `AdapterClass`). `??` cobre
    // configs resolvidas por versões antigas do `defineConfig`.
    this.#SessionAdapterClass = oidc.config.SessionAdapterClass ?? oidc.config.AdapterClass;
    this.#accountStore = oidc.config.accountStore;
    this.#schemaConnection = oidc.config.schema?.connection;
  }

  #adapter(model: string): OidcAdapter {
    return new (pickModelAdapterClass(model, this.#AdapterClass, this.#SessionAdapterClass))(
      model,
    ) as OidcAdapter;
  }

  /**
   * Grava uma revogação por `sub` na tabela compartilhada `auth_session_revocations`,
   * para que clients COOKIE-BASED (que não têm store de sessão server-side) derrubem
   * a sessão na próxima request — INSTANTÂNEO, sem esperar o refresh token falhar.
   *
   * Best-effort: a destruição de grants/tokens acima já é a fonte da verdade; esta
   * linha só acelera o efeito nos clients. Falha (tabela ausente / lucid indisponível)
   * NÃO propaga — mas NUNCA é silenciosa: é logada em `error`, porque uma revogação de
   * sessão que não persiste é um risco de segurança que não pode ficar invisível.
   *
   * @param accountId Conta cujas sessões devem ser derrubadas (gravado em `sub`).
   * @param revokedAt Timestamp da revogação. Default: agora. A checagem do client
   *   é `revoked_at >= iat(id_token)` (em segundos): uma sessão só é derrubada se
   *   foi estabelecida ANTES (ou no mesmo segundo) da revogação. O
   *   {@link revokeAllExcept} passa um `revokedAt` ANTERIOR ao `iat` da sessão
   *   PRESERVADA, para que esta NÃO se auto-derrube (ver lá).
   */
  protected async recordSubRevocation(
    accountId: string,
    revokedAt: Date = new Date(),
  ): Promise<void> {
    try {
      // Resolve o Lucid pelo ALIAS STRING `'lucid.db'` (o mesmo idioma de
      // `runtime_settings.ts` e do provider), NUNCA por `import('@adonisjs/lucid/services/db')`
      // — esse resolve a CLASSE `Database` e a usa como TOKEN do container. Com duas cópias
      // físicas do lucid na árvore do host (pins distintos ou o mesmo pin sob peer sets
      // distintos, que o pnpm materializa em diretórios separados) os tokens-classe diferem, o
      // `make()` falha (`Cannot construct "[class Database]"`) e a gravação era engolida em
      // SILÊNCIO por este catch — a pior variante do bug. Um token string não pode ser
      // duplicado. O app vem do provider (ver `services/booted_app.ts`), não de `services/app`.
      const app = getBootedApp();
      const db = await app.container.make('lucid.db' as any);
      const conn = this.#schemaConnection
        ? (db as any).connection(this.#schemaConnection)
        : (db as any).connection();
      await conn.insertQuery().table('auth_session_revocations').insert({
        sid: null,
        sub: accountId,
        revoked_at: revokedAt,
      });
    } catch (error) {
      // A invalidação server-side (destruição de grants/tokens) já é a fonte da verdade, então
      // NÃO propagamos. Mas NUNCA engolimos em silêncio: logamos em `error` para que a falha da
      // propagação cookie-based (tabela ausente, lucid indisponível, provider não registrado)
      // seja visível — uma revogação que não persiste é um risco de segurança invisível.
      await this.#logRevocationFailure(accountId, error);
    }
  }

  /**
   * Loga (best-effort, sem nunca lançar) a falha de {@link recordSubRevocation}. Prefere o
   * `logger` do container; se ele não puder ser resolvido (ex.: o próprio `getBootedApp()` foi o
   * que falhou), cai em `console.error` — a falha PRECISA aparecer em algum lugar.
   */
  async #logRevocationFailure(accountId: string, error: unknown): Promise<void> {
    const msg =
      'authkit: falha ao gravar a revogação por sub (auth_session_revocations) — a propagação cookie-based da revogação de sessão não foi persistida';
    try {
      const logger = await getBootedApp().container.make('logger');
      (logger as any).error({ err: error, accountId }, msg);
    } catch {
      // eslint-disable-next-line no-console
      console.error(msg, { accountId, error });
    }
  }

  /** Indica se o adapter suporta enumeração (capacidade opcional). */
  get canList(): boolean {
    return typeof this.#adapter('Session').list === 'function';
  }

  async #listModel(model: string): Promise<EnumeratedArtifact[]> {
    const adapter = this.#adapter(model);
    if (!adapter.list) return [];
    return adapter.list();
  }

  /**
   * Conta TODAS as sessões ativas do IdP (todas as contas). 0 quando o adapter não
   * enumera. Usado pelo dashboard de métricas.
   */
  async countActiveSessions(): Promise<number> {
    const rows = await this.#listModel('Session');
    return rows.length;
  }

  /** Lista as sessões ativas da conta (vazio quando o adapter não enumera). */
  async listSessions(accountId: string): Promise<AdminSession[]> {
    const rows = await this.#listModel('Session');
    return rows
      .filter((r) => (r.payload.accountId as string | undefined) === accountId)
      .map((r) => ({
        id: r.id,
        accountId,
        loginTs: r.payload.loginTs as number | undefined,
        amr: (r.payload.amr as string[] | undefined) ?? undefined,
      }));
  }

  /**
   * Lista TODAS as sessões ativas de TODAS as contas — usada pela listagem global
   * do console admin (sem `accountId`). Resolve o email de cada conta via
   * `accountStore.findById` com cache por id (evita N+1). Limita a
   * {@link GLOBAL_SESSION_LIMIT} entradas; quando truncado, inclui `truncated:true`
   * nos metadados (accessível via `result.truncated`). Retorna vazio quando o
   * adapter não enumera.
   */
  async listAllSessions(): Promise<{ sessions: AdminSession[]; truncated: boolean }> {
    const rows = await this.#listModel('Session');
    const truncated = rows.length > GLOBAL_SESSION_LIMIT;
    const slice = truncated ? rows.slice(0, GLOBAL_SESSION_LIMIT) : rows;

    // Cache accountId → email para evitar N+1
    const emailCache = new Map<string, string | null>();
    const resolveEmail = async (accountId: string): Promise<string | null> => {
      if (emailCache.has(accountId)) return emailCache.get(accountId)!;
      const account = await this.#accountStore.findById(accountId);
      const email = account?.email ?? null;
      emailCache.set(accountId, email);
      return email;
    };

    const sessions = await Promise.all(
      slice.map(async (r) => {
        const accountId = (r.payload.accountId as string | undefined) ?? '';
        const email = accountId ? await resolveEmail(accountId) : null;
        return {
          id: r.id,
          accountId,
          email,
          loginTs: r.payload.loginTs as number | undefined,
          amr: (r.payload.amr as string[] | undefined) ?? undefined,
        } satisfies AdminSession;
      }),
    );

    return { sessions, truncated };
  }

  /**
   * Lista os grants da conta, com a contagem de access/refresh tokens vivos que
   * referenciam cada grant (`payload.grantId`). As contagens são baratas (uma
   * enumeração de cada model token), feitas só quando o adapter enumera.
   */
  async listGrants(accountId: string): Promise<AdminGrant[]> {
    const rows = await this.#listModel('Grant');
    const grants = rows.filter((r) => (r.payload.accountId as string | undefined) === accountId);
    if (grants.length === 0) return [];

    const atByGrant = await this.#countByGrant('AccessToken');
    const rtByGrant = await this.#countByGrant('RefreshToken');

    return grants.map((g) => ({
      id: g.id,
      accountId,
      clientId: g.payload.clientId as string | undefined,
      accessTokens: atByGrant.get(g.id) ?? 0,
      refreshTokens: rtByGrant.get(g.id) ?? 0,
    }));
  }

  /** Conta artefatos de um model token agrupados por `grantId`. */
  async #countByGrant(model: string): Promise<Map<string, number>> {
    const rows = await this.#listModel(model);
    const map = new Map<string, number>();
    for (const r of rows) {
      const gid = r.payload.grantId as string | undefined;
      if (!gid) continue;
      map.set(gid, (map.get(gid) ?? 0) + 1);
    }
    return map;
  }

  /**
   * Revoga todas as sessões e grants da conta EXCETO a sessão corrente (pelo id).
   * Usado pela política single-session: após login, revoga todas as outras sessões
   * preservando a recém-criada. Retorna as contagens do que foi removido.
   *
   * @param accountId Id da conta.
   * @param exceptSessionId Id da sessão OIDC a preservar (a sessão corrente).
   */
  async revokeAllExcept(accountId: string, exceptSessionId: string): Promise<RevokeResult> {
    const sessionAdapter = this.#adapter('Session');
    const grantAdapter = this.#adapter('Grant');

    const sessions = await this.listSessions(accountId);
    const preserved = sessions.find((s) => s.id === exceptSessionId);
    const sessionsToRevoke = sessions.filter((s) => s.id !== exceptSessionId);
    for (const s of sessionsToRevoke) {
      await sessionAdapter.destroy(s.id);
    }

    // Revogamos todos os grants da conta (que pertencem à conta, não à sessão
    // específica). A sessão corrente gerará novos grants no próximo authorize.
    // Isso garante que sessões antigas não mantenham tokens vivos.
    const grants = await this.listGrants(accountId);
    const grantIds = new Set(grants.map((g) => g.id));
    let accessTokens = 0;
    let refreshTokens = 0;
    accessTokens = await this.#destroyTokensOfGrants('AccessToken', grantIds);
    refreshTokens = await this.#destroyTokensOfGrants('RefreshToken', grantIds);
    for (const g of grants) {
      await grantAdapter.revokeByGrantId(g.id);
      await grantAdapter.destroy(g.id);
    }

    // M7: propaga a revogação por `sub` para clients COOKIE-BASED (instantâneo),
    // igual ao revokeAll. Sem isto, o 1º dispositivo só cai quando o AT expira.
    //
    // Ordem do `iat` (CUIDADO): a sessão PRESERVADA já existe aqui (foi criada no
    // completeLogin ANTES desta revogação), com `loginTs` (== iat do id_token) em
    // segundos. A checagem do client é `revoked_at >= iat`. Se gravássemos
    // `revoked_at = now`, como `now >= iat_preservada`, a sessão NOVA se
    // auto-derrubaria. Por isso ancoramos `revoked_at` ESTRITAMENTE ANTES do
    // `iat` da sessão preservada (`loginTs - 1s`): as sessões antigas (iat menor)
    // continuam sendo apanhadas (`revoked_at >= iat_antiga`), enquanto a nova
    // (iat = loginTs) sobrevive (`revoked_at < iat_nova`).
    //
    // Sem sessão preservada (exceptSessionId não encontrado / sem loginTs), caímos
    // no default (`now`) — não há sessão nova a proteger nesse caminho.
    const cutoff =
      typeof preserved?.loginTs === 'number' ? new Date((preserved.loginTs - 1) * 1000) : undefined;
    await this.recordSubRevocation(accountId, cutoff);

    return {
      sessions: sessionsToRevoke.length,
      grants: grants.length,
      accessTokens,
      refreshTokens,
    };
  }

  /**
   * Revoga TODAS as sessões e grants da conta. Destruir os grants já invalida os
   * tokens (cascata via `grant not found`); ainda assim, quando o adapter enumera,
   * destruímos explicitamente as linhas de AT/RT desses grants (belt-and-braces),
   * deixando o store limpo. Retorna as contagens do que foi removido.
   */
  async revokeAll(accountId: string): Promise<RevokeResult> {
    const sessionAdapter = this.#adapter('Session');
    const grantAdapter = this.#adapter('Grant');

    const sessions = await this.listSessions(accountId);
    for (const s of sessions) {
      await sessionAdapter.destroy(s.id);
    }

    const grants = await this.listGrants(accountId);
    const grantIds = new Set(grants.map((g) => g.id));
    let accessTokens = 0;
    let refreshTokens = 0;

    // Belt-and-braces: destrói as linhas de token que referenciam os grants alvo
    // ANTES de destruir os grants (quando o adapter enumera).
    accessTokens = await this.#destroyTokensOfGrants('AccessToken', grantIds);
    refreshTokens = await this.#destroyTokensOfGrants('RefreshToken', grantIds);

    for (const g of grants) {
      // `revokeByGrantId` derruba os artefatos ligados ao grant (no Redis isso
      // limpa a lista do grant; no DB apaga as linhas com `grant_id`); `destroy`
      // remove o próprio artefato `Grant`.
      await grantAdapter.revokeByGrantId(g.id);
      await grantAdapter.destroy(g.id);
    }

    // Revogação total → propaga p/ clients cookie-based via tabela compartilhada (instantâneo).
    await this.recordSubRevocation(accountId);

    return {
      sessions: sessions.length,
      grants: grants.length,
      accessTokens,
      refreshTokens,
    };
  }

  /**
   * Revoga os grants de uma conta para UM client específico (+ tokens ligados),
   * deixando os demais clients intactos. Reaproveita a lógica de {@link revokeAll}
   * restrita ao `clientId`. Usado pelo self-service de consentimento
   * (/account/apps) e por qualquer revogação granular do admin. Retorna as
   * contagens do que foi removido.
   */
  async revokeClientGrants(accountId: string, clientId: string): Promise<RevokeResult> {
    const grantAdapter = this.#adapter('Grant');
    const grants = (await this.listGrants(accountId)).filter((g) => g.clientId === clientId);
    const grantIds = new Set(grants.map((g) => g.id));

    const accessTokens = await this.#destroyTokensOfGrants('AccessToken', grantIds);
    const refreshTokens = await this.#destroyTokensOfGrants('RefreshToken', grantIds);

    for (const g of grants) {
      await grantAdapter.revokeByGrantId(g.id);
      await grantAdapter.destroy(g.id);
    }

    return { sessions: 0, grants: grants.length, accessTokens, refreshTokens };
  }

  /** Destrói (quando enumerável) os artefatos de um model token cujos grantId estão em `grantIds`. */
  async #destroyTokensOfGrants(model: string, grantIds: Set<string>): Promise<number> {
    const adapter = this.#adapter(model);
    if (!adapter.list) return 0;
    const rows = await adapter.list();
    let count = 0;
    for (const r of rows) {
      const gid = r.payload.grantId as string | undefined;
      if (gid && grantIds.has(gid)) {
        await adapter.destroy(r.id);
        count++;
      }
    }
    return count;
  }
}
