export { defineConfig, resolvers } from './src/define_config.js';
export { Authenticator } from './src/authenticator.js';
export {
  identityToUser,
  createUserinfoResolver,
} from './src/user_resolvers.js';
export type {
  ClaimsUser,
  ResolveUserContext,
  UserinfoResolverOptions,
} from './src/user_resolvers.js';
export {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  exchangeToken,
  refreshTokens,
  generatePkce,
} from './src/oidc_login.js';
export type { EndSessionParams, RefreshParams } from './src/oidc_login.js';
export { discoverEndpoints, conventionEndpoints } from './src/discovery.js';
export type { OidcEndpoints, DiscoverOptions } from './src/discovery.js';
export { resilientFetch } from './src/http/resilient_fetch.js';
export type { ResiliencePolicy } from './src/http/resilient_fetch.js';
export { AuthkitClientManager } from './providers/authkit_client_provider.js';
export type {
  ResolvedClientConfig,
  ClientConfigInput,
  BackchannelLogoutCallback,
  BackchannelLogoutInput,
} from './src/define_config.js';
export {
  lucidRevocationStore,
  DEFAULT_REVOCATION_TABLE,
} from './src/revocation/revocation_store.js';
export type {
  RevocationStore,
  LucidRevocationStoreOptions,
} from './src/revocation/revocation_store.js';
export { default as BackchannelRevocationMiddleware } from './src/middleware/backchannel_revocation_middleware.js';
export { authkitClientGuard, AuthkitClientGuard } from './src/host/authkit_client_guard.js';
export type { UnauthorizedAccessConstructor } from './src/host/authkit_client_guard.js';
export { getAuthkit } from './src/host/request_authenticator.js';
export {
  isAuthkitAdmin,
  authkitDashboardAuthorize,
  authkitDashboardMiddleware,
} from './src/host/dashboard_guard.js';
export type { DashboardGuardOptions } from './src/host/dashboard_guard.js';
export { default as AuthkitContextMiddleware } from './src/middleware/authkit_context_middleware.js';
export { default as RequireOrgMiddleware } from './src/middleware/require_org_middleware.js';
export type { RequireOrgMiddlewareOptions } from './src/middleware/require_org_middleware.js';
export { lucidMirror } from './src/lucid_mirror.js';
export type { LucidMirrorOptions } from './src/lucid_mirror.js';
export { registerOidcClient } from './src/register_oidc_client.js';
export type {
  RegisterOidcClientOptions,
  PostLoginRedirects,
} from './src/register_oidc_client.js';
export {
  validateLogoutToken,
  InvalidLogoutTokenError,
  InMemorySessionIndex,
  BACKCHANNEL_LOGOUT_EVENT,
} from './src/backchannel_logout.js';
export type {
  ValidateLogoutTokenOptions,
  ValidatedLogoutToken,
  SessionIndex,
  SessionIndexEntry,
} from './src/backchannel_logout.js';
export {
  generateDpopKeyPair,
  createDpopProof,
  dpopJwkThumbprint,
} from './src/dpop.js';
export type { DpopKeyPair, CreateDpopProofInput } from './src/dpop.js';
export {
  verifyJwtAccessToken,
  clearJwksCache,
} from './src/verify_access_token.js';
export type {
  VerifyJwtAccessTokenOptions,
  JwtAccessTokenClaims,
} from './src/verify_access_token.js';
export type { TokenSet } from './src/types.js';
export type { Identity } from '@adonis-agora/authkit-core';
export { configure } from './commands/configure.js';
