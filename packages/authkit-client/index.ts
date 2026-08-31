export type { Identity } from '@adonis-agora/authkit-core';
export { configure } from './commands/configure.js';
export { AuthkitClientManager } from './providers/authkit_client_provider.js';
export { Authenticator } from './src/authenticator.js';
export type {
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
export type {
  BackchannelLogoutCallback,
  BackchannelLogoutInput,
  ClientConfigInput,
  ResolvedClientConfig,
} from './src/define_config.js';
export { defineConfig, resolvers } from './src/define_config.js';
export type { DiscoverOptions, OidcEndpoints } from './src/discovery.js';
export { conventionEndpoints, discoverEndpoints } from './src/discovery.js';
export type { CreateDpopProofInput, DpopKeyPair } from './src/dpop.js';
export {
  createDpopProof,
  dpopJwkThumbprint,
  generateDpopKeyPair,
} from './src/dpop.js';
export type { UnauthorizedAccessConstructor } from './src/host/authkit_client_guard.js';
export { AuthkitClientGuard, authkitClientGuard } from './src/host/authkit_client_guard.js';
export type { DashboardGuardOptions } from './src/host/dashboard_guard.js';
export {
  authkitDashboardAuthorize,
  authkitDashboardMiddleware,
  isAuthkitAdmin,
} from './src/host/dashboard_guard.js';
export { getAuthkit } from './src/host/request_authenticator.js';
export type { ResiliencePolicy } from './src/http/resilient_fetch.js';
export { resilientFetch } from './src/http/resilient_fetch.js';
export type { LucidMirrorOptions } from './src/lucid_mirror.js';
export { lucidMirror } from './src/lucid_mirror.js';
export { default as AuthkitContextMiddleware } from './src/middleware/authkit_context_middleware.js';
export { default as BackchannelRevocationMiddleware } from './src/middleware/backchannel_revocation_middleware.js';
export type { RequireOrgMiddlewareOptions } from './src/middleware/require_org_middleware.js';
export { default as RequireOrgMiddleware } from './src/middleware/require_org_middleware.js';
export type { EndSessionParams, RefreshParams } from './src/oidc_login.js';
export {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  exchangeToken,
  generatePkce,
  refreshTokens,
} from './src/oidc_login.js';
export type {
  PostLoginRedirects,
  RegisterOidcClientOptions,
} from './src/register_oidc_client.js';
export { registerOidcClient } from './src/register_oidc_client.js';
export type {
  LucidRevocationStoreOptions,
  RevocationStore,
} from './src/revocation/revocation_store.js';
export {
  DEFAULT_REVOCATION_TABLE,
  lucidRevocationStore,
} from './src/revocation/revocation_store.js';
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
export {
  clearJwksCache,
  verifyJwtAccessToken,
} from './src/verify_access_token.js';
