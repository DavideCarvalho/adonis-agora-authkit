/**
 * Erros OAuth do Poppy (§4.7, RFC 6749 §5.2, RFC 8628 §3.5, RFC 9449, extensão Mediated Sign-In)
 * — viram `{ error, error_description }` com o status da spec.
 */
export type PoppyErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_session'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce'
  /** Interno: HTTP 429 com `Retry-After`, sem corpo (§5.6). */
  | 'too_many_requests'
  | 'code_required'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unsupported_grant_type'
  | 'unsupported_token_type'
  | 'unauthorized_client'
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token';

const STATUS: Partial<Record<PoppyErrorCode, number>> = {
  invalid_client: 401,
  too_many_requests: 429,
};

export class PoppyError extends Error {
  readonly status: number;
  /** Headers extras da resposta (`DPoP-Nonce`, `Retry-After`). */
  readonly headers: Record<string, string>;
  /** Campos extras do corpo (`sign_in_id`, `sent_to`, `expires_in` do `code_required`). */
  readonly extra: Record<string, unknown>;

  constructor(
    readonly code: PoppyErrorCode,
    readonly description: string,
    options: {
      status?: number;
      headers?: Record<string, string>;
      extra?: Record<string, unknown>;
    } = {},
  ) {
    super(description);
    this.name = 'PoppyError';
    this.status = options.status ?? STATUS[code] ?? 400;
    this.headers = options.headers ?? {};
    this.extra = options.extra ?? {};
  }

  toJSON() {
    return { error: this.code, error_description: this.description, ...this.extra };
  }
}
