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

    users: (params?: { search?: string; page?: number; size?: number }) =>
      ['authkit', 'admin', 'users', params ?? {}] as const,
    user: (id: string) => ['authkit', 'admin', 'users', id] as const,
    userSessions: (id: string) => ['authkit', 'admin', 'users', id, 'sessions'] as const,

    sessions: (accountId?: string) => ['authkit', 'admin', 'sessions', accountId ?? null] as const,

    clients: () => ['authkit', 'admin', 'clients'] as const,
    client: (id: string) => ['authkit', 'admin', 'clients', id] as const,

    roles: () => ['authkit', 'admin', 'roles'] as const,

    orgs: () => ['authkit', 'admin', 'orgs'] as const,
    org: (id: string) => ['authkit', 'admin', 'orgs', id] as const,

    audit: (params?: { type?: string; page?: number; size?: number; subject?: string }) =>
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

    /**
     * Chaves de MUTATION da superfície de ESCRITA headless (orgs + segundo
     * fator) — o espelho JSON de `/account/api/*` que um host com telas
     * próprias consome.
     *
     * Ficam aqui, e não inline no hook, por dois motivos práticos:
     *
     *   - `useIsMutating({ mutationKey: authkitKeys.account.mutations.orgs() })`
     *     desabilita a tela inteira de organizações enquanto QUALQUER escrita
     *     de org está no ar, sem o host reescrever o prefixo à mão;
     *   - são quinze chaves que precisam ser distintas entre si; um prefixo
     *     repetido por engano faz duas mutações compartilharem estado, e o bug
     *     aparece só sob concorrência.
     *
     * Os hooks mais antigos ainda declaram a `mutationKey` inline. Não foram
     * migrados aqui de propósito: a chave é contrato público de quem já usa
     * `useIsMutating`/`useMutationState`, e trocá-la seria breaking change sem
     * relação com esta mudança.
     */
    mutations: {
      orgs: () => ['authkit', 'account', 'orgs', 'mutation'] as const,
      orgCreate: () => ['authkit', 'account', 'orgs', 'mutation', 'create'] as const,
      orgActivate: () => ['authkit', 'account', 'orgs', 'mutation', 'activate'] as const,
      orgDeactivate: () => ['authkit', 'account', 'orgs', 'mutation', 'deactivate'] as const,
      orgLeave: () => ['authkit', 'account', 'orgs', 'mutation', 'leave'] as const,
      orgInvite: () => ['authkit', 'account', 'orgs', 'mutation', 'invite'] as const,
      orgRevokeInvitation: () =>
        ['authkit', 'account', 'orgs', 'mutation', 'revoke-invitation'] as const,
      orgAcceptInvitation: () =>
        ['authkit', 'account', 'orgs', 'mutation', 'accept-invitation'] as const,
      orgUpdateMemberRole: () =>
        ['authkit', 'account', 'orgs', 'mutation', 'update-member-role'] as const,
      orgRemoveMember: () => ['authkit', 'account', 'orgs', 'mutation', 'remove-member'] as const,

      mfa: () => ['authkit', 'account', 'mfa', 'mutation'] as const,
      mfaEnroll: () => ['authkit', 'account', 'mfa', 'mutation', 'totp-enroll'] as const,
      mfaConfirm: () => ['authkit', 'account', 'mfa', 'mutation', 'totp-confirm'] as const,
      mfaDisable: () => ['authkit', 'account', 'mfa', 'mutation', 'totp-disable'] as const,
      mfaRecoveryCodes: () => ['authkit', 'account', 'mfa', 'mutation', 'recovery-codes'] as const,
      passkeyRegister: () => ['authkit', 'account', 'mfa', 'mutation', 'passkey-register'] as const,
    },
  },
} as const;
