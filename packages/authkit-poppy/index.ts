/**
 * @adonis-agora/authkit-poppy — the Personal Agent Protocol ("Poppy", version 1.0) for AuthKit, as a
 * `personalAgents.extensions` entry of `@adonis-agora/authkit-server`.
 *
 * The package version follows the spec version: 1.x implements Poppy 1.x.
 */

// A busca à prova de SSRF mora no `@adonis-agora/authkit-server` (Client ID Metadata Documents).
export { isBlockedAddress, SafeFetchError, safeFetchJson } from '@adonis-agora/authkit-server';
export { configure, POPPY_CONFIG_SNIPPET } from './configure.js';
export type {
  PoppyAgentProtocolEntry,
  PoppyAlternative,
  PoppyApiEntry,
  PoppyApproval,
  PoppyBrowserLogin,
  PoppyClientsConfigInput,
  PoppyConfigInput,
  PoppyDecline,
  PoppyFeedbackConfigInput,
  PoppyFeedbackReport,
  PoppyLimiter,
  PoppyMediatedConfigInput,
  PoppyMediatedField,
  PoppyMediatedResult,
  PoppyMediatedVerifyInput,
  PoppyOperationsConfigInput,
  PoppyPrincipalBase,
  PoppyReplayStore,
  PoppyScopeHint,
  PoppySignInType,
  PoppyVersionInput,
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
  approvalFromMcpMeta,
  MCP_APPROVAL_META,
  normalizeApproval,
  POPPY_APPROVAL_HEADER,
  POPPY_OPERATION_HEADER,
  type PoppyDeclinedWire,
  type PoppyOperationInput,
  type PoppyOperationRecord,
  type PoppyOperationResult,
  type PoppyOperationWire,
  parseApprovalHeader,
  poppyOperationToolResult,
} from './src/operations.js';
export {
  databaseReplayStore,
  memoryReplayStore,
  redisReplayStore,
} from './src/replay.js';
export {
  getPoppyOperation,
  installPoppySlots,
  markPoppyOperationPerformed,
  POPPY_AUTHENTICATE_SLOT,
  POPPY_OPERATIONS_SLOT,
  type PoppyAuthenticate,
  type PoppyAuthResult,
  type PoppyOperationsSlot,
  type PoppyPrincipal,
  type PoppySlotRequest,
  poppyAuth,
  poppyOf,
  releasePoppyOperation,
  requirePoppyOperation,
  verifyPoppyRequest,
  writePoppyAuthError,
  writePoppyOperationResult,
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
  type PoppyUserStep,
  type PoppyWebSessionMarker,
  poppyBrowserControlOf,
  poppyControllerOf,
  poppyUserStep,
  poppyUserStepAttrs,
  poppyWebSession,
  poppyWebSessionOf,
} from './src/web_session.js';
