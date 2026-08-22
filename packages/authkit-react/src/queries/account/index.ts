/**
 * Hooks TanStack Query para a Account Self-Service API.
 *
 * Reescreve os hooks legados (useProfile, useSessions, useAuthorizedApps,
 * useOrganizations, useOrganization, useOrgInvitations) como wrappers sobre
 * o `AuthkitClient`. O shape agora é o standard do TanStack Query:
 *   `{ data, isLoading, isError, error, refetch, ... }`
 * em vez do anterior `{ data, loading, error, actions }`.
 *
 * Estilo consistente com os hooks de admin: retornam options para que o
 * consumidor passe para `useQuery` / `useMutation`.
 */

import type { UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';
import { AuthkitClientError } from '../../client/client.js';
import { useAuthkitClient } from '../../client/context.js';
import type {
  AccountAppsResult,
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
  ChangePasswordInput,
  CreateTokenInput,
  CreatedPatResult,
  EmailChangeResult,
  OkResult,
  RemovePasskeyResult,
  RequestEmailChangeInput,
  RevokeAllResult,
  RevokeAppResult,
  RevokeOthersResult,
  RevokeSessionResult,
  RevokeTokenResult,
  UpdateLoginMethodsResult,
  UpdateProfileInput,
  UpdateProfileResult,
  UserLoginMethodsInput,
} from '../../client/types.js';
import { authkitKeys } from '../keys.js';

// ---------------------------------------------------------------------------
// Me / Security – Queries
// ---------------------------------------------------------------------------

/**
 * Query do perfil + flags do usuário logado.
 *
 * Substitui o antigo `useProfile()` com shape TanStack Query.
 * Antes: `{ data: AuthUser|null, loading, error, actions: { update } }`
 * Agora: `{ data: AccountMe|undefined, isLoading, isError, error, refetch }`
 * (mutação separada via `useUpdateProfileMutationOptions`)
 */
export function useMeQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.me(),
    queryFn: () => client.account.me(),
  } satisfies UseQueryOptions<AccountMe, AuthkitClientError>;
}

/**
 * Query de visão geral de segurança (sessões, MFA, e-mail pendente).
 *
 * Substitui parcialmente o antigo `useSessions()`.
 * Antes: `{ data: AuthSession[]|null, loading, error, actions: { revoke } }`
 * Agora: `{ data: AccountSecurityOverview|undefined, ... }`
 */
export function useSecurityQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.security(),
    queryFn: () => client.account.security(),
  } satisfies UseQueryOptions<AccountSecurityOverview, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Profile – Mutation
// ---------------------------------------------------------------------------

export function useUpdateProfileMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'profile', 'update'],
    mutationFn: (data: UpdateProfileInput) => client.account.updateProfile(data),
  } satisfies UseMutationOptions<UpdateProfileResult, AuthkitClientError, UpdateProfileInput>;
}

// ---------------------------------------------------------------------------
// Password – Mutation
// ---------------------------------------------------------------------------

export function useChangePasswordMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'password', 'change'],
    mutationFn: (data: ChangePasswordInput) => client.account.changePassword(data),
  } satisfies UseMutationOptions<OkResult, AuthkitClientError, ChangePasswordInput>;
}

// ---------------------------------------------------------------------------
// Email change – Mutations
// ---------------------------------------------------------------------------

export function useEmailChangeMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'email-change'],
    mutationFn: (data: RequestEmailChangeInput) => client.account.emailChange(data),
  } satisfies UseMutationOptions<EmailChangeResult, AuthkitClientError, RequestEmailChangeInput>;
}

export function useCancelEmailChangeMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'email-change', 'cancel'],
    mutationFn: () => client.account.cancelEmailChange(),
  } satisfies UseMutationOptions<OkResult, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Sessions – Query + Mutations
// ---------------------------------------------------------------------------

/**
 * Query de sessões ativas do usuário logado.
 *
 * Substitui o antigo `useSessions()` (o antigo era `/account/security`,
 * este bate em `/account/api/sessions`).
 * Antes: `{ data: AuthSession[]|null, loading, error, actions: { revoke, refetch } }`
 * Agora: shape TanStack padrão; mutação via `useRevokeSessionMutationOptions`.
 */
export function useAccountSessionsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.sessions(),
    queryFn: () => client.account.sessions.list(),
  } satisfies UseQueryOptions<AccountSessionsResult, AuthkitClientError>;
}

export function useRevokeSessionMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'sessions', 'revoke'],
    mutationFn: (id: string) => client.account.sessions.revoke(id),
  } satisfies UseMutationOptions<RevokeSessionResult, AuthkitClientError, string>;
}

export function useRevokeOtherSessionsMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'sessions', 'revoke-others'],
    mutationFn: () => client.account.sessions.revokeOthers(),
  } satisfies UseMutationOptions<RevokeOthersResult, AuthkitClientError, void>;
}

/**
 * Mutation: revogar TODAS as sessões OIDC + grants da conta e encerrar a sessão
 * do console (logout global). O resultado inclui `signedOut: true` — a UI deve
 * redirecionar para o login após o sucesso.
 *
 * Invalida `authkitKeys.account.sessions()` (embora após o redirect não seja necessário).
 */
export function useAccountRevokeAllSessionsMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'sessions', 'revoke-all'],
    mutationFn: () => client.account.sessions.revokeAll(),
  } satisfies UseMutationOptions<RevokeAllResult, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Apps – Query + Mutation
// ---------------------------------------------------------------------------

/**
 * Query de apps autorizados (grants OAuth/OIDC).
 *
 * Substitui o antigo `useAuthorizedApps()`.
 * Antes: `{ data: AuthorizedApp[]|null, loading, error, actions: { revoke, refetch } }`
 * Agora: shape TanStack padrão; mutação via `useRevokeAppMutationOptions`.
 */
export function useAppsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.apps(),
    queryFn: () => client.account.apps.list(),
  } satisfies UseQueryOptions<AccountAppsResult, AuthkitClientError>;
}

export function useRevokeAppMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'apps', 'revoke'],
    mutationFn: (clientId: string) => client.account.apps.revoke(clientId),
  } satisfies UseMutationOptions<RevokeAppResult, AuthkitClientError, string>;
}

// ---------------------------------------------------------------------------
// MFA – Query
// ---------------------------------------------------------------------------

export function useMfaQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.mfa(),
    queryFn: () => client.account.mfa(),
  } satisfies UseQueryOptions<AccountMfaStatus, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Login methods (preferência por usuário de tipos de login) – Query + Mutation
// ---------------------------------------------------------------------------

/**
 * Query da preferência de tipos de login do usuário logado: o que ele escolheu,
 * o que está disponível (global ∩ preferência) e o que está travado (fora do
 * controle dele — globalmente off ou pin de config).
 */
export function useLoginMethodsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.loginMethods(),
    queryFn: () => client.account.loginMethods.get(),
  } satisfies UseQueryOptions<AccountLoginMethodsResult, AuthkitClientError>;
}

/** Mutation da preferência de tipos de login. `{}` = voltar a herdar os globais. */
export function useUpdateLoginMethodsMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'login-methods', 'update'],
    mutationFn: (data: { methods: UserLoginMethodsInput }) =>
      client.account.loginMethods.update(data),
  } satisfies UseMutationOptions<
    UpdateLoginMethodsResult,
    AuthkitClientError,
    { methods: UserLoginMethodsInput }
  >;
}

// ---------------------------------------------------------------------------
// Passkeys – Query + Mutation
// ---------------------------------------------------------------------------

export function usePasskeysQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.passkeys(),
    queryFn: () => client.account.passkeys.list(),
  } satisfies UseQueryOptions<AccountPasskeysResult, AuthkitClientError>;
}

export function useRemovePasskeyMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'passkeys', 'remove'],
    mutationFn: (id: string) => client.account.passkeys.remove(id),
  } satisfies UseMutationOptions<RemovePasskeyResult, AuthkitClientError, string>;
}

// ---------------------------------------------------------------------------
// Tokens (PAT) – Query + Mutations
// ---------------------------------------------------------------------------

export function useTokensQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.tokens(),
    queryFn: () => client.account.tokens.list(),
  } satisfies UseQueryOptions<AccountTokensResult, AuthkitClientError>;
}

export function useCreateTokenMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'tokens', 'create'],
    mutationFn: (data?: CreateTokenInput) => client.account.tokens.create(data),
  } satisfies UseMutationOptions<
    CreatedPatResult,
    AuthkitClientError,
    CreateTokenInput | undefined
  >;
}

export function useRevokeTokenMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'tokens', 'revoke'],
    mutationFn: (id: string) => client.account.tokens.remove(id),
  } satisfies UseMutationOptions<RevokeTokenResult, AuthkitClientError, string>;
}

// ---------------------------------------------------------------------------
// Orgs – Queries
// ---------------------------------------------------------------------------

/**
 * Query de organizações do usuário logado.
 *
 * Substitui o antigo `useOrganizations()`.
 * Antes: `{ data: OrgEntry[]|null, loading, error, activeOrgId, supported, actions }`
 * Agora: shape TanStack padrão com `data: AccountOrgsResult`.
 * O `activeOrgId` fica em `data.activeOrgId` e `supported` em `data.supported`.
 */
export function useAccountOrgsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.orgs(),
    queryFn: () => client.account.orgs.list(),
  } satisfies UseQueryOptions<AccountOrgsResult, AuthkitClientError>;
}

/**
 * Query de detalhe de uma organização.
 *
 * Substitui o antigo `useOrganization(orgId)`.
 * Antes: `{ data: ActiveOrgDetail|null, loading, error, actions }`
 * Agora: shape TanStack padrão.
 */
export function useAccountOrgQueryOptions(id: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.org(id),
    queryFn: () => client.account.orgs.get(id),
    enabled: !!id,
  } satisfies UseQueryOptions<AccountOrgDetail, AuthkitClientError>;
}

/**
 * Query de convites de organizações pendentes para o usuário logado.
 *
 * Substitui o antigo `useOrgInvitations()`.
 * Antes: `{ data: OrgInvitationEntry[]|null, loading, error, actions: { accept } }`
 * Agora: shape TanStack padrão. `accept` vira um POST via `useAcceptOrgInvitationMutationOptions`.
 */
export function useAccountOrgInvitationsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.orgInvitations(),
    queryFn: () => client.account.orgs.invitations(),
  } satisfies UseQueryOptions<AccountOrgInvitationsResult, AuthkitClientError>;
}
