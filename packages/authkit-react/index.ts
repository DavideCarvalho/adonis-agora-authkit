// Estado de auth (shared-prop do Inertia)
export { useAuth } from './src/use_auth.js';
export { AuthProvider, AuthContext } from './src/provider.js';
export type { AuthProviderProps } from './src/provider.js';

// Provider de config + headless hooks de URL/dados
export { AuthkitProvider } from './src/authkit_provider.js';
export type { AuthkitProviderProps } from './src/authkit_provider.js';
export {
  AuthkitConfigContext,
  useAuthkitConfig,
  resolveConfig,
  buildAuthUrl,
  DEFAULT_CONFIG,
} from './src/config.js';
export type {
  AuthkitConfig,
  ResolvedAuthkitConfig,
  AuthkitEndpoints,
  AuthkitIdpMode,
} from './src/config.js';

export { useSignIn } from './src/hooks/use_sign_in.js';
export type { SignInOptions } from './src/hooks/use_sign_in.js';
export { useSignOut } from './src/hooks/use_sign_out.js';
export type { SignOutOptions } from './src/hooks/use_sign_out.js';
export { useUser } from './src/hooks/use_user.js';
export type { UseUserResult } from './src/hooks/use_user.js';
export { useProfile } from './src/hooks/use_profile.js';
export type {
  UseProfileResult,
  ProfileUpdate,
} from './src/hooks/use_profile.js';
export { useSessions } from './src/hooks/use_sessions.js';
export type {
  UseSessionsResult,
  AuthSession,
} from './src/hooks/use_sessions.js';
export { useAuthorizedApps } from './src/hooks/use_authorized_apps.js';
export type {
  UseAuthorizedAppsResult,
  AuthorizedApp,
} from './src/hooks/use_authorized_apps.js';
export { useOrganizations } from './src/hooks/use_organizations.js';
export type {
  UseOrganizationsResult,
  OrgEntry,
} from './src/hooks/use_organizations.js';
export { useOrganization } from './src/hooks/use_organization.js';
export type {
  UseOrganizationResult,
  ActiveOrgDetail,
  OrgMemberEntry,
} from './src/hooks/use_organization.js';
export { useSwitchOrganization } from './src/hooks/use_switch_organization.js';
export type { UseSwitchOrganizationResult } from './src/hooks/use_switch_organization.js';
export { useOrgInvitations } from './src/hooks/use_org_invitations.js';
export type {
  UseOrgInvitationsResult,
  OrgInvitationEntry,
} from './src/hooks/use_org_invitations.js';
export { jsonRequest, useResource } from './src/hooks/use_resource.js';
export type { ResourceState } from './src/hooks/use_resource.js';
export { usePasskeyAutofill } from './src/hooks/use_passkey_autofill.js';
export type { UsePasskeyAutofillOptions } from './src/hooks/use_passkey_autofill.js';
export { usePasskeyLogin } from './src/hooks/use_passkey_login.js';
export type {
  UsePasskeyLoginOptions,
  UsePasskeyLoginResult,
} from './src/hooks/use_passkey_login.js';
export {
  authenticatePasskey,
  registerPasskey,
  submitPasskeyVerification,
  loadStartAuthentication,
  loadStartRegistration,
} from './src/passkey/authenticate.js';
export type {
  AuthenticatePasskeyOptions,
  RegisterPasskeyOptions,
  SubmitPasskeyVerificationOptions,
  PasskeyCeremonyDeps,
  PasskeyRegistrationDeps,
  StartAuthenticationFn,
  StartRegistrationFn,
} from './src/passkey/authenticate.js';

// Headless: form clássico + "dance" de sudo/passkey para telas React próprias.
export { submitClassicForm } from './src/passkey/classic_form.js';
export type {
  SubmitClassicFormOptions,
  SubmitClassicFormDeps,
} from './src/passkey/classic_form.js';
export { runPasskeyAssertion, runPasskeyRegistration } from './src/passkey/sudo.js';
export type {
  RunPasskeyFlowOptions,
  RunPasskeyAssertionDeps,
  RunPasskeyRegistrationDeps,
} from './src/passkey/sudo.js';
export { usePasskeyAssertion } from './src/hooks/use_passkey_assertion.js';
export type {
  UsePasskeyAssertionOptions,
  UsePasskeyAssertionResult,
} from './src/hooks/use_passkey_assertion.js';
export { usePasskeyRegistration } from './src/hooks/use_passkey_registration.js';
export type {
  UsePasskeyRegistrationOptions,
  UsePasskeyRegistrationResult,
} from './src/hooks/use_passkey_registration.js';
export {
  usePasswordStrength,
  heuristicScorer,
} from './src/hooks/use_password_strength.js';
export type {
  PasswordStrengthScore,
  PasswordStrengthResult,
  PasswordScorer,
  UsePasswordStrengthOptions,
} from './src/hooks/use_password_strength.js';

// utilitários puros
export { deriveInitials, currentUrl, buttonClass } from './src/utils.js';

// URLs de interaction (builders tipados)
export { interactionUrls, oauthRedirectUrl, OTP_CODE_FIELD } from './src/interaction/urls.js';
export type {
  InteractionUrls,
  InteractionPostStep,
} from './src/interaction/urls.js';

// Componentes de gating
export { Authenticated, Guest } from './src/components/authenticated.js';
export type {
  AuthenticatedProps,
  GuestProps,
} from './src/components/authenticated.js';
export { CanPermission } from './src/components/can_permission.js';
export type { CanPermissionProps } from './src/components/can_permission.js';
export { useCan, checkCan, invalidateCanCache } from './src/hooks/use_can.js';
export type { UseCanResult } from './src/hooks/use_can.js';

// Componentes prontos
export { SignInButton } from './src/components/sign_in_button.js';
export type { SignInButtonProps } from './src/components/sign_in_button.js';
export { SignOutButton } from './src/components/sign_out_button.js';
export type { SignOutButtonProps } from './src/components/sign_out_button.js';
export { Avatar } from './src/components/avatar.js';
export type { AvatarProps } from './src/components/avatar.js';
export { UserButton } from './src/components/user_button.js';
export type { UserButtonProps } from './src/components/user_button.js';
export { UserProfile } from './src/components/user_profile.js';
export type { UserProfileProps } from './src/components/user_profile.js';
export { AuthorizedApps } from './src/components/authorized_apps.js';
export type { AuthorizedAppsProps } from './src/components/authorized_apps.js';
export { PasswordStrengthMeter } from './src/components/password_strength_meter.js';
export type { PasswordStrengthMeterProps } from './src/components/password_strength_meter.js';
export { PasskeyButton } from './src/components/passkey_button.js';
export type { PasskeyButtonProps } from './src/components/passkey_button.js';
export { InteractionForm } from './src/components/interaction_form.js';
export type { InteractionFormProps } from './src/components/interaction_form.js';
export { MagicLinkButton } from './src/components/magic_link_button.js';
export type { MagicLinkButtonProps } from './src/components/magic_link_button.js';
export { OAuthButton } from './src/components/oauth_button.js';
export type { OAuthButtonProps } from './src/components/oauth_button.js';
export { OrganizationSwitcher } from './src/components/organization_switcher.js';
export type { OrganizationSwitcherProps } from './src/components/organization_switcher.js';
export { OrganizationProfile } from './src/components/organization_profile.js';
export type { OrganizationProfileProps } from './src/components/organization_profile.js';
export { KeyRotation } from './src/components/key_rotation.js';
export type { KeyRotationProps } from './src/components/key_rotation.js';

// helpers de papéis (puros)
export {
  hasGlobalRole,
  hasAnyGlobalRole,
  hasAllGlobalRoles,
} from './src/roles.js';
export type { AuthUser, AuthSharedProps, AuthState } from './src/types.js';

// ─── Client tipado ────────────────────────────────────────────────────────────
export {
  createAuthkitClient,
  AuthkitClientError,
} from './src/client/client.js';
export type {
  AuthkitClient,
  AuthkitClientOptions,
} from './src/client/client.js';

// Tipos das superfícies do client (desacoplados do server)
export type {
  // Admin – Usuários
  AdminUser,
  AdminUserListResult,
  CreateUserInput,
  UpdateUserInput,
  UserSessionsResult,
  RevokeSessionsResult,
  AdminSessionEntry,
  AdminGrantEntry,
  // Admin – Clients
  AdminClient,
  AdminClientListResult,
  CreatedClientResult,
  RegenerateSecretResult,
  CreateClientInput,
  UpdateClientInput,
  // Admin – Roles
  RoleCatalogEntry,
  RoleListResult,
  CreateRoleInput,
  UpdateRoleInput,
  // Admin – Orgs
  AdminOrgEntry,
  AdminOrgMember,
  AdminOrgInvitation,
  AdminOrgDetail,
  AdminOrgListResult,
  CreateOrgInput,
  UpdateOrgInput,
  // Admin – Audit
  AuditEventEntry,
  AuditListResult,
  AuditListParams,
  // Admin – Settings
  SettingEntry,
  SettingListResult,
  // Admin – Impersonation
  ImpersonationPanel,
  // Admin – Overview
  DailyPoint,
  AdminOverview,
  // Account – Me / Security
  AccountCapabilities,
  AccountMe,
  AccountSecurityOverview,
  AccountSessionEntry,
  // Account – Sessions
  AccountSessionsResult,
  RevokeSessionResult,
  RevokeOthersResult,
  RevokeAllResult,
  // Account – Apps
  AccountAppEntry,
  AccountAppsResult,
  RevokeAppResult,
  // Account – MFA / Passkeys
  PasskeySummaryEntry,
  AccountMfaStatus,
  AccountPasskeysResult,
  RemovePasskeyResult,
  // Account – Login methods (preferência por usuário de tipos de login)
  AccountLoginMethodsResult,
  UpdateLoginMethodsResult,
  UserLoginMethodsInput,
  // Account – Tokens
  PatEntry,
  CreatedPatResult,
  AccountTokensResult,
  CreateTokenInput,
  RevokeTokenResult,
  // Account – Perfil
  UpdateProfileInput,
  UpdateProfileResult,
  // Account – Senha / E-mail
  ChangePasswordInput,
  RequestEmailChangeInput,
  OkResult,
  EmailChangeResult,
  // Account – Orgs
  AccountOrgEntry,
  AccountOrgsResult,
  AccountOrgDetail,
  AccountOrgInvitationsResult,
  ApiErrorBody,
  // Admin – Keys
  KeysStatus,
  ManagedKeyInfo,
  KeysRotateInput,
  KeysRotateResult,
} from './src/client/types.js';

// ─── Provider do client ───────────────────────────────────────────────────────
export {
  AuthkitClientProvider,
  useAuthkitClient,
  createAuthkitQueryClient,
} from './src/client/context.js';
export type { AuthkitClientProviderProps } from './src/client/context.js';

// ─── Query keys ───────────────────────────────────────────────────────────────
export { authkitKeys } from './src/queries/keys.js';

// ─── Hooks TanStack Query — Admin ─────────────────────────────────────────────
export {
  // Overview
  useOverviewQueryOptions,
  // Users
  useUsersQueryOptions,
  useUserQueryOptions,
  useUserSessionsQueryOptions,
  useCreateUserMutationOptions,
  useUpdateUserMutationOptions,
  useDisableUserMutationOptions,
  useEnableUserMutationOptions,
  useResetPasswordMutationOptions,
  useDeleteUserMutationOptions,
  useRevokeUserSessionsMutationOptions,
  // Sessions
  useSessionsQueryOptions,
  useRevokeAllSessionsMutationOptions,
  // Clients
  useClientsQueryOptions,
  useClientQueryOptions,
  useCreateClientMutationOptions,
  useUpdateClientMutationOptions,
  useDeleteClientMutationOptions,
  useRegenerateClientSecretMutationOptions,
  // Roles
  useRolesQueryOptions,
  useCreateRoleMutationOptions,
  useUpdateRoleMutationOptions,
  useDeleteRoleMutationOptions,
  // Orgs
  useOrgsQueryOptions,
  useOrgQueryOptions,
  useCreateOrgMutationOptions,
  useUpdateOrgMutationOptions,
  useDeleteOrgMutationOptions,
  useAddOrgMemberMutationOptions,
  useRemoveOrgMemberMutationOptions,
  useUpdateOrgMemberRoleMutationOptions,
  useCreateOrgInvitationMutationOptions,
  useRevokeOrgInvitationMutationOptions,
  // Audit
  useAuditQueryOptions,
  // Settings
  useSettingsQueryOptions,
  useSetSettingMutationOptions,
  useRemoveSettingMutationOptions,
  // Impersonation
  useImpersonationQueryOptions,
  // Keys
  useKeysQueryOptions,
  useRotateKeysMutationOptions,
} from './src/queries/admin/index.js';

// ─── Hooks TanStack Query — Account ──────────────────────────────────────────
export {
  // Me / Security
  useMeQueryOptions,
  useSecurityQueryOptions,
  // Profile
  useUpdateProfileMutationOptions,
  // Password
  useChangePasswordMutationOptions,
  // Email change
  useEmailChangeMutationOptions,
  useCancelEmailChangeMutationOptions,
  // Sessions
  useAccountSessionsQueryOptions,
  useRevokeSessionMutationOptions,
  useRevokeOtherSessionsMutationOptions,
  useAccountRevokeAllSessionsMutationOptions,
  // Apps
  useAppsQueryOptions,
  useRevokeAppMutationOptions,
  // MFA
  useMfaQueryOptions,
  // Login methods (preferência por usuário de tipos de login)
  useLoginMethodsQueryOptions,
  useUpdateLoginMethodsMutationOptions,
  // Passkeys
  usePasskeysQueryOptions,
  useRemovePasskeyMutationOptions,
  // Tokens
  useTokensQueryOptions,
  useCreateTokenMutationOptions,
  useRevokeTokenMutationOptions,
  // Orgs
  useAccountOrgsQueryOptions,
  useAccountOrgQueryOptions,
  useAccountOrgInvitationsQueryOptions,
} from './src/queries/account/index.js';
