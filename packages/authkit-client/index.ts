export type { Identity, IdentityActor } from '@adonis-agora/authkit-core';
export { configure } from './commands/configure.js';
export type {
  AuthkitClientLogger,
  AuthkitClientManagerDeps,
} from './providers/authkit_client_provider.js';
export { AuthkitClientManager } from './providers/authkit_client_provider.js';
export type {
  AccountExtensionsAnswer,
  AccountExtensionsVerifier,
  ServeAccountExtensionsInput,
} from './src/account_extensions.js';
export {
  ACCOUNT_EXTENSIONS_BINDING,
  ClientAccountExtensionRegistry,
  serveAccountExtensions,
  verifyAccountExtensionsToken,
} from './src/account_extensions.js';
export type { AgoraConsoleSignOut, ConsolesAppLike } from './src/agora_consoles.js';
export { AGORA_CONSOLES_BINDING, announceAgoraSignOut } from './src/agora_consoles.js';
export type { AppCatalogSource, PublishAppCatalogOptions } from './src/app_calls/catalog.js';
export { APP_CATALOG_PATH, publishAppCatalog, readAppCatalog } from './src/app_calls/catalog.js';
export type { ServiceInput } from './src/app_calls/config.js';
export type { AgoraDiscovery } from './src/app_calls/discovery.js';
export type {
  AgoraCaller,
  AgoraRequestContext,
  AppCallerVerifier,
  AuthkitServiceOptions,
} from './src/app_calls/inbound.js';
export { authkitService, getAgoraCaller } from './src/app_calls/inbound.js';
export type { OkpJwk } from './src/app_calls/keys.js';
export { Authenticator } from './src/authenticator.js';
export type {
  AuthorizationRequest,
  CompleteAuthorizationParams,
  CompletedAuthorization,
  CreateAuthorizationRequestParams,
  OidcCallbackErrorCode,
  PendingAuthorization,
} from './src/authorization.js';
export {
  completeAuthorization,
  createAuthorizationRequest,
  OidcCallbackError,
} from './src/authorization.js';
export type {
  InMemorySessionIndexOptions,
  SessionIndex,
  SessionIndexEntry,
  ValidatedLogoutToken,
  ValidateLogoutTokenOptions,
} from './src/backchannel_logout.js';
export {
  BACKCHANNEL_LOGOUT_EVENT,
  InMemorySessionIndex,
  InvalidLogoutTokenError,
  validateLogoutToken,
} from './src/backchannel_logout.js';
export {
  ControlPlaneNotFoundError,
  type ControlPlaneUrl,
  controlPlaneUrl,
  type DiscoverControlPlaneOptions,
  discoverControlPlane,
} from './src/control_planes.js';
export type {
  BackchannelLogoutCallback,
  BackchannelLogoutInput,
  ClientAccountConsoleConfig,
  ClientConfigInput,
  ClientOrgLabelsConfig,
  ResolvedClientConfig,
} from './src/define_config.js';
export { defineConfig, resolvers } from './src/define_config.js';
export type { DiscoverOptions, OidcEndpoints } from './src/discovery.js';
export { conventionEndpoints, discoverEndpoints, OidcDiscoveryError } from './src/discovery.js';
export type { CreateDpopProofInput, DpopKeyPair } from './src/dpop.js';
export {
  createDpopProof,
  dpopJwkThumbprint,
  generateDpopKeyPair,
} from './src/dpop.js';
export type { IdentityUserProviderContract } from './src/host/authkit_client_guard.js';
export {
  AuthkitClientGuard,
  authkitClientGuard,
  authkitIdentityProvider,
} from './src/host/authkit_client_guard.js';
export type { DashboardGuardOptions, DashboardGuardResult } from './src/host/dashboard_guard.js';
export {
  authkitDashboardAuthorize,
  isAuthkitAdmin,
} from './src/host/dashboard_guard.js';
export type { AuthkitUser, AuthkitUserType } from './src/host/request_authenticator.js';
export { getAuthkit } from './src/host/request_authenticator.js';
export type { ResiliencePolicy } from './src/http/resilient_fetch.js';
export { resilientFetch } from './src/http/resilient_fetch.js';
export type { IdTokenClaims, ValidateIdTokenOptions } from './src/id_token.js';
export { InvalidIdTokenError, validateIdToken } from './src/id_token.js';
export type { AuthkitAccessTokenIdentityOptions } from './src/identity_bridge.js';
export {
  bindAuthkitIdentity,
  bridgeAuthkitToken,
  identityFromAccessToken,
} from './src/identity_bridge.js';
export { clearJwksCache } from './src/jwks.js';
export type { LucidMirrorOptions } from './src/lucid_mirror.js';
export { lucidMirror } from './src/lucid_mirror.js';
export { default as AuthkitContextMiddleware } from './src/middleware/authkit_context_middleware.js';
export { default as BackchannelRevocationMiddleware } from './src/middleware/backchannel_revocation_middleware.js';
export type { RequireOrgMiddlewareOptions } from './src/middleware/require_org_middleware.js';
export { default as RequireOrgMiddleware } from './src/middleware/require_org_middleware.js';
export type {
  ClientTenancyOptions,
  ContextTenant,
  ContextTenantLink,
  TenantInput,
} from './src/observability/context_bridge.js';
export type {
  AuthorizeParams,
  EndSessionParams,
  ExchangeParams,
  RefreshParams,
} from './src/oidc_login.js';
export {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  exchangeToken,
  generatePkce,
  refreshTokens,
} from './src/oidc_login.js';
export type { AuthkitOrgLabelsOptions, OrgLabelResolver } from './src/org_labels.js';
export { authkitOrgLabels, installOrgLabeler, ORG_LABELS_PATH } from './src/org_labels.js';
export type {
  OidcClientHandler,
  OidcClientRoutes,
  PostLoginRedirects,
  RegisterOidcClientOptions,
} from './src/register_oidc_client.js';
export {
  oidcClientRoutes,
  registerAccountExtensionsEndpoint,
  registerOidcClient,
} from './src/register_oidc_client.js';
export { buildIdentityFromClaims as identityFromClaims } from './src/resolvers/identity.js';
export type {
  LucidRevocationStoreOptions,
  RevocationStore,
} from './src/revocation/revocation_store.js';
export {
  DEFAULT_REVOCATION_TABLE,
  lucidRevocationStore,
} from './src/revocation/revocation_store.js';
export { type AuthkitTenant, TenantOfConfigError } from './src/tenant_of.js';
export {
  AuthkitTenantToken,
  type AuthkitTenantTokenFn,
  type AuthkitTenantTokenOptions,
  authkitTenantToken,
  TenantTokenError,
} from './src/tenant_token.js';
export {
  AuthkitTenantVerifier,
  type AuthkitTenantVerifierFn,
  type AuthkitTenantVerifierOptions,
  authkitTenantVerifier,
  type TenantVerifier,
  type TenantVerifierRequest,
  type VerifiedTenantToken,
} from './src/tenant_verifier.js';
export type { TokenSet } from './src/types.js';
export type {
  ClaimsUser,
  ResolveUserContext,
  UserinfoResolverOptions,
} from './src/user_resolvers.js';
export {
  createUserinfoResolver,
  identityToUser,
} from './src/user_resolvers.js';
export type {
  JwtAccessTokenClaims,
  VerifyJwtAccessTokenOptions,
} from './src/verify_access_token.js';
export { verifyJwtAccessToken } from './src/verify_access_token.js';
export type {
  AuthkitDiagnosticPayload,
  AuthkitWebhookEvent,
  AuthkitWebhookOptions,
  WebhookKeys,
  WebhookRejection,
  WebhookReplayStore,
  WebhookVerification,
} from './src/webhook_receiver.js';
export {
  authkitWebhookHandler,
  emitAuthkitEvent,
  memoryReplayStore,
  registerAuthkitWebhook,
  verifyAuthkitWebhook,
  webhookKeys,
} from './src/webhook_receiver.js';
