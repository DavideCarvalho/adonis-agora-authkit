/**
 * AuthKit typed client — client-side fetch wrapper.
 *
 * Cria um cliente tipado para todas as superfícies da Admin REST API e da
 * Account Self-Service API. Desacoplado do servidor: sem imports do
 * authkit-server, apenas dos tipos locais.
 *
 * Uso:
 * ```ts
 * // Account API only (default base `/account/api`):
 * const client = createAuthkitClient({ csrfToken })
 *
 * // Admin API too:
 * const client = createAuthkitClient({ baseUrl: '/admin/api', csrfToken })
 * ```
 */

import type {
  AccountExtensionActionInput,
  AccountExtensionActionResult,
  AccountExtensionPageResult,
  AccountExtensionsResult,
} from '../account_extensions/types.js';
import { listQuery } from './list_query.js';
import type {
  AcceptOrgInvitationResult,
  AccountAgentsResult,
  AccountAppsResult,
  // Account
  AccountLoginMethodsResult,
  AccountMe,
  AccountMfaStatus,
  AccountOrgDetail,
  AccountOrgInvitationsResult,
  AccountOrgsResult,
  AccountPasskeysResult,
  AccountSecurityOverview,
  AccountSessionsResult,
  AccountTokensResult,
  ActivateOrgResult,
  AdminClient,
  AdminClientListResult,
  AdminListParams,
  AdminOrgDetail,
  AdminOrgEntry,
  AdminOrgInvitation,
  AdminOrgListResult,
  // Admin
  AdminOverview,
  AdminSessionListParams,
  AdminSessionListResult,
  AdminUser,
  AdminUserListResult,
  AuditListParams,
  AuditListResult,
  ChangePasswordInput,
  CreateAccountOrgInput,
  CreateClientInput,
  CreatedAccountOrgResult,
  CreatedClientResult,
  CreatedOrgInvitationResult,
  CreatedPatResult,
  CreateOrgInput,
  CreateRoleInput,
  CreateTokenInput,
  CreateUserInput,
  DeactivateOrgResult,
  DeletedResult,
  EmailChangeResult,
  ImpersonationPanel,
  InviteOrgMemberInput,
  KeysRotateInput,
  KeysRotateResult,
  KeysStatus,
  LeaveOrgResult,
  McpClientsStatus,
  McpClientsUpdateInput,
  MfaConfirmResult,
  MfaDisableResult,
  MfaEnrollResult,
  MfaRecoveryCodesResult,
  OkResult,
  PasskeyRegistrationOptions,
  PersonalAgentConnectionsParams,
  PersonalAgentConnectionsResult,
  PersonalAgentRegistryInput,
  PersonalAgentRegistryResult,
  PersonalAgentsOverview,
  RegenerateSecretResult,
  RemoveOrgMemberResult,
  RemovePasskeyResult,
  RequestEmailChangeInput,
  ResetPasswordResult,
  RevokeAllResult,
  RevokeAppResult,
  RevokeClientResult,
  RevokeOrgInvitationResult,
  RevokeOthersResult,
  RevokeSessionResult,
  RevokeSessionsResult,
  RevokeTokenResult,
  RoleCatalogEntry,
  RoleListResult,
  SettingEntry,
  SettingListResult,
  UpdateClientInput,
  UpdateLoginMethodsResult,
  UpdateOrgInput,
  UpdateOrgMemberRoleResult,
  UpdateProfileInput,
  UpdateProfileResult,
  UpdateRoleInput,
  UpdateUserInput,
  UserLoginMethodsInput,
  UserSessionsResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Erro
// ---------------------------------------------------------------------------

/**
 * Erro lançado pelo client quando o servidor responde com status não-2xx.
 *
 * - `status`  → código HTTP
 * - `code`    → `error.code` do envelope padrão (quando disponível)
 * - `message` → mensagem legível
 * - `body`    → corpo JSON bruto (pode ser null em erros de rede/parse)
 */
export class AuthkitClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'AuthkitClientError';
    /** Indica se o status era 401 (sessão expirada / não autenticado). */
    Object.defineProperty(this, 'isUnauthorized', { value: status === 401, enumerable: true });
  }

  /** true quando status === 401 (a UI deve redirecionar para o login). */
  readonly isUnauthorized!: boolean;
}

// ---------------------------------------------------------------------------
// Tipos de opções
// ---------------------------------------------------------------------------

export interface AuthkitClientOptions {
  /**
   * URL base da Admin JSON API — sem trailing slash.
   * Required for `client.admin.*` (e.g. `/admin/api`); account-only clients can omit it.
   */
  baseUrl?: string;
  /**
   * URL base da Account Self-Service API — sem trailing slash.
   * Default: `/account/api`.
   */
  accountBaseUrl?: string;
  /** Token CSRF injetado como `X-CSRF-TOKEN` nas mutações. */
  csrfToken?: string;
  /**
   * Implementação fetch customizada (útil em testes para mockar requests).
   * Default: `globalThis.fetch`.
   */
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Constrói query string a partir de um objeto plano (ignora undefined/null). */
function toQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// Classe AuthkitClient
// ---------------------------------------------------------------------------

class AuthkitClient {
  private readonly _baseUrl: string | undefined;
  private readonly _accountBaseUrl: string;
  private readonly _csrfToken: string | undefined;
  private readonly _fetch: typeof fetch;

  constructor(opts: AuthkitClientOptions = {}) {
    // SSR-safe: o construtor NUNCA lança nem toca em window de forma fatal — o
    // tree React é montado durante o SSR sem disparar requests. A base admin é
    // resolvida preguiçosamente em `adminBase()`; se faltar (SSR sem baseUrl), só
    // lança quando uma chamada admin.* realmente acontece (client-side). Telas que
    // só usam account.* funcionam com `accountBaseUrl` (default '/account/api').
    this._baseUrl = opts.baseUrl;
    this._accountBaseUrl = opts.accountBaseUrl ?? '/account/api';
    this._csrfToken = opts.csrfToken;
    // `globalThis.fetch` PRECISA ser chamado com `this === Window`. Guardá-lo como
    // método de instância e chamar via `this._fetch(...)` perde esse binding →
    // "Failed to execute 'fetch' on 'Window': Illegal invocation". Bind explícito.
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ─── Core request ──────────────────────────────────────────────────────────

  async request<T>(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const isMutating = MUTATING.has(method.toUpperCase());
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (isMutating && this._csrfToken) {
      headers['X-CSRF-TOKEN'] = this._csrfToken;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this._fetch(url, {
      method: method.toUpperCase(),
      credentials: 'include',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let code: string | undefined;
      let parsed: unknown;
      try {
        parsed = await res.json();
        const envelope = parsed as any;
        if (envelope?.error?.message) message = envelope.error.message;
        if (envelope?.error?.code) code = envelope.error.code;
        else if (typeof envelope?.message === 'string') message = envelope.message;
      } catch {
        /* corpo não-JSON — mantém a mensagem padrão */
      }
      throw new AuthkitClientError(res.status, message, code, parsed);
    }

    // 204 / body vazio
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (null as unknown as T);
  }

  private get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const qs = params ? toQueryString(params) : '';
    return this.request<T>('GET', `${path}${qs}`);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private b(path: string) {
    if (!this._baseUrl) {
      throw new Error(
        '[AuthkitClient] admin base URL ausente: passe `baseUrl` em createAuthkitClient({ baseUrl }). ' +
          'Telas que só usam client.account.* não precisam de baseUrl.',
      );
    }
    return `${this._baseUrl}${path}`;
  }

  private a(path: string) {
    return `${this._accountBaseUrl}${path}`;
  }

  // ─── Superfície Admin ──────────────────────────────────────────────────────

  readonly admin = {
    /** GET {base}/overview */
    overview: () => this.get<AdminOverview>(this.b('/overview')),

    users: {
      /** GET {base}/users?search=&sort=email&page=&size= */
      list: (params: AdminListParams = {}) =>
        this.get<AdminUserListResult>(this.b(`/users${listQuery(params)}`)),
      /** GET {base}/users/:id */
      get: (id: string) => this.get<AdminUser>(this.b(`/users/${encodeURIComponent(id)}`)),
      /** POST {base}/users */
      create: (data: CreateUserInput) =>
        this.post<AdminUser & { invited?: boolean }>(this.b('/users'), data),
      /** PATCH {base}/users/:id */
      update: (id: string, data: UpdateUserInput) =>
        this.patch<AdminUser>(this.b(`/users/${encodeURIComponent(id)}`), data),
      /** POST {base}/users/:id/disable */
      disable: (id: string) =>
        this.post<AdminUser>(this.b(`/users/${encodeURIComponent(id)}/disable`)),
      /** POST {base}/users/:id/enable */
      enable: (id: string) =>
        this.post<AdminUser>(this.b(`/users/${encodeURIComponent(id)}/enable`)),
      /** POST {base}/users/:id/reset-password */
      resetPassword: (id: string) =>
        this.post<ResetPasswordResult>(this.b(`/users/${encodeURIComponent(id)}/reset-password`)),
      /** DELETE {base}/users/:id */
      remove: (id: string) =>
        this.delete<DeletedResult>(this.b(`/users/${encodeURIComponent(id)}`)),
      /** GET {base}/users/:id/sessions */
      getSessions: (id: string) =>
        this.get<UserSessionsResult>(this.b(`/users/${encodeURIComponent(id)}/sessions`)),
      /** POST {base}/users/:id/revoke-sessions */
      revokeSessions: (id: string) =>
        this.post<RevokeSessionsResult>(this.b(`/users/${encodeURIComponent(id)}/revoke-sessions`)),
    },

    sessions: {
      /** GET {base}/sessions?filter[accountId]=&search=&sort=&page=&size= */
      list: ({ accountId, ...params }: AdminSessionListParams = {}) =>
        this.get<AdminSessionListResult>(this.b(`/sessions${listQuery(params, { accountId })}`)),
      /** POST {base}/sessions/revoke-all */
      revokeAll: (accountId?: string) =>
        this.post<RevokeSessionsResult>(
          this.b('/sessions/revoke-all'),
          accountId ? { accountId } : undefined,
        ),
    },

    clients: {
      /** GET {base}/clients?search=&sort=&page=&size= */
      list: (params: AdminListParams = {}) =>
        this.get<AdminClientListResult>(this.b(`/clients${listQuery(params)}`)),
      /** GET {base}/clients/:id */
      get: (id: string) => this.get<AdminClient>(this.b(`/clients/${encodeURIComponent(id)}`)),
      /** POST {base}/clients */
      create: (data?: CreateClientInput) =>
        this.post<CreatedClientResult>(this.b('/clients'), data),
      /** PATCH {base}/clients/:id */
      update: (id: string, data?: UpdateClientInput) =>
        this.patch<AdminClient>(this.b(`/clients/${encodeURIComponent(id)}`), data),
      /** DELETE {base}/clients/:id */
      remove: (id: string) =>
        this.delete<DeletedResult>(this.b(`/clients/${encodeURIComponent(id)}`)),
      /** POST {base}/clients/:id/disable — no new tokens until enabled again. */
      disable: (id: string) =>
        this.post<AdminClient>(this.b(`/clients/${encodeURIComponent(id)}/disable`)),
      /** POST {base}/clients/:id/enable */
      enable: (id: string) =>
        this.post<AdminClient>(this.b(`/clients/${encodeURIComponent(id)}/enable`)),
      /** POST {base}/clients/:id/revoke — disable + cut its grants/tokens everywhere (sudo). */
      revoke: (id: string) =>
        this.post<RevokeClientResult>(this.b(`/clients/${encodeURIComponent(id)}/revoke`)),
      /** POST {base}/clients/:id/regenerate-secret */
      regenerateSecret: (id: string) =>
        this.post<RegenerateSecretResult>(
          this.b(`/clients/${encodeURIComponent(id)}/regenerate-secret`),
        ),
    },

    roles: {
      /** GET {base}/roles */
      list: () => this.get<RoleListResult>(this.b('/roles')),
      /** POST {base}/roles */
      create: (data: CreateRoleInput) => this.post<RoleCatalogEntry>(this.b('/roles'), data),
      /** PATCH {base}/roles/:name */
      update: (name: string, data: UpdateRoleInput) =>
        this.patch<RoleCatalogEntry>(this.b(`/roles/${encodeURIComponent(name)}`), data),
      /** DELETE {base}/roles/:name */
      remove: (name: string) =>
        this.delete<{ ok: boolean; deleted: string }>(this.b(`/roles/${encodeURIComponent(name)}`)),
    },

    orgs: {
      /** GET {base}/orgs?search=&sort=&page=&size= */
      list: (params: AdminListParams = {}) =>
        this.get<AdminOrgListResult>(this.b(`/orgs${listQuery(params)}`)),
      /** POST {base}/orgs */
      create: (data: CreateOrgInput) => this.post<AdminOrgEntry>(this.b('/orgs'), data),
      /** GET {base}/orgs/:id */
      get: (id: string) => this.get<AdminOrgDetail>(this.b(`/orgs/${encodeURIComponent(id)}`)),
      /** PATCH {base}/orgs/:id */
      update: (id: string, data: UpdateOrgInput) =>
        this.patch<AdminOrgEntry>(this.b(`/orgs/${encodeURIComponent(id)}`), data),
      /** DELETE {base}/orgs/:id */
      remove: (id: string) =>
        this.delete<{ id: string; deleted: boolean }>(this.b(`/orgs/${encodeURIComponent(id)}`)),
      /** POST {base}/orgs/:id/members */
      addMember: (orgId: string, data: { accountId: string; role: string }) =>
        this.post<{ ok: boolean }>(this.b(`/orgs/${encodeURIComponent(orgId)}/members`), data),
      /** DELETE {base}/orgs/:id/members/:accountId */
      removeMember: (orgId: string, accountId: string) =>
        this.delete<{ ok: boolean }>(
          this.b(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`),
        ),
      /** PATCH {base}/orgs/:id/members/:accountId */
      updateMemberRole: (orgId: string, accountId: string, role: string) =>
        this.patch<{ ok: boolean }>(
          this.b(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`),
          { role },
        ),
      /** POST {base}/orgs/:id/invitations */
      createInvitation: (orgId: string, data: { email: string; role: string }) =>
        this.post<{ ok: boolean; invitation: AdminOrgInvitation }>(
          this.b(`/orgs/${encodeURIComponent(orgId)}/invitations`),
          data,
        ),
      /** DELETE {base}/orgs/:id/invitations/:invitationId */
      revokeInvitation: (orgId: string, invitationId: string) =>
        this.delete<{ ok: boolean }>(
          this.b(
            `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
          ),
        ),
    },

    audit: {
      /** GET {base}/audit?filter[type]=&filter[subject]=&after=&before=&first=&last= — newest first. */
      list: ({ type, subject, ...params }: AuditListParams = {}) =>
        this.get<AuditListResult>(this.b(`/audit${listQuery(params, { type, subject })}`)),
    },

    settings: {
      /**
       * GET {base}/settings
       * @param orgId - quando fornecido, lista settings da org; omitido = global
       */
      list: (orgId?: string | null) => {
        const qs = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
        return this.get<SettingListResult>(this.b(`/settings${qs}`));
      },
      /**
       * PUT {base}/settings/:key
       * @param orgId - quando fornecido, grava no escopo da org; omitido = global
       */
      set: (key: string, value: unknown, orgId?: string | null) => {
        const qs = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
        return this.put<SettingEntry>(this.b(`/settings/${encodeURIComponent(key)}${qs}`), {
          value,
        });
      },
      /**
       * DELETE {base}/settings/:key
       * @param orgId - quando fornecido, remove no escopo da org; omitido = global
       */
      remove: (key: string, orgId?: string | null) => {
        const qs = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
        return this.delete<{ key: string; organizationId: string | null; deleted: boolean }>(
          this.b(`/settings/${encodeURIComponent(key)}${qs}`),
        );
      },
    },

    impersonation: {
      /** GET {base}/impersonation/:userId */
      get: (userId: string) =>
        this.get<ImpersonationPanel>(this.b(`/impersonation/${encodeURIComponent(userId)}`)),
    },

    /** Rotação de chave de assinatura JWKS (console API, session-authed). */
    keys: {
      /** GET {base}/keys — idade, política e ETA da próxima rotação. */
      status: () => this.get<KeysStatus>(this.b('/keys')),
      /** POST {base}/keys/rotate — rotaciona agora (opcionalmente aposenta as antigas). */
      rotate: (input?: KeysRotateInput) =>
        this.post<KeysRotateResult>(this.b('/keys/rotate'), input ?? {}),
    },

    /** MCP client login (automatic): live state and the `mcp_clients` switch (console API). */
    mcpClients: {
      /** GET {base}/mcp-clients */
      status: () => this.get<McpClientsStatus>(this.b('/mcp-clients')),
      /** PUT {base}/mcp-clients — needs sudo; 423 when `mcpClients: false` is in config. */
      update: (input: McpClientsUpdateInput) =>
        this.put<McpClientsStatus>(this.b('/mcp-clients'), input),
    },

    /** Personal agents (PACT e `personalAgents.extensions`): conexões, liberar e bloquear (console API). */
    personalAgents: {
      /** GET {base}/personal-agents */
      overview: () => this.get<PersonalAgentsOverview>(this.b('/personal-agents')),
      /** GET {base}/personal-agents/connections */
      connections: ({
        protocol,
        clientId,
        accountId,
        ...params
      }: PersonalAgentConnectionsParams = {}) =>
        this.get<PersonalAgentConnectionsResult>(
          this.b(
            `/personal-agents/connections${listQuery(params, { protocol, clientId, accountId })}`,
          ),
        ),
      /** POST {base}/personal-agents/connections/:grantId/revoke — exige sudo. */
      revokeConnection: (grantId: string) =>
        this.post<{ revoked: true }>(
          this.b(`/personal-agents/connections/${encodeURIComponent(grantId)}/revoke`),
          {},
        ),
      /** POST {base}/personal-agents/registry — libera/bloqueia; exige sudo. */
      setStatus: (input: PersonalAgentRegistryInput) =>
        this.post<PersonalAgentRegistryResult>(this.b('/personal-agents/registry'), input),
      /** DELETE {base}/personal-agents/registry/:id — exige sudo. */
      removeEntry: (id: string) =>
        this.delete<{ removed: true }>(
          this.b(`/personal-agents/registry/${encodeURIComponent(id)}`),
        ),
    },
  } as const;

  // ─── Superfície Account ────────────────────────────────────────────────────

  readonly account = {
    /** GET /account/api/me */
    me: () => this.get<AccountMe>(this.a('/me')),
    /** GET /account/api/security */
    security: () => this.get<AccountSecurityOverview>(this.a('/security')),

    /** PATCH /account/api/profile */
    updateProfile: (data: UpdateProfileInput) =>
      this.patch<UpdateProfileResult>(this.a('/profile'), data),

    /** POST /account/api/password */
    changePassword: (data: ChangePasswordInput) => this.post<OkResult>(this.a('/password'), data),

    /** POST /account/api/email-change */
    emailChange: (data: RequestEmailChangeInput) =>
      this.post<EmailChangeResult>(this.a('/email-change'), data),

    /** POST /account/api/email-change/cancel */
    cancelEmailChange: () => this.post<OkResult>(this.a('/email-change/cancel')),

    sessions: {
      /** GET /account/api/sessions */
      list: () => this.get<AccountSessionsResult>(this.a('/sessions')),
      /** DELETE /account/api/sessions/:id */
      revoke: (id: string) =>
        this.delete<RevokeSessionResult>(this.a(`/sessions/${encodeURIComponent(id)}`)),
      /** POST /account/api/sessions/revoke-others */
      revokeOthers: () => this.post<RevokeOthersResult>(this.a('/sessions/revoke-others')),
      /** POST /account/api/sessions/revoke-all — revoga TODAS as sessões + logout global */
      revokeAll: () => this.post<RevokeAllResult>(this.a('/sessions/revoke-all')),
    },

    apps: {
      /** GET /account/api/apps */
      list: () => this.get<AccountAppsResult>(this.a('/apps')),
      /** DELETE /account/api/apps/:clientId */
      revoke: (clientId: string) =>
        this.delete<RevokeAppResult>(this.a(`/apps/${encodeURIComponent(clientId)}`)),
    },

    /** Personal agents with a delegation on the account (404 when the feature is off). */
    agents: {
      /** GET /account/api/agents */
      list: () => this.get<AccountAgentsResult>(this.a('/agents')),
      /** DELETE /account/api/agents/:id — revokes the delegation now. */
      revoke: (grantId: string) =>
        this.delete<{ ok: true }>(this.a(`/agents/${encodeURIComponent(grantId)}`)),
    },

    /**
     * Segundo fator. `mfa()` continua sendo a LEITURA do status
     * (`GET /account/api/mfa`) — assinatura preservada, ninguém quebra — e as
     * escritas penduram nela como propriedades: `mfa.enroll()`,
     * `mfa.confirm()`, `mfa.disable()`, `mfa.regenerateRecoveryCodes()` e
     * `mfa.passkeys.*`.
     *
     * Função COM propriedades, e não um objeto com `.status()`, porque
     * `client.account.mfa()` já está publicado: trocar a forma quebraria todo
     * consumidor da 0.69 para ganhar só simetria.
     *
     * As escritas exigem SUDO (menos `confirm`, que é o passo seguinte do
     * `enroll`): sem confirmação de identidade recente o servidor responde
     * `403 sudo_required`, e a tela do host deve mandar o usuário reconfirmar.
     */
    mfa: Object.assign(() => this.get<AccountMfaStatus>(this.a('/mfa')), {
      /** POST /account/api/mfa/totp/enroll — segredo + otpauth URI + QR. Exige sudo. */
      enroll: () => this.post<MfaEnrollResult>(this.a('/mfa/totp/enroll')),
      /**
       * POST /account/api/mfa/totp/confirm — liga o MFA e devolve os recovery
       * codes uma única vez. Sem sudo (o `enroll` já exigiu), mas com throttle.
       */
      confirm: (code: string) => this.post<MfaConfirmResult>(this.a('/mfa/totp/confirm'), { code }),
      /** POST /account/api/mfa/totp/disable — desliga o MFA. Exige sudo. */
      disable: () => this.post<MfaDisableResult>(this.a('/mfa/totp/disable')),
      /**
       * POST /account/api/mfa/recovery-codes — troca o conjunto inteiro; os
       * antigos (inclusive os não usados) deixam de valer. Exige sudo.
       */
      regenerateRecoveryCodes: () =>
        this.post<MfaRecoveryCodesResult>(this.a('/mfa/recovery-codes')),
      /** Cerimônia de REGISTRO de passkey em JSON (a clássica responde 302). */
      passkeys: {
        /** POST /account/api/mfa/passkeys/options — options para `startRegistration()`. */
        options: () => this.post<PasskeyRegistrationOptions>(this.a('/mfa/passkeys/options')),
        /** POST /account/api/mfa/passkeys/verify — persiste a credencial. Exige sudo. */
        verify: (response: unknown) =>
          this.post<OkResult>(this.a('/mfa/passkeys/verify'), { response }),
      },
    }),

    loginMethods: {
      /** GET /account/api/login-methods */
      get: () => this.get<AccountLoginMethodsResult>(this.a('/login-methods')),
      /** PUT /account/api/login-methods */
      update: (data: { methods: UserLoginMethodsInput }) =>
        this.put<UpdateLoginMethodsResult>(this.a('/login-methods'), data),
    },

    passkeys: {
      /** GET /account/api/passkeys */
      list: () => this.get<AccountPasskeysResult>(this.a('/passkeys')),
      /** DELETE /account/api/passkeys/:id */
      remove: (id: string) =>
        this.delete<RemovePasskeyResult>(this.a(`/passkeys/${encodeURIComponent(id)}`)),
    },

    tokens: {
      /** GET /account/api/tokens */
      list: () => this.get<AccountTokensResult>(this.a('/tokens')),
      /** POST /account/api/tokens */
      create: (data?: CreateTokenInput) => this.post<CreatedPatResult>(this.a('/tokens'), data),
      /** DELETE /account/api/tokens/:id */
      remove: (id: string) =>
        this.delete<RevokeTokenResult>(this.a(`/tokens/${encodeURIComponent(id)}`)),
    },

    /**
     * Organizações do ponto de vista do MEMBRO (não do admin). As escritas são
     * o espelho JSON dos formulários de `/account/orgs`: mesmos guards, mesma
     * política efetiva, mesmos erros — só a resposta muda de redirect para JSON.
     */
    orgs: {
      /** GET /account/api/orgs */
      list: () => this.get<AccountOrgsResult>(this.a('/orgs')),
      /** GET /account/api/orgs/invitations */
      invitations: () => this.get<AccountOrgInvitationsResult>(this.a('/orgs/invitations')),
      /** GET /account/api/orgs/:id */
      get: (id: string) => this.get<AccountOrgDetail>(this.a(`/orgs/${encodeURIComponent(id)}`)),

      /**
       * POST /account/api/orgs — cria uma org (quem cria vira `owner`).
       * `403 self_create_disabled` quando `allowSelfCreate` está desligado na
       * política efetiva; `409 slug_taken` quando o slug já existe.
       */
      create: (data: CreateAccountOrgInput) =>
        this.post<CreatedAccountOrgResult>(this.a('/orgs'), data),
      /** POST /account/api/orgs/:id/activate — define a org ativa (cookie). */
      activate: (id: string) =>
        this.post<ActivateOrgResult>(this.a(`/orgs/${encodeURIComponent(id)}/activate`)),
      /** POST /account/api/orgs/deactivate — limpa a org ativa. */
      deactivate: () => this.post<DeactivateOrgResult>(this.a('/orgs/deactivate')),
      /** POST /account/api/orgs/:id/leave — sai da org (`409 last_owner` recusa o último owner). */
      leave: (id: string) =>
        this.post<LeaveOrgResult>(this.a(`/orgs/${encodeURIComponent(id)}/leave`)),
      /** POST /account/api/orgs/:id/invitations — convida por e-mail. Exige owner/admin. */
      invite: (orgId: string, data: InviteOrgMemberInput) =>
        this.post<CreatedOrgInvitationResult>(
          this.a(`/orgs/${encodeURIComponent(orgId)}/invitations`),
          data,
        ),
      /** DELETE /account/api/orgs/:id/invitations/:invitationId — revoga um convite pendente. */
      revokeInvitation: (orgId: string, invitationId: string) =>
        this.delete<RevokeOrgInvitationResult>(
          this.a(
            `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
          ),
        ),
      /** PATCH /account/api/orgs/:id/members/:accountId — troca o papel de um membro. */
      updateMemberRole: (orgId: string, accountId: string, role: string) =>
        this.patch<UpdateOrgMemberRoleResult>(
          this.a(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`),
          { role },
        ),
      /** DELETE /account/api/orgs/:id/members/:accountId — remove um membro. */
      removeMember: (orgId: string, accountId: string) =>
        this.delete<RemoveOrgMemberResult>(
          this.a(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`),
        ),
      /**
       * POST /account/api/orgs/invitations/:token/accept — aceita um convite.
       * `410 expired` para convite vencido, `403 email_mismatch` quando o
       * convite é de outro e-mail.
       */
      acceptInvitation: (token: string) =>
        this.post<AcceptOrgInvitationResult>(
          this.a(`/orgs/invitations/${encodeURIComponent(token)}/accept`),
        ),
    },

    /** Pages other packages added to the account console. */
    extensions: {
      /** GET /account/api/extensions — the localized navigation. */
      list: () => this.get<AccountExtensionsResult>(this.a('/extensions')),
      /** GET /account/api/x/:pageId — one page, resolved. */
      page: (pageId: string, query?: { cursor?: string; tab?: string }) =>
        this.get<AccountExtensionPageResult>(
          this.a(`/x/${encodeURIComponent(pageId)}`),
          query as Record<string, unknown> | undefined,
        ),
      /**
       * POST /account/api/x/:pageId/actions/:action. `403 sudo_required` (with
       * `confirmUrl`) when the action needs a recent sign-in.
       */
      action: (pageId: string, action: string, input: AccountExtensionActionInput = {}) =>
        this.post<AccountExtensionActionResult>(
          this.a(`/x/${encodeURIComponent(pageId)}/actions/${encodeURIComponent(action)}`),
          input,
        ),
    },
  } as const;
}

// ---------------------------------------------------------------------------
// Factory pública
// ---------------------------------------------------------------------------

/**
 * Cria um cliente tipado para as APIs do AuthKit.
 *
 * Pass the admin API base (`baseUrl`) when you use `client.admin.*`, and the
 * request's CSRF token for mutations.
 *
 * @example
 * ```ts
 * const client = createAuthkitClient({
 *   baseUrl: '/admin/api',
 *   accountBaseUrl: '/account/api',
 *   csrfToken: 'test-token',
 *   fetch: mockFetch,
 * })
 * ```
 */
export function createAuthkitClient(opts?: AuthkitClientOptions): AuthkitClient {
  return new AuthkitClient(opts);
}

export type { AuthkitClient };
