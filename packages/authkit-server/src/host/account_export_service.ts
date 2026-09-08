import {
  supportsOrganizations,
  supportsPasskeys,
  supportsProviderIdentity,
} from '../accounts/account_store.js';
import type { ResolvedServerConfig } from '../define_config.js';
import { LIST_FIRST_PAGE } from '../pagination.js';
import type { OidcService } from '../provider/oidc_service.js';
import { AdminSessionsService } from './admin_sessions_service.js';

/** Payload de export de dados de uma conta (portabilidade — LGPD/GDPR). */
export interface AccountExport {
  /** Versão do formato do export (para evolução futura). */
  exportVersion: number;
  /** Instante do export (ISO 8601). */
  exportedAt: string;
  /** Perfil (sem hash de senha nem segredos). */
  profile: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    globalRoles: string[];
  };
  /** Identidades de provider linkadas (SEM tokens). */
  linkedIdentities: Array<{
    provider: string;
    providerUserId: string;
    email: string | null;
  }>;
  /** Apps autorizados (grants), com contagens de tokens vivos — sem material de token. */
  authorizedApps: Array<{
    clientId: string | null;
    accessTokens: number;
    refreshTokens: number;
  }>;
  /** Metadados das sessões ativas (sem material de sessão/cookie). */
  sessions: Array<{ id: string; loginTs: number | null; amr: string[] }>;
  /** Metadados das passkeys (sem chave pública nem counter). */
  passkeys: Array<{ id: string; label: string | null; createdAt: string }>;
  /** Eventos de auditoria do próprio usuário (já anonimizados de IP de terceiros? não — são seus). */
  auditLog: Array<{
    type: string;
    clientId: string | null;
    ip: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string | null;
  }>;
  /** Memberships em organizations (multi-tenancy). */
  organizations?: Array<{
    orgId: string;
    name: string;
    slug: string;
    role: string;
  }>;
}

/** Limite de eventos de audit incluídos no export (evita payloads gigantes). */
const AUDIT_EXPORT_SIZE = 1000;

/**
 * Monta o pacote de dados de uma conta para portabilidade (LGPD/GDPR). NUNCA
 * inclui segredos: hash de senha, segredo TOTP, recovery codes, chave pública de
 * passkey, material de sessão/token ou tokens de provider. Tudo que é incluído é
 * metadado ou dado de perfil que o próprio usuário forneceu.
 */
export class AccountExportService {
  #cfg: ResolvedServerConfig;
  #oidc: OidcService;

  constructor(oidc: OidcService) {
    this.#oidc = oidc;
    this.#cfg = oidc.config;
  }

  /**
   * Gera o export, ou null se a conta não existe. Caminho SÍNCRONO de sempre —
   * apenas delega para {@link collect} (a coleta inline, byte-idêntica ao original).
   */
  async export(accountId: string): Promise<AccountExport | null> {
    return this.collect(accountId);
  }

  /**
   * Coleta + monta o payload de export (a lógica de sempre). Exposta como uma
   * operação discreta para o workflow durável (`authkit.account.export`) reusar
   * como um `ctx.step` — read-only, sem efeitos colaterais destrutivos.
   */
  async collect(accountId: string): Promise<AccountExport | null> {
    const cfg = this.#cfg;
    const store = cfg.accountStore;

    const account = await store.findById(accountId);
    if (!account) return null;

    // Identidades de provider (capability-probed; sem tokens).
    let linkedIdentities: AccountExport['linkedIdentities'] = [];
    if (supportsProviderIdentity(store)) {
      try {
        linkedIdentities = (await store.listProviderIdentities(accountId)).map((i) => ({
          provider: i.provider,
          providerUserId: i.providerUserId,
          email: i.email ?? null,
        }));
      } catch {
        /* best-effort */
      }
    }

    // Sessões + grants (apps autorizados) — só metadados, sem tokens.
    let sessions: AccountExport['sessions'] = [];
    let authorizedApps: AccountExport['authorizedApps'] = [];
    try {
      const admin = new AdminSessionsService(this.#oidc);
      sessions = (await admin.listSessions(accountId)).map((s) => ({
        id: s.id,
        loginTs: s.loginTs ?? null,
        amr: s.amr ?? [],
      }));
      authorizedApps = (await admin.listGrants(accountId)).map((g) => ({
        clientId: g.clientId ?? null,
        accessTokens: g.accessTokens,
        refreshTokens: g.refreshTokens,
      }));
    } catch {
      /* best-effort (adapter sem list) */
    }

    // Passkeys — só metadados (id/label/createdAt), nunca a chave pública.
    let passkeys: AccountExport['passkeys'] = [];
    if (supportsPasskeys(store)) {
      try {
        passkeys = (await store.listPasskeys(accountId)).map((p) => ({
          id: p.id,
          label: p.label ?? null,
          createdAt: p.createdAt,
        }));
      } catch {
        /* best-effort */
      }
    }

    // Organizations (capability-probed).
    let organizations: AccountExport['organizations'] = [];
    if (supportsOrganizations(store)) {
      try {
        const orgs = await store.listOrgsForAccount(accountId);
        organizations = orgs.map((o) => ({
          orgId: o.id,
          name: o.name,
          slug: o.slug,
          role: o.role,
        }));
      } catch {
        /* best-effort */
      }
    }

    // Audit do próprio usuário (quando o sink suporta consulta).
    let auditLog: AccountExport['auditLog'] = [];
    if (cfg.audit && typeof cfg.audit.list === 'function') {
      try {
        const page = await cfg.audit.list({
          subject: accountId,
          page: LIST_FIRST_PAGE,
          size: AUDIT_EXPORT_SIZE,
        });
        auditLog = page.data.map((e) => ({
          type: e.type,
          clientId: e.clientId ?? null,
          ip: e.ip ?? null,
          metadata: e.metadata ?? null,
          createdAt:
            typeof e.createdAt === 'string' ? e.createdAt : (e.createdAt?.toISOString?.() ?? null),
        }));
      } catch {
        /* best-effort */
      }
    }

    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      profile: {
        id: account.id,
        email: account.email,
        name: account.name ?? null,
        avatarUrl: account.avatarUrl ?? null,
        globalRoles: account.globalRoles ?? [],
      },
      linkedIdentities,
      authorizedApps,
      sessions,
      passkeys,
      auditLog,
      organizations,
    };
  }
}
