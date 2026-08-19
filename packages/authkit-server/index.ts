export { ensureAuthkitSchema } from './src/schema/ensure.js';
export { authkitCsrfExceptions } from './src/host/csrf.js';
export type { AuthkitCsrfOptions } from './src/host/csrf.js';
export {
  SettingLockedError,
  isSettingLocked,
  lockedSettingKeys,
  setLockedSettingKeys,
  resetLockedSettingKeys,
  deriveLockedSettingKeys,
} from './src/host/config_locks.js';
export type { EnsureSchemaOptions, EnsureSchemaReport } from './src/schema/ensure.js';
export { defineConfig, adapters, toSeconds } from './src/define_config.js';
export { generatePatToken, hashPatToken } from './src/pat/pat_tokens.js';
export { withAuthUser } from './src/mixins/with_auth_user.js';
export { withCredentials } from './src/mixins/with_credentials.js';
export { withMfa } from './src/mixins/with_mfa.js';
export { OidcService } from './src/provider/oidc_service.js';
export { registerOidcRoutes } from './src/register_routes.js';
export type {
  AuthServerConfigInput,
  ResolvedServerConfig,
  DynamicRegistrationConfigInput,
  ResolvedDynamicRegistrationConfig,
  AdminConfigInput,
  ResolvedAdminConfig,
  AdminApiConfigInput,
  ResolvedAdminApiConfig,
} from './src/define_config.js';
export {
  resolveAdmin,
  resolveAdminApi,
  resolveWebauthn,
  resolveDynamicRegistration,
} from './src/define_config.js';
export type { WebauthnConfigInput, ResolvedWebauthnConfig } from './src/define_config.js';
export {
  resolvePasswordless,
  resolveLogin,
  resolveAuthMethodsConfig,
} from './src/define_config.js';
export type {
  PasswordlessConfigInput,
  ResolvedPasswordlessConfig,
  AuthMethodsConfigInput,
  ResolvedAuthMethodsConfig,
  LoginConfigInput,
  ResolvedLoginConfig,
} from './src/define_config.js';
export {
  resolveTrustedDevices,
  isTrustedDeviceValid,
  buildTrustedDevicePayload,
  TRUSTED_DEVICE_COOKIE,
} from './src/host/trusted_device.js';
export type {
  TrustedDevicesConfigInput,
  ResolvedTrustedDevicesConfig,
  TrustedDevicePayload,
} from './src/host/trusted_device.js';
export {
  resolveBotProtection,
  botProtectionApplies,
  extractBotToken,
  verifyBotProtection,
  guardBotProtection,
  DEFAULT_BOT_TOKEN_FIELDS,
} from './src/host/bot_protection.js';
export type {
  BotProtectionConfigInput,
  ResolvedBotProtectionConfig,
  BotProtectionVerifyInput,
  BotProtectionWidget,
  BotProtectionAction,
} from './src/host/bot_protection.js';
export { lucidAccountStore, appKeyEncrypter } from './src/accounts/lucid_account_store.js';
export { lucidStores } from './src/accounts/lucid_stores.js';
export type {
  LucidStoresModels,
  LucidStoresOptions,
  LucidStoresResult,
} from './src/accounts/lucid_stores.js';
export type {
  LucidAccountStoreOptions,
  AccountSecretEncrypter,
} from './src/accounts/lucid_account_store.js';
export type {
  AccountStore,
  CoreAccountStore,
  AdminCapability,
  MfaCapability,
  WebauthnCapability,
  ProviderIdentityCapability,
  ProviderIdentitySummary,
  AccountSecurityCapability,
  AccountStatusCapability,
  ProfileCapability,
  MagicLinkCapability,
  OtpLoginCapability,
  OtpLoginVerifyResult,
  EmailVerificationStatusCapability,
  AccountDeletionCapability,
  AccountImportCapability,
  ImportAccountInput,
  AuthAccount,
  CreateAccountInput,
  LinkProviderIdentityInput,
  ListAccountsParams,
  Paginated,
  PasskeySummary,
} from './src/accounts/account_store.js';
export {
  supportsMfa,
  supportsPasskeys,
  supportsProviderIdentity,
  supportsAccountSecurity,
  supportsAccountStatus,
  supportsProfile,
  supportsMagicLink,
  supportsOtpLogin,
  supportsEmailVerificationStatus,
  supportsAccountDeletion,
  supportsAccountImport,
} from './src/accounts/account_store.js';
// Login por OTP (código digitável): config + helpers puros.
export {
  type OtpLoginConfigInput,
  type ResolvedOtpLoginConfig,
  type OtpVerifyOutcome,
  resolveOtpLoginConfig,
  generateOtpCode,
  evaluateLoginOtp,
  OTP_LOGIN_DEFAULTS,
} from './src/host/otp_login.js';
// Gerência de senha: lazy rehash + legacy verifier, política e checagem de vazamento.
export {
  PasswordManager,
  PasswordPolicyError,
} from './src/password/password_manager.js';
export type {
  PasswordConfigInput,
  LegacyPasswordVerifier,
  PasswordVerifyResult,
} from './src/password/password_manager.js';
export {
  checkPasswordPolicy,
  policyViolationParams,
  DEFAULT_PWNED_TIMEOUT_MS,
} from './src/password/policy.js';
export type {
  ResolvedPasswordPolicy,
  ResolvedPasswordConfig,
  PasswordPolicyViolation,
} from './src/password/policy.js';
export {
  isPasswordPwned,
  __setFetchForTests as __setPwnedFetchForTests,
} from './src/password/pwned.js';
export type { PwnedLogger, FetchLike as PwnedFetchLike } from './src/password/pwned.js';
export { withProviderIdentity } from './src/mixins/with_provider_identity.js';
export type {
  ProviderIdentityRow,
  ProviderIdentityClass,
} from './src/mixins/with_provider_identity.js';
export { withWebauthnCredential } from './src/mixins/with_webauthn_credential.js';
export type {
  WebauthnCredentialRow,
  WebauthnCredentialClass,
} from './src/mixins/with_webauthn_credential.js';
export { lucidPatStore } from './src/pat/lucid_pat_store.js';
export type { PatStore, PatRecord, IssuePatInput } from './src/pat/pat_store.js';
export { withPersonalAccessToken } from './src/mixins/with_personal_access_token.js';
export { lucidAuditSink } from './src/audit/lucid_audit_sink.js';
export type {
  AuditSink,
  AuditEvent,
  AuditEventType,
  StoredAuditEvent,
  ListAuditParams,
  AuditPage,
} from './src/audit/audit_sink.js';
export { withAuditLog } from './src/mixins/with_audit_log.js';
export {
  composeAuditSink,
  resolveEvents,
  buildWebhookBody,
  signWebhookBody,
} from './src/events/dispatcher.js';
export type { EventsConfigInput, ResolvedEventsConfig } from './src/events/dispatcher.js';
export { inertiaRenderer } from './src/host/renderers/inertia_renderer.js';
export type { AuthkitScreen } from './src/host/renderers/inertia_renderer.js';
export type { InertiaRendererOptions } from './src/host/renderers/inertia_renderer.js';
// Tipos de props das telas de conta — a fonte única para hosts que escrevem as
// telas do console em React próprio (via `inertiaRenderer`). Os controllers
// satisfazem estes mesmos tipos ao renderizar, então divergir quebra o build.
export type {
  AccountLoginProps,
  AccountSecurityProps,
  AccountMfaProps,
  AccountConfirmProps,
  AccountConfirmMethod,
  AccountEmailConfirmedProps,
} from './src/host/account_screen_props.js';
export { edgeRenderer } from './src/host/renderers/edge_renderer.js';
export { brandFor, isFirstParty, isFirstPartyClient } from './src/host/branding.js';
export type { BrandingConfig, ClientBrand } from './src/host/branding.js';
export {
  resolveMessages,
  translate,
  DEFAULT_MESSAGES,
  PT_BR_MESSAGES,
  BUILTIN_MESSAGES,
  DEFAULT_LOCALE,
} from './src/host/i18n.js';
export type { I18nConfig, AuthMessages } from './src/host/i18n.js';
export type { AuthHostRenderer, AuthSocialConfig } from './src/define_config.js';
export { registerAuthHost } from './src/host/register_auth_host.js';
export type {
  AuthHostOptions,
  AuthHostRouteMap,
  AccountScreensOptions,
} from './src/host/register_auth_host.js';
export type { PolicyRouteOption } from './src/host/config_locks.js';
export { POLICY_ROUTE_OPTIONS } from './src/host/config_locks.js';
export {
  getAdminPrefix,
  setAdminPrefix,
  normalizeAdminPrefix,
  getAdminApiPrefix,
  setAdminApiPrefix,
  normalizeAdminApiPrefix,
} from './src/host/admin_prefix.js';
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
  joinAccountPath,
  accountPrefix,
} from './src/host/account_paths.js';
export type { AccountPathsOptions, AccountPathKey } from './src/host/account_paths.js';
export { resolveRateLimit, resolveNotifications } from './src/define_config.js';
export type { ResolvedNotificationsConfig } from './src/define_config.js';
export type {
  RateLimitConfigInput,
  RateLimitBucket,
  ResolvedRateLimitConfig,
} from './src/define_config.js';
export { createAuthThrottles } from './src/host/rate_limit.js';
export type { AuthThrottles, ThrottleMiddleware } from './src/host/rate_limit.js';

/**
 * Admin services compartilhados pelo console (B6/HTML), pela Admin REST API (R6)
 * e pelo driver `embedded` do @adonis-agora/authkit-sdk (in-process).
 */
export { AdminUsersService } from './src/host/admin_api/admin_users_service.js';
export { AdminOrgsService } from './src/host/admin_api/admin_orgs_service.js';
export type {
  OrgWithMemberCount,
  OrgDetail,
  CreateOrgInput as AdminCreateOrgInput,
  UpdateOrgInput as AdminUpdateOrgInput,
  AddMemberInput as AdminAddMemberInput,
  CreateInvitationInput as AdminCreateInvitationInput,
} from './src/host/admin_api/admin_orgs_service.js';
export type {
  AdminActor,
  CreateUserInput as AdminCreateUserInput,
  CreateUserResult as AdminCreateUserResult,
  DeleteUserResult as AdminDeleteUserResult,
} from './src/host/admin_api/admin_users_service.js';
export { AccountDeletionService } from './src/host/account_deletion_service.js';
export type {
  DeletionActor,
  DeletionResult,
} from './src/host/account_deletion_service.js';
export { AccountExportService } from './src/host/account_export_service.js';
export type { AccountExport } from './src/host/account_export_service.js';
export { AdminClientsService } from './src/host/admin_clients_service.js';
export type {
  AdminClient,
  ClientInput as AdminClientInput,
  CreatedClient,
  TokenEndpointAuthMethod,
} from './src/host/admin_clients_service.js';
export { AdminSessionsService } from './src/host/admin_sessions_service.js';
export type {
  AdminSession,
  AdminGrant,
  RevokeResult,
} from './src/host/admin_sessions_service.js';
export { TokenVerifyService } from './src/host/admin_api/token_verify_service.js';
export type { VerifyResult } from './src/host/admin_api/token_verify_service.js';

// Contexto de sessão (user-agent/geo) + métricas do dashboard.
export { enrichSessionsWithContext } from './src/host/session_context.js';
export { parseUserAgent } from './src/host/user_agent.js';
export type { ParsedUserAgent } from './src/host/user_agent.js';
export { resolveGeoSafe, GEO_RESOLVE_TIMEOUT_MS } from './src/host/geo.js';
export type { ResolveGeo } from './src/host/geo.js';
export { computeAdminStats } from './src/host/admin_stats_service.js';
export type { AdminStats, DailyPoint } from './src/host/admin_stats_service.js';
export { barChartSvg } from './src/host/svg_chart.js';
export { buildImpersonationPanel } from './src/host/impersonation.js';
export type { ImpersonationPanel, ImpersonationClientLike } from './src/host/impersonation.js';

// Organizations (multi-tenancy)
export {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_COOKIE_TTL,
  encodeActiveOrgCookie,
  decodeActiveOrgCookie,
  readActiveOrgFromKoaCtx,
} from './src/host/active_org_cookie.js';
export { resolveOrganizations } from './src/define_config.js';
export type {
  OrganizationsConfigInput,
  ResolvedOrganizationsConfig,
} from './src/define_config.js';
export { supportsOrganizations } from './src/accounts/account_store.js';
export type {
  OrganizationsCapability,
  OrgSummary,
  OrgMember,
  OrgInvitation,
  ActiveOrgInfo,
} from './src/accounts/account_store.js';

/**
 * Configure hook + stubsRoot resolvidos pelo `node ace configure @adonis-agora/authkit-server`.
 * O comando do AdonisJS importa o entrypoint principal e procura por estes exports.
 */
export { configure } from './commands/configure.js';
export { stubsRoot } from './stubs/main.js';

// Runtime settings (capability-probed, optional table `auth_settings`).
export { RuntimeSettings, supportsSettings } from './src/host/runtime_settings.js';
export type {
  SettingsCapability,
  SettingRow,
  RuntimeSettingsOptions,
} from './src/host/runtime_settings.js';

// Key rotation actions — shared between the Admin REST API controller and the SDK embedded driver.
export { buildKeysStatus, rotateNow } from './src/host/key_rotation_actions.js';
export type { KeysStatus as ServerKeysStatus } from './src/host/key_rotation_actions.js';
export { resolveEffectiveBotProtection } from './src/host/bot_protection.js';
export type { BotProtectionSetting } from './src/host/bot_protection.js';

// Runtime toggles (registration, require_verified_email, maintenance_mode).
export {
  SETTING_KEYS,
  resolveEffectiveRegistration,
  resolveEffectiveRequireVerifiedEmail,
  resolveEffectiveMaintenanceMode,
  resolveEffectiveAuthMethods,
  configLockedAuthMethods,
} from './src/host/runtime_toggles.js';
export type {
  SettingKey,
  RegistrationSetting,
  RequireVerifiedEmailSetting,
  MaintenanceModeSetting,
  ResolvedMaintenanceMode,
  AuthMethodsSetting,
  ResolvedAuthMethods,
  AuthMethodsCapabilities,
  AuthMethodsConfigOverride,
} from './src/host/runtime_toggles.js';
export { resolveRegistration } from './src/define_config.js';
export type {
  RegistrationConfigInput,
  ResolvedRegistrationConfig,
} from './src/define_config.js';

export {
  getAccountId,
  realAccountId,
  hasAccountSession,
  consoleLoginUrl,
} from './src/host/console_session.js';
export { ACCOUNT_SESSION_KEY } from './src/host/middleware/account_auth.js';

// Session impersonation — RP-side glue that routes through the IdP's RFC 8693
// token-exchange (the IdP validates the admin role + audits). See
// src/host/impersonation_session.ts.
export {
  rememberAccessToken,
  rememberRefreshToken,
  refreshAccessToken,
  startImpersonation,
  impersonationState,
  stopImpersonation,
} from './src/host/impersonation_session.js';
export type {
  StartImpersonationParams,
  ImpersonationState,
} from './src/host/impersonation_session.js';

// Sudo mode — helpers for host controllers that require step-up authentication.
export {
  SUDO_SESSION_KEY,
  SUDO_ACCOUNT_SESSION_KEY,
  SUDO_MODE_DEFAULTS,
  requireSudo,
  isSudoActive,
  markSudo,
  resolveEffectiveSudoMode,
} from './src/host/sudo_mode.js';
export type {
  SudoModeSetting,
  ResolvedSudoModeSetting,
} from './src/host/sudo_mode.js';

// SPI de métodos de confirmação de identidade (sudo mode).
//
// `completeSudo` é público porque o host PRECISA chamá-lo: o `oidcStepUp` não
// registra rotas — quem valida o grant é o callback do host, e é lá que a
// concessão acontece. Sem exportá-lo, o host improvisaria com `markSudo` e
// perderia o audit `sudo.confirmed`, a preferência de método e o redirect para
// o `return_to`.
export { sudoMethods } from './src/host/sudo/index.js';
export {
  completeSudo,
  fail as failSudo,
  LAST_METHOD_SESSION_KEY,
} from './src/host/sudo/runtime.js';
// Montador do `SudoContext` que `completeSudo`/`failSudo` recebem. Exportado
// junto porque sem ele o host teria de montar o contexto na mão (resolver o
// service do container, carregar a conta, validar o `return_to`) — e um
// `returnTo` montado na mão é um open redirect esperando acontecer.
export { sudoContextFrom } from './src/host/sudo/runtime.js';
export type {
  SudoMethod,
  SudoContext,
  SudoMethodDescriptor,
  SudoRouteHelpers,
} from './src/host/sudo/types.js';

// @adonisjs/auth integration (opt-in) — user provider for config/auth.ts's
// sessionGuard(), backed by authkit's own accountStore. Pair with
// `adonisAuth: { guard: '...' }` in config/authkit.ts so the account console's
// login/logout also sync ctx.auth. See src/host/adonis_auth_user_provider.ts.
export { authkitUserProvider } from './src/host/adonis_auth_user_provider.js';

// @adonisjs/auth integration (opt-in) — guard pra Relying Parties OIDC.
// O RP não autentica ninguém (sem senha); a identidade vem da sessão gravada
// pelo callback OIDC. Plugado em config/auth.ts, faz ctx.auth.user funcionar
// nativamente em qualquer app que consome o issuer via Authorization Code + PKCE.
export { OidcRpGuard, oidcRpGuard } from './src/host/oidc_rp_guard.js';
export type { OidcRpGuardOptions, OidcRpGuardEvents } from './src/host/oidc_rp_guard.js';
