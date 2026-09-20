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
  AcceptOrgInvitationResult,
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
  ActivateOrgResult,
  ChangePasswordInput,
  CreateAccountOrgInput,
  CreatedAccountOrgResult,
  CreatedOrgInvitationResult,
  CreatedPatResult,
  CreateTokenInput,
  DeactivateOrgResult,
  EmailChangeResult,
  LeaveOrgResult,
  MfaConfirmResult,
  MfaDisableResult,
  MfaEnrollResult,
  MfaRecoveryCodesResult,
  OkResult,
  RemoveOrgMemberResult,
  RemovePasskeyResult,
  RequestEmailChangeInput,
  RevokeAllResult,
  RevokeAppResult,
  RevokeOrgInvitationResult,
  RevokeOthersResult,
  RevokeSessionResult,
  RevokeTokenResult,
  UpdateLoginMethodsResult,
  UpdateOrgMemberRoleResult,
  UpdateProfileInput,
  UpdateProfileResult,
  UserLoginMethodsInput,
} from '../../client/types.js';
import {
  type RegisterPasskeyJsonDeps,
  registerPasskeyJson,
} from '../../passkey/json_registration.js';
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
 * Agora: shape TanStack padrão. `accept` vira um POST via `useAccountAcceptOrgInvitationMutationOptions`.
 */
export function useAccountOrgInvitationsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.orgInvitations(),
    queryFn: () => client.account.orgs.invitations(),
  } satisfies UseQueryOptions<AccountOrgInvitationsResult, AuthkitClientError>;
}

// ---------------------------------------------------------------------------
// Orgs – Mutations (espelho JSON dos formulários de /account/orgs)
// ---------------------------------------------------------------------------
//
// Para o host que desenha as PRÓPRIAS telas de organização e não quer mandar o
// usuário ao console `/account/orgs`. Cada hook devolve options prontas para
// `useMutation`; a invalidação fica com o consumidor (é o mesmo contrato dos
// hooks de admin — ver o cabeçalho de `queries/admin/index.ts`), e as chaves a
// invalidar estão documentadas em cada hook.
//
// O prefixo `useAccount…` nos nomes não é enfeite: a superfície ADMIN já exporta
// `useCreateOrgMutationOptions`, `useRemoveOrgMemberMutationOptions` e companhia
// do mesmo `index.ts` do pacote, e são operações DIFERENTES (o admin age sobre
// qualquer org; estas agem sobre as orgs do usuário logado, com os gates de
// membro). Mesmo prefixo de `useAccountSessionsQueryOptions` e
// `useAccountRevokeAllSessionsMutationOptions`.
//
// Os erros chegam como `AuthkitClientError` com `code` do envelope do servidor:
// `self_create_disabled`, `slug_taken`, `invalid_role`, `last_owner`,
// `forbidden`, `expired`, `email_mismatch`. É por eles que a tela decide a
// mensagem — não pelo status sozinho.

/**
 * Cria uma organização (quem cria entra como `owner`).
 *
 * Invalide `authkitKeys.account.orgs()` no sucesso.
 * `403 self_create_disabled` quando a política efetiva não permite self-service;
 * `409 slug_taken` quando o slug já existe.
 */
export function useAccountCreateOrgMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgCreate(),
    mutationFn: (data: CreateAccountOrgInput) => client.account.orgs.create(data),
  } satisfies UseMutationOptions<
    CreatedAccountOrgResult,
    AuthkitClientError,
    CreateAccountOrgInput
  >;
}

/**
 * Define a organização ATIVA (o servidor grava o cookie `authkit_active_org`).
 *
 * Invalide `authkitKeys.account.orgs()` e `authkitKeys.account.me()` no sucesso:
 * a org ativa aparece nos dois.
 */
export function useAccountActivateOrgMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgActivate(),
    mutationFn: (orgId: string) => client.account.orgs.activate(orgId),
  } satisfies UseMutationOptions<ActivateOrgResult, AuthkitClientError, string>;
}

/** Limpa a organização ativa. Invalide as mesmas chaves do `activate`. */
export function useAccountDeactivateOrgMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgDeactivate(),
    mutationFn: () => client.account.orgs.deactivate(),
  } satisfies UseMutationOptions<DeactivateOrgResult, AuthkitClientError, void>;
}

/**
 * Sai de uma organização. `409 last_owner` quando o usuário é o último owner —
 * a tela deve oferecer promover alguém antes.
 */
export function useAccountLeaveOrgMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgLeave(),
    mutationFn: (orgId: string) => client.account.orgs.leave(orgId),
  } satisfies UseMutationOptions<LeaveOrgResult, AuthkitClientError, string>;
}

/**
 * Convida alguém por e-mail. Exige papel `owner`/`admin` na org; só um `owner`
 * concede o papel `owner` (senão `403 forbidden`).
 *
 * O token de aceite NÃO volta na resposta: ele viaja por e-mail. Invalide
 * `authkitKeys.account.org(orgId)` no sucesso.
 */
export function useAccountInviteOrgMemberMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgInvite(),
    mutationFn: (vars: { orgId: string; email: string; role?: string }) =>
      client.account.orgs.invite(vars.orgId, { email: vars.email, role: vars.role }),
  } satisfies UseMutationOptions<
    CreatedOrgInvitationResult,
    AuthkitClientError,
    { orgId: string; email: string; role?: string }
  >;
}

/** Revoga um convite pendente. Escopado por org: um convite de outra org dá 404. */
export function useAccountRevokeOrgInvitationMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgRevokeInvitation(),
    mutationFn: (vars: { orgId: string; invitationId: string }) =>
      client.account.orgs.revokeInvitation(vars.orgId, vars.invitationId),
  } satisfies UseMutationOptions<
    RevokeOrgInvitationResult,
    AuthkitClientError,
    { orgId: string; invitationId: string }
  >;
}

/**
 * Troca o papel de um membro. Exige `owner`/`admin`; conceder `owner` é
 * privativo de um `owner`, e rebaixar o último owner dá `409 last_owner`.
 */
export function useAccountUpdateOrgMemberRoleMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgUpdateMemberRole(),
    mutationFn: (vars: { orgId: string; accountId: string; role: string }) =>
      client.account.orgs.updateMemberRole(vars.orgId, vars.accountId, vars.role),
  } satisfies UseMutationOptions<
    UpdateOrgMemberRoleResult,
    AuthkitClientError,
    { orgId: string; accountId: string; role: string }
  >;
}

/** Remove um membro da org. Exige `owner`/`admin`. */
export function useAccountRemoveOrgMemberMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgRemoveMember(),
    mutationFn: (vars: { orgId: string; accountId: string }) =>
      client.account.orgs.removeMember(vars.orgId, vars.accountId),
  } satisfies UseMutationOptions<
    RemoveOrgMemberResult,
    AuthkitClientError,
    { orgId: string; accountId: string }
  >;
}

/**
 * Aceita um convite pelo token do e-mail.
 *
 * Invalide `authkitKeys.account.orgs()` E `authkitKeys.account.orgInvitations()`
 * no sucesso. `410 expired` para convite vencido; `403 email_mismatch` quando o
 * convite é de outro e-mail.
 */
export function useAccountAcceptOrgInvitationMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.orgAcceptInvitation(),
    mutationFn: (token: string) => client.account.orgs.acceptInvitation(token),
  } satisfies UseMutationOptions<AcceptOrgInvitationResult, AuthkitClientError, string>;
}

// ---------------------------------------------------------------------------
// Segundo fator – Mutations (TOTP, recovery codes e registro de passkey)
// ---------------------------------------------------------------------------
//
// SUDO: `enroll`, `disable`, `recovery-codes` e o `verify` de passkey exigem
// confirmação de identidade recente. Sem ela, o servidor responde
// `403 { error: { code: 'sudo_required' } }` — que chega aqui como
// `AuthkitClientError` com `code === 'sudo_required'`. É o sinal para a tela
// mandar o usuário reconfirmar (ex.: navegar para `/account/confirm` com
// `return_to`), e não um erro a exibir cru.

/**
 * Inicia o enrolamento TOTP: devolve `secret`, `otpauthUri` e o QR já
 * renderizado (`qrDataUrl`, pronto para `<img src>`).
 *
 * O segredo só existe nesta resposta — depois disso o servidor guarda só o que
 * precisa para verificar. Exige sudo.
 */
export function useEnrollTotpMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.mfaEnroll(),
    mutationFn: () => client.account.mfa.enroll(),
  } satisfies UseMutationOptions<MfaEnrollResult, AuthkitClientError, void>;
}

/**
 * Confirma o enrolamento com o código do app autenticador e LIGA o MFA.
 *
 * Os `recoveryCodes` voltam em claro UMA ÚNICA vez: a tela tem de mostrá-los (ou
 * oferecer download) antes de sair. Código errado → `422 invalid_code`, e o
 * segredo pendente NÃO muda (o QR já escaneado continua valendo).
 *
 * Invalide `authkitKeys.account.mfa()` e `authkitKeys.account.security()`.
 */
export function useConfirmTotpMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.mfaConfirm(),
    mutationFn: (code: string) => client.account.mfa.confirm(code),
  } satisfies UseMutationOptions<MfaConfirmResult, AuthkitClientError, string>;
}

/** Desliga o MFA (TOTP + recovery codes). Exige sudo. Invalide as mesmas chaves do confirm. */
export function useDisableTotpMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.mfaDisable(),
    mutationFn: () => client.account.mfa.disable(),
  } satisfies UseMutationOptions<MfaDisableResult, AuthkitClientError, void>;
}

/**
 * Regenera os recovery codes: os antigos — inclusive os não usados — deixam de
 * valer no mesmo instante, e os novos voltam em claro uma única vez.
 *
 * Exige sudo e MFA ATIVO (`422 mfa_not_enabled` caso contrário). Quando o store
 * do host não implementa a capacidade, vem `422 capability_unsupported`; use
 * `data.recovery.regenerable` de `useMfaQueryOptions` para decidir se mostra o
 * botão.
 */
export function useRegenerateRecoveryCodesMutationOptions() {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.mfaRecoveryCodes(),
    mutationFn: () => client.account.mfa.regenerateRecoveryCodes(),
  } satisfies UseMutationOptions<MfaRecoveryCodesResult, AuthkitClientError, void>;
}

/**
 * Cerimônia COMPLETA de registro de passkey em JSON, num único `mutate()`:
 * pede as options, roda `startRegistration()` do `@simplewebauthn/browser` e
 * envia o attestation para verificação.
 *
 * É o par headless do `usePasskeyRegistration` (que ainda existe e não muda):
 * lá a verificação é um POST de PÁGINA INTEIRA, porque o endpoint clássico
 * responde 302; aqui tudo acontece por fetch, que é o que uma tela do host
 * precisa — o browser não pode navegar entre a chamada de `startRegistration()`
 * e o envio do resultado.
 *
 * `@simplewebauthn/browser` é peer OPCIONAL: sem ele, a mutation falha com a
 * instrução de instalação. Exige sudo no `verify`. Invalide
 * `authkitKeys.account.passkeys()` e `authkitKeys.account.mfa()` no sucesso.
 */
export function useRegisterPasskeyMutationOptions(deps: RegisterPasskeyJsonDeps = {}) {
  const client = useAuthkitClient();
  return {
    mutationKey: authkitKeys.account.mutations.passkeyRegister(),
    mutationFn: () => registerPasskeyJson(client, deps),
  } satisfies UseMutationOptions<OkResult, AuthkitClientError, void>;
}
