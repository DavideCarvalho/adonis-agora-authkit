/**
 * Hooks TanStack Query para a Admin Console API.
 *
 * Estilo de mutation: todos os mutation hooks retornam `UseMutationOptions`
 * (objeto puro, sem chamar `useMutation` internamente). Isso dá flexibilidade
 * total ao consumidor: ele chama `useMutation(useXxxMutationOptions(...))` e
 * coloca `onSuccess`/`onError` + `queryClient.invalidateQueries` no handler,
 * conforme o padrão do projeto.
 *
 * Query hooks seguem o mesmo padrão: retornam `UseQueryOptions` e o consumidor
 * chama `useQuery(useXxxQueryOptions(...))`.
 */

import type { UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';
import { AuthkitClientError } from '../../client/client.js';
import { useAuthkitClient } from '../../client/context.js';
import type {
  AdminClient,
  AdminClientListResult,
  AdminOrgDetail,
  AdminOrgEntry,
  AdminOrgInvitation,
  AdminOrgListResult,
  AdminOverview,
  AdminUser,
  AdminUserListResult,
  AuditListParams,
  AuditListResult,
  CreateClientInput,
  CreatedClientResult,
  CreateOrgInput,
  CreateRoleInput,
  CreateUserInput,
  ImpersonationPanel,
  KeysRotateInput,
  KeysRotateResult,
  KeysStatus,
  RegenerateSecretResult,
  RevokeSessionsResult,
  RoleCatalogEntry,
  RoleListResult,
  SettingEntry,
  SettingListResult,
  UpdateClientInput,
  UpdateOrgInput,
  UpdateRoleInput,
  UpdateUserInput,
  UserSessionsResult,
} from '../../client/types.js';
import { authkitKeys } from '../keys.js';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function useOverviewQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.overview(),
    queryFn: () => client.admin.overview(),
  } satisfies UseQueryOptions<AdminOverview, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Users – Queries
// ---------------------------------------------------------------------------

export function useUsersQueryOptions(params?: { search?: string; page?: number; limit?: number }) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.users(params),
    queryFn: () => client.admin.users.list(params),
  } satisfies UseQueryOptions<AdminUserListResult, AuthkitClientError>;
}

export function useUserQueryOptions(id: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.user(id),
    queryFn: () => client.admin.users.get(id),
    enabled: !!id,
  } satisfies UseQueryOptions<AdminUser, AuthkitClientError>;
}

export function useUserSessionsQueryOptions(id: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.userSessions(id),
    queryFn: () => client.admin.users.getSessions(id),
    enabled: !!id,
  } satisfies UseQueryOptions<UserSessionsResult, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Users – Mutations
// ---------------------------------------------------------------------------

export function useCreateUserMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', 'create'],
    mutationFn: (data: CreateUserInput) => client.admin.users.create(data),
  } satisfies UseMutationOptions<
    AdminUser & { invited?: boolean },
    AuthkitClientError,
    CreateUserInput
  >;
}

export function useUpdateUserMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'update'],
    mutationFn: (data: UpdateUserInput) => client.admin.users.update(id, data),
  } satisfies UseMutationOptions<AdminUser, AuthkitClientError, UpdateUserInput>;
}

export function useDisableUserMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'disable'],
    mutationFn: () => client.admin.users.disable(id),
  } satisfies UseMutationOptions<{ id: string; disabled: true }, AuthkitClientError, void>;
}

export function useEnableUserMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'enable'],
    mutationFn: () => client.admin.users.enable(id),
  } satisfies UseMutationOptions<{ id: string; disabled: false }, AuthkitClientError, void>;
}

export function useResetPasswordMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'reset-password'],
    mutationFn: () => client.admin.users.resetPassword(id),
  } satisfies UseMutationOptions<{ id: string; sent: boolean }, AuthkitClientError, void>;
}

export function useDeleteUserMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'delete'],
    mutationFn: () => client.admin.users.remove(id),
  } satisfies UseMutationOptions<{ id: string; deleted: boolean }, AuthkitClientError, void>;
}

export function useRevokeUserSessionsMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'users', id, 'revoke-sessions'],
    mutationFn: () => client.admin.users.revokeSessions(id),
  } satisfies UseMutationOptions<RevokeSessionsResult, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Sessions – Query + Mutation
// ---------------------------------------------------------------------------

export function useSessionsQueryOptions(accountId?: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.sessions(accountId),
    queryFn: () => client.admin.sessions.list(accountId),
  } satisfies UseQueryOptions<UserSessionsResult, AuthkitClientError>;
}

export function useRevokeAllSessionsMutationOptions(accountId?: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'sessions', 'revoke-all', accountId ?? null],
    mutationFn: () => client.admin.sessions.revokeAll(accountId),
  } satisfies UseMutationOptions<RevokeSessionsResult, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Clients – Queries + Mutations
// ---------------------------------------------------------------------------

export function useClientsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.clients(),
    queryFn: () => client.admin.clients.list(),
  } satisfies UseQueryOptions<AdminClientListResult, AuthkitClientError>;
}

export function useClientQueryOptions(id: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.client(id),
    queryFn: () => client.admin.clients.get(id),
    enabled: !!id,
  } satisfies UseQueryOptions<AdminClient, AuthkitClientError>;
}

export function useCreateClientMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'clients', 'create'],
    mutationFn: (data?: CreateClientInput) => client.admin.clients.create(data),
  } satisfies UseMutationOptions<
    CreatedClientResult,
    AuthkitClientError,
    CreateClientInput | undefined
  >;
}

export function useUpdateClientMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'clients', id, 'update'],
    mutationFn: (data?: UpdateClientInput) => client.admin.clients.update(id, data),
  } satisfies UseMutationOptions<AdminClient, AuthkitClientError, UpdateClientInput | undefined>;
}

export function useDeleteClientMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'clients', id, 'delete'],
    mutationFn: () => client.admin.clients.remove(id),
  } satisfies UseMutationOptions<{ clientId: string; deleted: boolean }, AuthkitClientError, void>;
}

export function useRegenerateClientSecretMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'clients', id, 'regenerate-secret'],
    mutationFn: () => client.admin.clients.regenerateSecret(id),
  } satisfies UseMutationOptions<RegenerateSecretResult, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Roles – Query + Mutations
// ---------------------------------------------------------------------------

export function useRolesQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.roles(),
    queryFn: () => client.admin.roles.list(),
  } satisfies UseQueryOptions<RoleListResult, AuthkitClientError>;
}

export function useCreateRoleMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'roles', 'create'],
    mutationFn: (data: CreateRoleInput) => client.admin.roles.create(data),
  } satisfies UseMutationOptions<RoleCatalogEntry, AuthkitClientError, CreateRoleInput>;
}

export function useUpdateRoleMutationOptions(name: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'roles', name, 'update'],
    mutationFn: (data: UpdateRoleInput) => client.admin.roles.update(name, data),
  } satisfies UseMutationOptions<RoleCatalogEntry, AuthkitClientError, UpdateRoleInput>;
}

export function useDeleteRoleMutationOptions(name: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'roles', name, 'delete'],
    mutationFn: () => client.admin.roles.remove(name),
  } satisfies UseMutationOptions<{ ok: boolean; deleted: string }, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Orgs – Queries + Mutations
// ---------------------------------------------------------------------------

export function useOrgsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.orgs(),
    queryFn: () => client.admin.orgs.list(),
  } satisfies UseQueryOptions<AdminOrgListResult, AuthkitClientError>;
}

export function useOrgQueryOptions(id: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.org(id),
    queryFn: () => client.admin.orgs.get(id),
    enabled: !!id,
  } satisfies UseQueryOptions<AdminOrgDetail, AuthkitClientError>;
}

export function useCreateOrgMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', 'create'],
    mutationFn: (data: CreateOrgInput) => client.admin.orgs.create(data),
  } satisfies UseMutationOptions<AdminOrgEntry, AuthkitClientError, CreateOrgInput>;
}

export function useUpdateOrgMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', id, 'update'],
    mutationFn: (data: UpdateOrgInput) => client.admin.orgs.update(id, data),
  } satisfies UseMutationOptions<AdminOrgEntry, AuthkitClientError, UpdateOrgInput>;
}

export function useDeleteOrgMutationOptions(id: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', id, 'delete'],
    mutationFn: () => client.admin.orgs.remove(id),
  } satisfies UseMutationOptions<{ id: string; deleted: boolean }, AuthkitClientError, void>;
}

export function useAddOrgMemberMutationOptions(orgId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', orgId, 'members', 'add'],
    mutationFn: (data: { accountId: string; role: string }) =>
      client.admin.orgs.addMember(orgId, data),
  } satisfies UseMutationOptions<
    { ok: boolean },
    AuthkitClientError,
    { accountId: string; role: string }
  >;
}

export function useRemoveOrgMemberMutationOptions(orgId: string, accountId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', orgId, 'members', accountId, 'remove'],
    mutationFn: () => client.admin.orgs.removeMember(orgId, accountId),
  } satisfies UseMutationOptions<{ ok: boolean }, AuthkitClientError, void>;
}

export function useUpdateOrgMemberRoleMutationOptions(orgId: string, accountId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', orgId, 'members', accountId, 'role'],
    mutationFn: (role: string) => client.admin.orgs.updateMemberRole(orgId, accountId, role),
  } satisfies UseMutationOptions<{ ok: boolean }, AuthkitClientError, string>;
}

export function useCreateOrgInvitationMutationOptions(orgId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', orgId, 'invitations', 'create'],
    mutationFn: (data: { email: string; role: string }) =>
      client.admin.orgs.createInvitation(orgId, data),
  } satisfies UseMutationOptions<
    { ok: boolean; invitation: AdminOrgInvitation },
    AuthkitClientError,
    { email: string; role: string }
  >;
}

export function useRevokeOrgInvitationMutationOptions(orgId: string, invitationId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'orgs', orgId, 'invitations', invitationId, 'revoke'],
    mutationFn: () => client.admin.orgs.revokeInvitation(orgId, invitationId),
  } satisfies UseMutationOptions<{ ok: boolean }, AuthkitClientError, void>;
}

// ---------------------------------------------------------------------------
// Audit – Query
// ---------------------------------------------------------------------------

export function useAuditQueryOptions(params?: AuditListParams) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.audit(params),
    queryFn: () => client.admin.audit.list(params),
  } satisfies UseQueryOptions<AuditListResult, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Settings – Query + Mutations
// ---------------------------------------------------------------------------

/**
 * Query para listar settings.
 * @param orgId - quando fornecido, lista settings da org; null/undefined = global
 */
export function useSettingsQueryOptions(orgId?: string | null) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.settings(orgId),
    queryFn: () => client.admin.settings.list(orgId),
  } satisfies UseQueryOptions<SettingListResult, AuthkitClientError>;
}

/**
 * Mutation para gravar uma setting.
 * @param orgId - quando fornecido, grava no escopo da org; null/undefined = global
 */
export function useSetSettingMutationOptions(orgId?: string | null) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'settings', 'set', orgId ?? null],
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      client.admin.settings.set(key, value, orgId),
  } satisfies UseMutationOptions<SettingEntry, AuthkitClientError, { key: string; value: unknown }>;
}

/**
 * Mutation para remover uma setting.
 * @param orgId - quando fornecido, remove no escopo da org; null/undefined = global
 */
export function useRemoveSettingMutationOptions(orgId?: string | null) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'settings', 'remove', orgId ?? null],
    mutationFn: (key: string) => client.admin.settings.remove(key, orgId),
  } satisfies UseMutationOptions<
    { key: string; organizationId: string | null; deleted: boolean },
    AuthkitClientError,
    string
  >;
}

// ---------------------------------------------------------------------------
// Impersonation – Query
// ---------------------------------------------------------------------------

export function useImpersonationQueryOptions(userId: string) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.impersonation(userId),
    queryFn: () => client.admin.impersonation.get(userId),
    enabled: !!userId,
  } satisfies UseQueryOptions<ImpersonationPanel, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Keys – Query + Mutation
// ---------------------------------------------------------------------------

export function useKeysQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.admin.keys(),
    queryFn: () => client.admin.keys.status(),
  } satisfies UseQueryOptions<KeysStatus, AuthkitClientError>;
}

export function useRotateKeysMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'admin', 'keys', 'rotate'],
    mutationFn: (input?: KeysRotateInput) => client.admin.keys.rotate(input),
  } satisfies UseMutationOptions<KeysRotateResult, AuthkitClientError, KeysRotateInput | undefined>;
}
