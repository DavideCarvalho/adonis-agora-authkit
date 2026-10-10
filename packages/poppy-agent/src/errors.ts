/** Base error for everything this client raises on a protocol-level failure. */
export class PoppyError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly description?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message?: string,
    opts: { status?: number; description?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message ?? (opts.description ? `${code}: ${opts.description}` : code));
    this.name = 'PoppyError';
    this.code = code;
    this.status = opts.status;
    this.description = opts.description;
    this.details = opts.details;
  }
}

/** Discovery failed or a document didn't pass the checks of section 3. */
export class DiscoveryError extends PoppyError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'DiscoveryError';
  }
}

/** OAuth error response from the token, device, or revocation endpoint (4.2). */
export class OAuthError extends PoppyError {
  readonly retryAfter?: number;
  constructor(
    code: string,
    opts: {
      status?: number;
      description?: string;
      retryAfter?: number;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(code, undefined, opts);
    this.name = 'OAuthError';
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * A resource (API, conversation, mediated sign-in) rejected the token, via `WWW-Authenticate`
 * (section 6): `invalid_token`, `sign_in_required`, `insufficient_scope`, DPoP errors.
 */
export class ResourceAuthError extends PoppyError {
  /** Scopes the Company says are needed, for `insufficient_scope`. */
  readonly scope?: string;
  constructor(code: string, opts: { status?: number; description?: string; scope?: string } = {}) {
    super(code, undefined, opts);
    this.name = 'ResourceAuthError';
    this.scope = opts.scope;
  }
}

/** A conversation error with a JSON `error` body (7.13). */
export class ConversationError extends PoppyError {
  /** For `direct_conversation_open`: the open Direct Conversation. */
  readonly conversationId?: string;
  constructor(
    code: string,
    opts: { status?: number; description?: string; conversationId?: string } = {},
  ) {
    super(code, undefined, opts);
    this.name = 'ConversationError';
    this.conversationId = opts.conversationId;
  }
}
