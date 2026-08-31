/**
 * AuthKit typed client — client-side fetch wrapper.
 *
 * Cria um cliente tipado para todas as superfícies da Admin REST API e da
 * Account Self-Service API. Desacoplado do servidor: sem imports do
 * authkit-server, apenas dos tipos locais.
 *
 * Uso:
 * ```ts
 * // Lê window.__AUTHKIT__ automaticamente (SSR-safe com opts):
 * const client = createAuthkitClient()
 *
 * // Override explícito (útil em testes ou topologias custom):
 * const client = createAuthkitClient({ baseUrl: '/admin/api', csrfToken: 'x' })
 * ```
 */

import type {
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
  AdminClient,
  AdminClientListResult,
  AdminOrgDetail,
  AdminOrgEntry,
  AdminOrgInvitation,
  AdminOrgListResult,
  // Admin
  AdminOverview,
  AdminUser,
  AdminUserListResult,
  AuditListParams,
  AuditListResult,
  ChangePasswordInput,
  CreateClientInput,
  CreatedClientResult,
  CreatedPatResult,
  CreateOrgInput,
  CreateRoleInput,
  CreateTokenInput,
  CreateUserInput,
  EmailChangeResult,
  ImpersonationPanel,
  KeysRotateInput,
  KeysRotateResult,
  KeysStatus,
  OkResult,
  RegenerateSecretResult,
  RemovePasskeyResult,
  RequestEmailChangeInput,
  RevokeAllResult,
  RevokeAppResult,
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
   * Default: `${window.__AUTHKIT__.endpoints.api}` (= `${adminBase}/api`).
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

// Declaração do global injetado pelo shell admin React.
declare const __AUTHKIT__: {
  adminBase: string;
  csrfToken?: string;
  locale?: string;
  messages?: Record<string, string>;
  currentUser?: unknown;
  endpoints: { api: string };
};

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function resolveWindow(): typeof __AUTHKIT__ | null {
  try {
    // SSR-safe: `window` pode não existir em Node.js
    if (typeof window === 'undefined') return null;
    return (window as any).__AUTHKIT__ ?? null;
  } catch {
    return null;
  }
}

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
    const win = resolveWindow();

    // SSR-safe: o construtor NUNCA lança nem toca em window de forma fatal — o
    // tree React é montado durante o SSR sem disparar requests. A base admin é
    // resolvida preguiçosamente em `adminBase()`; se faltar (SSR sem baseUrl), só
    // lança quando uma chamada admin.* realmente acontece (client-side). Telas que
    // só usam account.* funcionam com `accountBaseUrl` (default '/account/api').
    this._baseUrl = opts.baseUrl ?? win?.endpoints.api;
    this._accountBaseUrl = opts.accountBaseUrl ?? '/account/api';
    this._csrfToken = opts.csrfToken ?? win?.csrfToken;
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
        '[AuthkitClient] admin base URL ausente: passe `baseUrl` em createAuthkitClient({ baseUrl }) ' +
          'ou use o client onde window.__AUTHKIT__ está injetado (console admin). ' +
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
      /** GET {base}/users?search&page&limit */
      list: (params?: { search?: string; page?: number; limit?: number }) =>
        this.get<AdminUserListResult>(this.b('/users'), params),
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
        this.post<{ id: string; disabled: true }>(
          this.b(`/users/${encodeURIComponent(id)}/disable`),
        ),
      /** POST {base}/users/:id/enable */
      enable: (id: string) =>
        this.post<{ id: string; disabled: false }>(
          this.b(`/users/${encodeURIComponent(id)}/enable`),
        ),
      /** POST {base}/users/:id/reset-password */
      resetPassword: (id: string) =>
        this.post<{ id: string; sent: boolean }>(
          this.b(`/users/${encodeURIComponent(id)}/reset-password`),
        ),
      /** DELETE {base}/users/:id */
      remove: (id: string) =>
        this.delete<{ id: string; deleted: boolean }>(this.b(`/users/${encodeURIComponent(id)}`)),
      /** GET {base}/users/:id/sessions */
      getSessions: (id: string) =>
        this.get<UserSessionsResult>(this.b(`/users/${encodeURIComponent(id)}/sessions`)),
      /** POST {base}/users/:id/revoke-sessions */
      revokeSessions: (id: string) =>
        this.post<RevokeSessionsResult>(this.b(`/users/${encodeURIComponent(id)}/revoke-sessions`)),
    },

    sessions: {
      /** GET {base}/sessions?accountId */
      list: (accountId?: string) =>
        this.get<UserSessionsResult>(this.b('/sessions'), accountId ? { accountId } : undefined),
      /** POST {base}/sessions/revoke-all */
      revokeAll: (accountId?: string) =>
        this.post<RevokeSessionsResult>(
          this.b('/sessions/revoke-all'),
          accountId ? { accountId } : undefined,
        ),
    },

    clients: {
      /** GET {base}/clients */
      list: () => this.get<AdminClientListResult>(this.b('/clients')),
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
        this.delete<{ clientId: string; deleted: boolean }>(
          this.b(`/clients/${encodeURIComponent(id)}`),
        ),
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
      /** GET {base}/orgs */
      list: () => this.get<AdminOrgListResult>(this.b('/orgs')),
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
      /** GET {base}/audit?type&page&limit&subject */
      list: (params?: AuditListParams) =>
        this.get<AuditListResult>(this.b('/audit'), params as Record<string, unknown> | undefined),
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

    /** GET /account/api/mfa */
    mfa: () => this.get<AccountMfaStatus>(this.a('/mfa')),

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

    orgs: {
      /** GET /account/api/orgs */
      list: () => this.get<AccountOrgsResult>(this.a('/orgs')),
      /** GET /account/api/orgs/invitations */
      invitations: () => this.get<AccountOrgInvitationsResult>(this.a('/orgs/invitations')),
      /** GET /account/api/orgs/:id */
      get: (id: string) => this.get<AccountOrgDetail>(this.a(`/orgs/${encodeURIComponent(id)}`)),
    },
  } as const;
}

// ---------------------------------------------------------------------------
// Factory pública
// ---------------------------------------------------------------------------

/**
 * Cria um cliente tipado para as APIs do AuthKit.
 *
 * Em contextos browser sem opções, lê `window.__AUTHKIT__` para descobrir as
 * URLs base e o token CSRF. Em SSR ou testes, passe as opções explicitamente.
 *
 * @example
 * ```ts
 * // Browser (Shell admin injeta window.__AUTHKIT__)
 * const client = createAuthkitClient()
 *
 * // Testes / SSR
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
