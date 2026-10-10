export { apiBaseUrl, callOpenApi, listApis, loadOpenApi, pickApi } from './src/api.js';
export { autoSubmitFormHtml, createBrowserAssertion, serveOneShotPage } from './src/browser.js';
export {
  CompanyClient,
  PoppyAgent,
  type PoppyAgentOptions,
  type SignInResult,
  throwForResponse,
} from './src/company.js';
export {
  ConversationClient,
  type FollowOptions,
  newMessageId,
  poppyProtocol,
  type StreamItem,
} from './src/conversations.js';
export {
  authServerMetadataUrl,
  type Discovered,
  discover,
  HttpJsonCache,
  SUPPORTED_MAJOR_VERSIONS,
  validateMetadata,
  validatePoppyDocument,
  wellKnownUrlFor,
} from './src/discovery.js';
export { DpopKey, htuOf } from './src/dpop.js';
export {
  ConversationError,
  DiscoveryError,
  OAuthError,
  PoppyError,
  ResourceAuthError,
} from './src/errors.js';
export { PoppyHttp } from './src/http.js';
export { AgentIdentity, type IdentityConfig } from './src/identity.js';
export { startIdentityServer, waitForRelayedCallback } from './src/identity_server.js';
export { generateEs256Key, type StoredKey } from './src/keys.js';
export { ask, DEFAULT_MODEL } from './src/llm.js';
export { connectMcp, type McpConnection } from './src/mcp.js';
export {
  completeDirectSignIn,
  deviceSignIn,
  eligibleSignInTypes,
  type MediatedOutcome,
  mediatedSignIn,
  type PendingDirectSignIn,
  type SignInType,
  startDirectSignIn,
  submitMediatedCode,
} from './src/signin.js';
export { parseSse } from './src/sse.js';
export { defaultStatePath, StateStore } from './src/store.js';
export { TokenClient } from './src/token_client.js';
export type * from './src/types.js';
