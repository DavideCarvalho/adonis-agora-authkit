/**
 * @adonis-agora/authkit-poppy — the Personal Agent Protocol ("Poppy", Draft 0.3) for AuthKit, as a
 * `personalAgents.extensions` entry of `@adonis-agora/authkit-server`.
 *
 * Experimental: this package stays on 0.x and follows the draft spec, so any minor may break.
 */

// A busca à prova de SSRF mora no `@adonis-agora/authkit-server` (Client ID Metadata Documents).
export { isBlockedAddress, SafeFetchError, safeFetchJson } from '@adonis-agora/authkit-server';
export { configure, POPPY_CONFIG_SNIPPET } from './configure.js';
export type {
  PoppyAgentProtocolEntry,
  PoppyApiEntry,
  PoppyBrowserLogin,
  PoppyClientsConfigInput,
  PoppyConfigInput,
  PoppyLimiter,
  PoppyMediatedConfigInput,
  PoppyMediatedField,
  PoppyMediatedResult,
  PoppyMediatedVerifyInput,
  PoppyPrincipalBase,
  PoppyReplayStore,
  PoppyScopeHint,
  PoppySignInType,
  ResolvedPoppyConfig,
} from './src/config.js';
export { AGORA_DEV_SCOPE } from './src/config.js';
export {
  accessTokenHash,
  type DpopNonceSource,
  type DpopResult,
  hmacNonceSource,
  type VerifyDpopInput,
  verifyDpopProof,
} from './src/dpop.js';
export {
  maskEmail,
  type PoppyEmailCodeSignInOptions,
  type PoppySignInCodeEmail,
  poppyEmailCodeSignIn,
} from './src/email_code_sign_in.js';
export { PoppyError, type PoppyErrorCode } from './src/errors.js';
export {
  POPPY_GRANT_PREFIX,
  type PoppyExtensionOptions,
  poppy,
} from './src/extension.js';
export { POPPY_MESSAGES } from './src/messages.js';
export {
  databaseReplayStore,
  memoryReplayStore,
  redisReplayStore,
} from './src/replay.js';
export {
  installPoppySlots,
  POPPY_AUTHENTICATE_SLOT,
  type PoppyAuthenticate,
  type PoppyAuthResult,
  type PoppyPrincipal,
  type PoppySlotRequest,
  poppyAuth,
  poppyOf,
  verifyPoppyRequest,
  writePoppyAuthError,
} from './src/resource.js';
export { POPPY_PROTOCOL_ID, poppyFor, poppyFromApp } from './src/runtime.js';
export type {
  PoppyAuthError,
  PoppyGrantSummary,
  PoppyScopeDescription,
  PoppyService,
  PoppySessionState,
  PoppyTokenResponse,
  PoppyVerifyOptions,
} from './src/service.js';
export { ensurePoppySchema, POPPY_TABLES } from './src/tables.js';
export {
  isPoppyBrowser,
  POPPY_WEB_SESSION_KEY,
  type PoppyWebSessionMarker,
  poppyWebSession,
  poppyWebSessionOf,
} from './src/web_session.js';
