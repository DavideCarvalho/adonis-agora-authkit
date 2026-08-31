// Estado de auth (shared-prop do Inertia)

export type { AuthkitProviderProps } from './src/authkit_provider.js';
// Provider de config + headless hooks de URL/dados
export { AuthkitProvider } from './src/authkit_provider.js';
export type {
  AuthkitClient,
  AuthkitClientOptions,
} from './src/client/client.js';
// ─── Client tipado ────────────────────────────────────────────────────────────
export {
  AuthkitClientError,
  createAuthkitClient,
} from './src/client/client.js';
export type { AuthkitClientProviderProps } from './src/client/context.js';
// ─── Provider do client ───────────────────────────────────────────────────────
export {
  AuthkitClientProvider,
  createAuthkitQueryClient,
  useAuthkitClient,
} from './src/client/context.js';
// Tipos das superfícies do client (desacoplados do server)
export type {
  // Account – Apps
  AccountAppEntry,
  AccountAppsResult,
  // Account – Me / Security
  AccountCapabilities,
  // Account – Login methods (preferência por usuário de tipos de login)
  AccountLoginMethodsResult,
  AccountMe,
  AccountMfaStatus,
  AccountOrgDetail,
  // Account – Orgs
  AccountOrgEntry,
  AccountOrgInvitationsResult,
  AccountOrgsResult,
  AccountPasskeysResult,
  AccountSecurityOverview,
  AccountSessionEntry,
  // Account – Sessions
  AccountSessionsResult,
  AccountTokensResult,
  // Admin – Clients
  AdminClient,
  AdminClientListResult,
  AdminGrantEntry,
  AdminOrgDetail,
  // Admin – Orgs
  AdminOrgEntry,
  AdminOrgInvitation,
  AdminOrgListResult,
  AdminOrgMember,
  AdminOverview,
  AdminSessionEntry,
  // Admin – Usuários
  AdminUser,
  AdminUserListResult,
  ApiErrorBody,
  // Admin – Audit
  AuditEventEntry,
  AuditListParams,
  AuditListResult,
  // Account – Senha / E-mail
  ChangePasswordInput,
  CreateClientInput,
  CreatedClientResult,
  CreatedPatResult,
  CreateOrgInput,
  CreateRoleInput,
  CreateTokenInput,
  CreateUserInput,
  // Admin – Overview
  DailyPoint,
  EmailChangeResult,
  // Admin – Impersonation
  ImpersonationPanel,
  KeysRotateInput,
  KeysRotateResult,
  // Admin – Keys
  KeysStatus,
  ManagedKeyInfo,
  OkResult,
  // Account – MFA / Passkeys
  PasskeySummaryEntry,
  // Account – Tokens
  PatEntry,
  RegenerateSecretResult,
  RemovePasskeyResult,
  RequestEmailChangeInput,
  RevokeAllResult,
  RevokeAppResult,
  RevokeOthersResult,
  RevokeSessionResult,
  RevokeSessionsResult,
  RevokeTokenResult,
  // Admin – Roles
  RoleCatalogEntry,
  RoleListResult,
  // Admin – Settings
  SettingEntry,
  SettingListResult,
  UpdateClientInput,
  UpdateLoginMethodsResult,
  UpdateOrgInput,
  // Account – Perfil
  UpdateProfileInput,
  UpdateProfileResult,
  UpdateRoleInput,
  UpdateUserInput,
  UserLoginMethodsInput,
  UserSessionsResult,
} from './src/client/types.js';
export type {
  AuthenticatedProps,
  GuestProps,
} from './src/components/authenticated.js';
// Componentes de gating
export { Authenticated, Guest } from './src/components/authenticated.js';
export type { AuthorizedAppsProps } from './src/components/authorized_apps.js';
export { AuthorizedApps } from './src/components/authorized_apps.js';
export type { AvatarProps } from './src/components/avatar.js';
export { Avatar } from './src/components/avatar.js';
export type { CanPermissionProps } from './src/components/can_permission.js';
export { CanPermission } from './src/components/can_permission.js';
export type { InteractionFormProps } from './src/components/interaction_form.js';
export { InteractionForm } from './src/components/interaction_form.js';
export type { KeyRotationProps } from './src/components/key_rotation.js';
export { KeyRotation } from './src/components/key_rotation.js';
export type { MagicLinkButtonProps } from './src/components/magic_link_button.js';
export { MagicLinkButton } from './src/components/magic_link_button.js';
export type { OAuthButtonProps } from './src/components/oauth_button.js';
export { OAuthButton } from './src/components/oauth_button.js';
export type { OrganizationProfileProps } from './src/components/organization_profile.js';
export { OrganizationProfile } from './src/components/organization_profile.js';
export type { OrganizationSwitcherProps } from './src/components/organization_switcher.js';
export { OrganizationSwitcher } from './src/components/organization_switcher.js';
export type { PasskeyButtonProps } from './src/components/passkey_button.js';
export { PasskeyButton } from './src/components/passkey_button.js';
export type { PasswordStrengthMeterProps } from './src/components/password_strength_meter.js';
export { PasswordStrengthMeter } from './src/components/password_strength_meter.js';
export type { SignInButtonProps } from './src/components/sign_in_button.js';
// Componentes prontos
export { SignInButton } from './src/components/sign_in_button.js';
export type { SignOutButtonProps } from './src/components/sign_out_button.js';
export { SignOutButton } from './src/components/sign_out_button.js';
export type { UserButtonProps } from './src/components/user_button.js';
export { UserButton } from './src/components/user_button.js';
export type { UserProfileProps } from './src/components/user_profile.js';
export { UserProfile } from './src/components/user_profile.js';
export type {
  AuthkitConfig,
  AuthkitEndpoints,
  AuthkitIdpMode,
  ResolvedAuthkitConfig,
} from './src/config.js';
export {
  AuthkitConfigContext,
  buildAuthUrl,
  DEFAULT_CONFIG,
  resolveConfig,
  useAuthkitConfig,
} from './src/config.js';
export type {
  AuthorizedApp,
  UseAuthorizedAppsResult,
} from './src/hooks/use_authorized_apps.js';
export { useAuthorizedApps } from './src/hooks/use_authorized_apps.js';
export type { UseCanResult } from './src/hooks/use_can.js';
export { checkCan, invalidateCanCache, useCan } from './src/hooks/use_can.js';
export type {
  OrgInvitationEntry,
  UseOrgInvitationsResult,
} from './src/hooks/use_org_invitations.js';
export { useOrgInvitations } from './src/hooks/use_org_invitations.js';
export type {
  ActiveOrgDetail,
  OrgMemberEntry,
  UseOrganizationResult,
} from './src/hooks/use_organization.js';
export { useOrganization } from './src/hooks/use_organization.js';
export type {
  OrgEntry,
  UseOrganizationsResult,
} from './src/hooks/use_organizations.js';
export { useOrganizations } from './src/hooks/use_organizations.js';
export type {
  UsePasskeyAssertionOptions,
  UsePasskeyAssertionResult,
} from './src/hooks/use_passkey_assertion.js';
export { usePasskeyAssertion } from './src/hooks/use_passkey_assertion.js';
export type { UsePasskeyAutofillOptions } from './src/hooks/use_passkey_autofill.js';
export { usePasskeyAutofill } from './src/hooks/use_passkey_autofill.js';
export type {
  UsePasskeyLoginOptions,
  UsePasskeyLoginResult,
} from './src/hooks/use_passkey_login.js';
export { usePasskeyLogin } from './src/hooks/use_passkey_login.js';
export type {
  UsePasskeyRegistrationOptions,
  UsePasskeyRegistrationResult,
} from './src/hooks/use_passkey_registration.js';
export { usePasskeyRegistration } from './src/hooks/use_passkey_registration.js';
export type {
  PasswordScorer,
  PasswordStrengthResult,
  PasswordStrengthScore,
  UsePasswordStrengthOptions,
} from './src/hooks/use_password_strength.js';
export {
  heuristicScorer,
  usePasswordStrength,
} from './src/hooks/use_password_strength.js';
export type {
  ProfileUpdate,
  UseProfileResult,
} from './src/hooks/use_profile.js';
export { useProfile } from './src/hooks/use_profile.js';
export type { ResourceState } from './src/hooks/use_resource.js';
export { jsonRequest, useResource } from './src/hooks/use_resource.js';
export type {
  AuthSession,
  UseSessionsResult,
} from './src/hooks/use_sessions.js';
export { useSessions } from './src/hooks/use_sessions.js';
export type { SignInOptions } from './src/hooks/use_sign_in.js';
export { useSignIn } from './src/hooks/use_sign_in.js';
export type { SignOutOptions } from './src/hooks/use_sign_out.js';
export { useSignOut } from './src/hooks/use_sign_out.js';
export type { UseSwitchOrganizationResult } from './src/hooks/use_switch_organization.js';
export { useSwitchOrganization } from './src/hooks/use_switch_organization.js';
export type { UseUserResult } from './src/hooks/use_user.js';
export { useUser } from './src/hooks/use_user.js';
export type {
  InteractionPostStep,
  InteractionUrls,
} from './src/interaction/urls.js';
// URLs de interaction (builders tipados)
export { interactionUrls, OTP_CODE_FIELD, oauthRedirectUrl } from './src/interaction/urls.js';
export type {
  AuthenticatePasskeyOptions,
  PasskeyCeremonyDeps,
  PasskeyRegistrationDeps,
  RegisterPasskeyOptions,
  StartAuthenticationFn,
  StartRegistrationFn,
  SubmitPasskeyVerificationOptions,
} from './src/passkey/authenticate.js';
export {
  authenticatePasskey,
  loadStartAuthentication,
  loadStartRegistration,
  registerPasskey,
  submitPasskeyVerification,
} from './src/passkey/authenticate.js';
export type {
  SubmitClassicFormDeps,
  SubmitClassicFormOptions,
} from './src/passkey/classic_form.js';
// Headless: form clássico + "dance" de sudo/passkey para telas React próprias.
export { submitClassicForm } from './src/passkey/classic_form.js';
export type {
  RunPasskeyAssertionDeps,
  RunPasskeyFlowOptions,
  RunPasskeyRegistrationDeps,
} from './src/passkey/sudo.js';
export { runPasskeyAssertion, runPasskeyRegistration } from './src/passkey/sudo.js';
export type { AuthProviderProps } from './src/provider.js';
export { AuthContext, AuthProvider } from './src/provider.js';
// ─── Hooks TanStack Query — Account ──────────────────────────────────────────
export {
  useAccountOrgInvitationsQueryOptions,
  useAccountOrgQueryOptions,
  // Orgs
  useAccountOrgsQueryOptions,
  useAccountRevokeAllSessionsMutationOptions,
  // Sessions
  useAccountSessionsQueryOptions,
  // Apps
  useAppsQueryOptions,
  useCancelEmailChangeMutationOptions,
  // Password
  useChangePasswordMutationOptions,
  useCreateTokenMutationOptions,
  // Email change
  useEmailChangeMutationOptions,
  // Login methods (preferência por usuário de tipos de login)
  useLoginMethodsQueryOptions,
  // Me / Security
  useMeQueryOptions,
  // MFA
  useMfaQueryOptions,
  // Passkeys
  usePasskeysQueryOptions,
  useRemovePasskeyMutationOptions,
  useRevokeAppMutationOptions,
  useRevokeOtherSessionsMutationOptions,
  useRevokeSessionMutationOptions,
  useRevokeTokenMutationOptions,
  useSecurityQueryOptions,
  // Tokens
  useTokensQueryOptions,
  useUpdateLoginMethodsMutationOptions,
  // Profile
  useUpdateProfileMutationOptions,
} from './src/queries/account/index.js';
// ─── Hooks TanStack Query — Admin ─────────────────────────────────────────────
export {
  useAddOrgMemberMutationOptions,
  // Audit
  useAuditQueryOptions,
  useClientQueryOptions,
  // Clients
  useClientsQueryOptions,
  useCreateClientMutationOptions,
  useCreateOrgInvitationMutationOptions,
  useCreateOrgMutationOptions,
  useCreateRoleMutationOptions,
  useCreateUserMutationOptions,
  useDeleteClientMutationOptions,
  useDeleteOrgMutationOptions,
  useDeleteRoleMutationOptions,
  useDeleteUserMutationOptions,
  useDisableUserMutationOptions,
  useEnableUserMutationOptions,
  // Impersonation
  useImpersonationQueryOptions,
  // Keys
  useKeysQueryOptions,
  useOrgQueryOptions,
  // Orgs
  useOrgsQueryOptions,
  // Overview
  useOverviewQueryOptions,
  useRegenerateClientSecretMutationOptions,
  useRemoveOrgMemberMutationOptions,
  useRemoveSettingMutationOptions,
  useResetPasswordMutationOptions,
  useRevokeAllSessionsMutationOptions,
  useRevokeOrgInvitationMutationOptions,
  useRevokeUserSessionsMutationOptions,
  // Roles
  useRolesQueryOptions,
  useRotateKeysMutationOptions,
  // Sessions
  useSessionsQueryOptions,
  useSetSettingMutationOptions,
  // Settings
  useSettingsQueryOptions,
  useUpdateClientMutationOptions,
  useUpdateOrgMemberRoleMutationOptions,
  useUpdateOrgMutationOptions,
  useUpdateRoleMutationOptions,
  useUpdateUserMutationOptions,
  useUserQueryOptions,
  useUserSessionsQueryOptions,
  // Users
  useUsersQueryOptions,
} from './src/queries/admin/index.js';
// ─── Query keys ───────────────────────────────────────────────────────────────
export { authkitKeys } from './src/queries/keys.js';
// helpers de papéis (puros)
export {
  hasAllGlobalRoles,
  hasAnyGlobalRole,
  hasGlobalRole,
} from './src/roles.js';
export type { AuthSharedProps, AuthState, AuthUser } from './src/types.js';
export { useAuth } from './src/use_auth.js';
// utilitários puros
export { buttonClass, currentUrl, deriveInitials } from './src/utils.js';
