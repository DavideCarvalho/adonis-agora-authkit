/**
 * Configure hook + stubsRoot resolvidos pelo `node ace configure @adonis-agora/authkit-server`.
 * O comando do AdonisJS importa o entrypoint principal e procura por estes exports.
 */
export { configure } from './commands/configure.js';
export type {
  AccountDeletionCapability,
  AccountImportCapability,
  AccountSecurityCapability,
  AccountStatusCapability,
  AccountStore,
  ActiveOrgInfo,
  AdminCapability,
  AuthAccount,
  CoreAccountStore,
  CreateAccountInput,
  EmailVerificationStatusCapability,
  ImportAccountInput,
  LinkProviderIdentityInput,
  ListAccountsParams,
  LoginMethodsPreferenceCapability,
  MagicLinkCapability,
  MfaCapability,
  OrganizationsCapability,
  OrgInvitation,
  OrgMember,
  OrgSummary,
  OtpLoginCapability,
  OtpLoginVerifyResult,
  Paginated,
  PasskeySummary,
  ProfileCapability,
  ProviderIdentityCapability,
  ProviderIdentitySummary,
  WebauthnCapability,
} from './src/accounts/account_store.js';
export {
  supportsAccountDeletion,
  supportsAccountImport,
  supportsAccountSecurity,
  supportsAccountStatus,
  supportsEmailVerificationStatus,
  supportsLoginMethodsPreference,
  supportsMagicLink,
  supportsMfa,
  supportsOrganizations,
  supportsOtpLogin,
  supportsPasskeys,
  supportsProfile,
  supportsProviderIdentity,
} from './src/accounts/account_store.js';
export type {
  AccountSecretEncrypter,
  LucidAccountStoreOptions,
} from './src/accounts/lucid_account_store.js';
export { appKeyEncrypter, lucidAccountStore } from './src/accounts/lucid_account_store.js';
export type {
  LucidStoresModels,
  LucidStoresOptions,
  LucidStoresResult,
} from './src/accounts/lucid_stores.js';
export { lucidStores } from './src/accounts/lucid_stores.js';
export type {
  AuditEvent,
  AuditEventType,
  AuditPage,
  AuditSink,
  ListAuditParams,
  StoredAuditEvent,
} from './src/audit/audit_sink.js';
export { lucidAuditSink } from './src/audit/lucid_audit_sink.js';
export type {
  AdminApiConfigInput,
  AdminConfigInput,
  AuthHostRenderer,
  AuthMethodsConfigInput,
  AuthServerConfigInput,
  AuthSocialConfig,
  DynamicRegistrationConfigInput,
  LoginConfigInput,
  OrganizationsConfigInput,
  PasswordlessConfigInput,
  RateLimitBucket,
  RateLimitConfigInput,
  RegistrationConfigInput,
  ResolvedAdminApiConfig,
  ResolvedAdminConfig,
  ResolvedAuthMethodsConfig,
  ResolvedDynamicRegistrationConfig,
  ResolvedLoginConfig,
  ResolvedNotificationsConfig,
  ResolvedOrganizationsConfig,
  ResolvedPasswordlessConfig,
  ResolvedRateLimitConfig,
  ResolvedRegistrationConfig,
  ResolvedServerConfig,
  ResolvedWebauthnConfig,
  WebauthnConfigInput,
} from './src/define_config.js';
export {
  adapters,
  defineConfig,
  resolveAdmin,
  resolveAdminApi,
  resolveAuthMethodsConfig,
  resolveDynamicRegistration,
  resolveLogin,
  resolveNotifications,
  resolveOrganizations,
  resolvePasswordless,
  resolveRateLimit,
  resolveRegistration,
  resolveWebauthn,
  toSeconds,
} from './src/define_config.js';
export type { EventsConfigInput, ResolvedEventsConfig } from './src/events/dispatcher.js';
export {
  buildWebhookBody,
  composeAuditSink,
  resolveEvents,
  signWebhookBody,
} from './src/events/dispatcher.js';
export type {
  DeletionActor,
  DeletionResult,
} from './src/host/account_deletion_service.js';
export { AccountDeletionService } from './src/host/account_deletion_service.js';
export type { AccountExport } from './src/host/account_export_service.js';
export { AccountExportService } from './src/host/account_export_service.js';
export type { AccountPathKey, AccountPathsOptions } from './src/host/account_paths.js';
/**
 * Helpers de path do console de conta (`/account/*`). Um host que precisa casar
 * um middleware ou link com uma rota do console (ex.: `GET
 * {accountPath('security')}/export`) deriva o path daqui em vez de hardcodar,
 * respeitando os overrides de `accountRoutes`.
 *
 * ⚠️ Estes helpers leem um singleton de processo que só reflete os overrides
 * DEPOIS que `registerAuthHost` roda (é ele quem chama `setAccountPaths` com a
 * opção `accountRoutes`, no boot). Chamados antes disso, devolvem os defaults
 * (`/account/*`). Componha URLs em runtime (dentro de handlers/factories de
 * middleware), não em tempo de import de módulo.
 */
export {
  accountPath,
  accountPrefix,
  joinAccountPath,
} from './src/host/account_paths.js';
// Tipos de props das telas de conta — a fonte única para hosts que escrevem as
// telas do console em React próprio (via `inertiaRenderer`). Os controllers
// satisfazem estes mesmos tipos ao renderizar, então divergir quebra o build.
export type {
  AccountConfirmMethod,
  AccountConfirmProps,
  AccountEmailConfirmedProps,
  AccountLoginProps,
  AccountMfaProps,
  AccountSecurityProps,
} from './src/host/account_screen_props.js';
export { ACCOUNT_SESSION_KEY } from './src/host/account_session_key.js';
// Organizations (multi-tenancy)
export {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_COOKIE_TTL,
  decodeActiveOrgCookie,
  encodeActiveOrgCookie,
  readActiveOrgFromKoaCtx,
} from './src/host/active_org_cookie.js';
export type {
  AddMemberInput as AdminAddMemberInput,
  CreateInvitationInput as AdminCreateInvitationInput,
  CreateOrgInput as AdminCreateOrgInput,
  OrgDetail,
  OrgWithMemberCount,
  UpdateOrgInput as AdminUpdateOrgInput,
} from './src/host/admin_api/admin_orgs_service.js';
export { AdminOrgsService } from './src/host/admin_api/admin_orgs_service.js';
export type {
  AdminActor,
  CreateUserInput as AdminCreateUserInput,
  CreateUserResult as AdminCreateUserResult,
  DeleteUserResult as AdminDeleteUserResult,
} from './src/host/admin_api/admin_users_service.js';
/**
 * Admin services compartilhados pelo console (B6/HTML), pela Admin REST API (R6)
 * e pelo driver `embedded` do @adonis-agora/authkit-sdk (in-process).
 */
export { AdminUsersService } from './src/host/admin_api/admin_users_service.js';
export type { VerifyResult } from './src/host/admin_api/token_verify_service.js';
export { TokenVerifyService } from './src/host/admin_api/token_verify_service.js';
export type {
  AdminClient,
  ClientInput as AdminClientInput,
  CreatedClient,
  TokenEndpointAuthMethod,
} from './src/host/admin_clients_service.js';
export { AdminClientsService } from './src/host/admin_clients_service.js';
export {
  getAdminApiPrefix,
  getAdminPrefix,
  normalizeAdminApiPrefix,
  normalizeAdminPrefix,
  setAdminApiPrefix,
  setAdminPrefix,
} from './src/host/admin_prefix.js';
export type {
  AdminGrant,
  AdminSession,
  RevokeResult,
} from './src/host/admin_sessions_service.js';
export { AdminSessionsService } from './src/host/admin_sessions_service.js';
export type { AdminStats, DailyPoint } from './src/host/admin_stats_service.js';
export { computeAdminStats } from './src/host/admin_stats_service.js';
// @adonisjs/auth integration (opt-in) — user provider for config/auth.ts's
// sessionGuard(), backed by authkit's own accountStore. Pair with
// `adonisAuth: { guard: '...' }` in config/authkit.ts so the account console's
// login/logout also sync ctx.auth. See src/host/adonis_auth_user_provider.ts.
export { authkitUserProvider } from './src/host/adonis_auth_user_provider.js';
export type {
  BotProtectionAction,
  BotProtectionConfigInput,
  BotProtectionSetting,
  BotProtectionVerifyInput,
  BotProtectionWidget,
  ResolvedBotProtectionConfig,
} from './src/host/bot_protection.js';
export {
  botProtectionApplies,
  DEFAULT_BOT_TOKEN_FIELDS,
  extractBotToken,
  guardBotProtection,
  resolveBotProtection,
  resolveEffectiveBotProtection,
  verifyBotProtection,
} from './src/host/bot_protection.js';
export type { BrandingConfig, ClientBrand } from './src/host/branding.js';
export { brandFor, isFirstParty, isFirstPartyClient } from './src/host/branding.js';
export type { PolicyRouteOption } from './src/host/config_locks.js';
export {
  deriveLockedSettingKeys,
  isSettingLocked,
  lockedSettingKeys,
  POLICY_ROUTE_OPTIONS,
  resetLockedSettingKeys,
  SettingLockedError,
  setLockedSettingKeys,
} from './src/host/config_locks.js';
export {
  consoleLoginUrl,
  getAccountId,
  hasAccountSession,
  realAccountId,
} from './src/host/console_session.js';
export type { AuthkitCsrfOptions } from './src/host/csrf.js';
export { authkitCsrfExceptions } from './src/host/csrf.js';
export type { ResolveGeo } from './src/host/geo.js';
export { GEO_RESOLVE_TIMEOUT_MS, resolveGeoSafe } from './src/host/geo.js';
export type { AuthMessages, I18nConfig } from './src/host/i18n.js';
export {
  BUILTIN_MESSAGES,
  DEFAULT_LOCALE,
  DEFAULT_MESSAGES,
  PT_BR_MESSAGES,
  resolveMessages,
  translate,
} from './src/host/i18n.js';
export type { ImpersonationClientLike, ImpersonationPanel } from './src/host/impersonation.js';
export { buildImpersonationPanel } from './src/host/impersonation.js';
export type {
  ImpersonationState,
  StartImpersonationParams,
} from './src/host/impersonation_session.js';
// Session impersonation — RP-side glue that routes through the IdP's RFC 8693
// token-exchange (the IdP validates the admin role + audits). See
// src/host/impersonation_session.ts.
export {
  impersonationState,
  refreshAccessToken,
  rememberAccessToken,
  rememberRefreshToken,
  startImpersonation,
  stopImpersonation,
} from './src/host/impersonation_session.js';
export type { KeysStatus as ServerKeysStatus } from './src/host/key_rotation_actions.js';
// Key rotation actions — shared between the Admin REST API controller and the SDK embedded driver.
export { buildKeysStatus, rotateNow } from './src/host/key_rotation_actions.js';
export type { OidcRpGuardEvents, OidcRpGuardOptions } from './src/host/oidc_rp_guard.js';
// @adonisjs/auth integration (opt-in) — guard pra Relying Parties OIDC.
// O RP não autentica ninguém (sem senha); a identidade vem da sessão gravada
// pelo callback OIDC. Plugado em config/auth.ts, faz ctx.auth.user funcionar
// nativamente em qualquer app que consome o issuer via Authorization Code + PKCE.
export { OidcRpGuard, oidcRpGuard } from './src/host/oidc_rp_guard.js';
// Login por OTP (código digitável): config + helpers puros.
export {
  evaluateLoginOtp,
  generateOtpCode,
  OTP_LOGIN_DEFAULTS,
  type OtpLoginConfigInput,
  type OtpVerifyOutcome,
  type ResolvedOtpLoginConfig,
  resolveOtpLoginConfig,
} from './src/host/otp_login.js';
export type { AuthThrottles, ThrottleMiddleware } from './src/host/rate_limit.js';
export { createAuthThrottles } from './src/host/rate_limit.js';
export type {
  AccountScreensOptions,
  AuthHostOptions,
  AuthHostRouteMap,
} from './src/host/register_auth_host.js';
export { registerAuthHost } from './src/host/register_auth_host.js';
export { edgeRenderer } from './src/host/renderers/edge_renderer.js';
export type {
  AuthkitScreen,
  InertiaRendererOptions,
} from './src/host/renderers/inertia_renderer.js';
export { inertiaRenderer } from './src/host/renderers/inertia_renderer.js';
export type {
  RuntimeSettingsOptions,
  SettingRow,
  SettingsCapability,
} from './src/host/runtime_settings.js';
// Runtime settings (capability-probed, optional table `auth_settings`).
export { RuntimeSettings, supportsSettings } from './src/host/runtime_settings.js';
export type {
  AuthMethodsCapabilities,
  AuthMethodsConfigOverride,
  AuthMethodsSetting,
  MaintenanceModeSetting,
  RegistrationSetting,
  RequireVerifiedEmailSetting,
  ResolvedAuthMethods,
  ResolvedMaintenanceMode,
  SettingKey,
} from './src/host/runtime_toggles.js';
// Runtime toggles (registration, require_verified_email, maintenance_mode).
export {
  configLockedAuthMethods,
  resolveEffectiveAuthMethods,
  resolveEffectiveMaintenanceMode,
  resolveEffectiveRegistration,
  resolveEffectiveRequireVerifiedEmail,
  SETTING_KEYS,
} from './src/host/runtime_toggles.js';
// Contexto de sessão (user-agent/geo) + métricas do dashboard.
export { enrichSessionsWithContext } from './src/host/session_context.js';
// SPI de métodos de confirmação de identidade (sudo mode).
//
// `completeSudo` é público porque o host PRECISA chamá-lo: o `oidcStepUp` não
// registra rotas — quem valida o grant é o callback do host, e é lá que a
// concessão acontece. Sem exportá-lo, o host improvisaria com `markSudo` e
// perderia o audit `sudo.confirmed`, a preferência de método e o redirect para
// o `return_to`.
export { sudoMethods } from './src/host/sudo/index.js';
// Montador do `SudoContext` que `completeSudo`/`failSudo` recebem. Exportado
// junto porque sem ele o host teria de montar o contexto na mão (resolver o
// service do container, carregar a conta, validar o `return_to`) — e um
// `returnTo` montado na mão é um open redirect esperando acontecer.
export {
  completeSudo,
  fail as failSudo,
  LAST_METHOD_SESSION_KEY,
  sudoContextFrom,
} from './src/host/sudo/runtime.js';
export type {
  SudoContext,
  SudoMethod,
  SudoMethodDescriptor,
  SudoRouteHelpers,
} from './src/host/sudo/types.js';
export type {
  ResolvedSudoModeSetting,
  SudoModeSetting,
} from './src/host/sudo_mode.js';
// Sudo mode — helpers for host controllers that require step-up authentication.
export {
  isSudoActive,
  markSudo,
  requireSudo,
  resolveEffectiveSudoMode,
  SUDO_ACCOUNT_SESSION_KEY,
  SUDO_MODE_DEFAULTS,
  SUDO_SESSION_KEY,
} from './src/host/sudo_mode.js';
export { barChartSvg } from './src/host/svg_chart.js';
export type {
  ResolvedTrustedDevicesConfig,
  TrustedDevicePayload,
  TrustedDevicesConfigInput,
} from './src/host/trusted_device.js';
export {
  buildTrustedDevicePayload,
  isTrustedDeviceValid,
  resolveTrustedDevices,
  TRUSTED_DEVICE_COOKIE,
} from './src/host/trusted_device.js';
export type { ParsedUserAgent } from './src/host/user_agent.js';
export { parseUserAgent } from './src/host/user_agent.js';
export type {
  ResolvedUserLoginMethods,
  UserLoginMethodKey,
  UserLoginMethods,
} from './src/host/user_login_methods.js';
// Tipos de login POR USUÁRIO (self-service no console de conta).
export {
  normalizeUserLoginMethods,
  parseUserLoginMethodsPayload,
  resolveEffectiveUserLoginMethods,
  USER_LOGIN_METHOD_KEYS,
} from './src/host/user_login_methods.js';
export { withAuditLog } from './src/mixins/with_audit_log.js';
export { withAuthUser } from './src/mixins/with_auth_user.js';
export { withCredentials } from './src/mixins/with_credentials.js';
export { withMfa } from './src/mixins/with_mfa.js';
export { withPersonalAccessToken } from './src/mixins/with_personal_access_token.js';
export type {
  ProviderIdentityClass,
  ProviderIdentityRow,
} from './src/mixins/with_provider_identity.js';
export { withProviderIdentity } from './src/mixins/with_provider_identity.js';
export type {
  WebauthnCredentialClass,
  WebauthnCredentialRow,
} from './src/mixins/with_webauthn_credential.js';
export { withWebauthnCredential } from './src/mixins/with_webauthn_credential.js';
export type {
  LegacyPasswordVerifier,
  PasswordConfigInput,
  PasswordVerifyResult,
} from './src/password/password_manager.js';
// Gerência de senha: lazy rehash + legacy verifier, política e checagem de vazamento.
export {
  PasswordManager,
  PasswordPolicyError,
} from './src/password/password_manager.js';
export type {
  PasswordPolicyViolation,
  ResolvedPasswordConfig,
  ResolvedPasswordPolicy,
} from './src/password/policy.js';
export {
  checkPasswordPolicy,
  DEFAULT_PWNED_TIMEOUT_MS,
  policyViolationParams,
} from './src/password/policy.js';
export type { FetchLike as PwnedFetchLike, PwnedLogger } from './src/password/pwned.js';
export {
  __setFetchForTests as __setPwnedFetchForTests,
  isPasswordPwned,
} from './src/password/pwned.js';
export { lucidPatStore } from './src/pat/lucid_pat_store.js';
export type { IssuePatInput, PatRecord, PatStore } from './src/pat/pat_store.js';
export { generatePatToken, hashPatToken } from './src/pat/pat_tokens.js';
export { OidcService } from './src/provider/oidc_service.js';
export { registerOidcRoutes } from './src/register_routes.js';
export type { EnsureSchemaOptions, EnsureSchemaReport } from './src/schema/ensure.js';
export { ensureAuthkitSchema } from './src/schema/ensure.js';
export { stubsRoot } from './stubs/main.js';
