/**
 * Erros OAuth do Poppy (§4.2, §4.4, §4.6, RFC 6749 §5.2, RFC 8628 §3.5, RFC 9449)
 * — viram `{ error, error_description }` com o status da spec.
 */
export type PoppyErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_session'
  | 'account_mismatch'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce'
  | 'rate_limited'
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
  rate_limited: 429,
};

export class PoppyError extends Error {
  readonly status: number;
  /** Headers extras da resposta (`DPoP-Nonce`, `Retry-After`). */
  readonly headers: Record<string, string>;

  constructor(
    readonly code: PoppyErrorCode,
    readonly description: string,
    options: { status?: number; headers?: Record<string, string> } = {},
  ) {
    super(description);
    this.name = 'PoppyError';
    this.status = options.status ?? STATUS[code] ?? 400;
    this.headers = options.headers ?? {};
  }

  toJSON() {
    return { error: this.code, error_description: this.description };
  }
}
