/**
 * Query keys estruturadas para todas as queries do AuthKit.
 *
 * Exportadas para que consumidores possam invalidar queries por prefixo:
 * ```ts
 * // Invalida todos os dados de admin users:
 * queryClient.invalidateQueries({ queryKey: authkitKeys.admin.users() })
 *
 * // Invalida apenas um usuário específico:
 * queryClient.invalidateQueries({ queryKey: authkitKeys.admin.user('123') })
 * ```
 */
export const authkitKeys = {
  admin: {
    all: ['authkit', 'admin'] as const,

    overview: () => ['authkit', 'admin', 'overview'] as const,

    users: (params?: { search?: string; page?: number; limit?: number }) =>
      ['authkit', 'admin', 'users', params ?? {}] as const,
    user: (id: string) => ['authkit', 'admin', 'users', id] as const,
    userSessions: (id: string) => ['authkit', 'admin', 'users', id, 'sessions'] as const,

    sessions: (accountId?: string) => ['authkit', 'admin', 'sessions', accountId ?? null] as const,

    clients: () => ['authkit', 'admin', 'clients'] as const,
    client: (id: string) => ['authkit', 'admin', 'clients', id] as const,

    roles: () => ['authkit', 'admin', 'roles'] as const,

    orgs: () => ['authkit', 'admin', 'orgs'] as const,
    org: (id: string) => ['authkit', 'admin', 'orgs', id] as const,

    audit: (params?: { type?: string; page?: number; limit?: number; subject?: string }) =>
      ['authkit', 'admin', 'audit', params ?? {}] as const,

    /**
     * Query key de settings. orgId undefined/null = global.
     * Passar orgId para invalidar apenas settings de uma org específica.
     */
    settings: (orgId?: string | null) =>
      orgId
        ? (['authkit', 'admin', 'settings', orgId] as const)
        : (['authkit', 'admin', 'settings'] as const),

    impersonation: (userId: string) => ['authkit', 'admin', 'impersonation', userId] as const,

    keys: () => ['authkit', 'admin', 'keys'] as const,
  },

  account: {
    all: ['authkit', 'account'] as const,

    me: () => ['authkit', 'account', 'me'] as const,
    security: () => ['authkit', 'account', 'security'] as const,
    sessions: () => ['authkit', 'account', 'sessions'] as const,
    apps: () => ['authkit', 'account', 'apps'] as const,
    mfa: () => ['authkit', 'account', 'mfa'] as const,
    passkeys: () => ['authkit', 'account', 'passkeys'] as const,
    tokens: () => ['authkit', 'account', 'tokens'] as const,
    orgs: () => ['authkit', 'account', 'orgs'] as const,
    org: (id: string) => ['authkit', 'account', 'orgs', id] as const,
    orgInvitations: () => ['authkit', 'account', 'orgs', 'invitations'] as const,
    loginMethods: () => ['authkit', 'account', 'login-methods'] as const,
  },
} as const;
