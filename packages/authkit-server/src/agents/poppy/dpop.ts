/**
 * Verificação de provas DPoP (RFC 9449) — utilitário genérico para o token
 * endpoint e para resource servers (§4.3 do Poppy).
 *
 * Confere: um único header `DPoP`; `typ` `dpop+jwt`; algoritmo permitido; `jwk`
 * público no header e a assinatura com ele; `jti`, `htm`, `htu` (sem query nem
 * fragmento), `iat` dentro da janela; `ath` = SHA-256 do access token; o
 * `nonce` quando exigido; replay do `jti` na janela; e, num resource server, que
 * a chave é a do token (`cnf.jkt`).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  EmbeddedJWK,
  type JWK,
  jwtVerify,
} from 'jose';
import type { PoppyReplayStore } from './config.js';
import { replayKey } from './replay.js';

export type DpopFailure = {
  ok: false;
  error: 'invalid_dpop_proof' | 'use_dpop_nonce';
  description: string;
};

export type DpopResult = { ok: true; jkt: string; jti: string } | DpopFailure;

export interface DpopNonceSource {
  /** Nonce novo para o header `DPoP-Nonce`. */
  issue(): string;
  /** O nonce ainda vale? */
  valid(nonce: string): boolean;
}

/**
 * Nonces sem estado: `base64url(ts).base64url(hmac(ts))`, válidos por
 * `ttlSeconds` (default 300). Qualquer instância com o mesmo segredo valida.
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export function hmacNonceSource(
  secret: Buffer | string,
  options: { ttlSeconds?: number; now?: () => number } = {},
): DpopNonceSource {
  const ttl = (options.ttlSeconds ?? 300) * 1000;
  const now = options.now ?? Date.now;
  const mac = (ts: string) =>
    createHmac('sha256', secret).update(`dpop-nonce:${ts}`).digest('base64url');
  return {
    issue() {
      const ts = Buffer.from(String(now())).toString('base64url');
      return `${ts}.${mac(ts)}`;
    },
    valid(nonce) {
      const [ts, sig] = nonce.split('.');
      if (!ts || !sig) return false;
      const expected = Buffer.from(mac(ts));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
      const issuedAt = Number(Buffer.from(ts, 'base64url').toString());
      const t = now();
      return Number.isFinite(issuedAt) && issuedAt <= t + 5000 && t - issuedAt <= ttl;
    },
  };
}

/** `ath`: base64url(SHA-256(access token)). */
export function accessTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * `htu` normalizado para comparação: esquema e host minúsculos, sem porta
 * default, sem query nem fragmento. `null` se não for URL http(s).
 */
export function normalizeHtu(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

export interface VerifyDpopInput {
  /** Valor do(s) header(s) `DPoP`. Mais de um = inválido. */
  proof: string | string[] | undefined | null;
  method: string;
  /** URL da request (a query é ignorada). */
  url: string;
  /** Access token apresentado junto (resource server) — exige `ath`. */
  accessToken?: string;
  /** Thumbprint (RFC 7638) a que o token está preso. */
  expectedJkt?: string;
  algorithms: string[];
  /** Janela do `iat`, em segundos. */
  maxAge: number;
  /** Tolerância de relógio para `iat` no futuro, em segundos. Default: 5. */
  clockSkew?: number;
  replay: PoppyReplayStore;
  nonce?: { required: boolean; source: DpopNonceSource };
  now?: () => number;
}

function failure(error: DpopFailure['error'], description: string): DpopFailure {
  return { ok: false, error, description };
}

/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — pode mudar de forma incompatível enquanto a spec for draft.
 */
export async function verifyDpopProof(input: VerifyDpopInput): Promise<DpopResult> {
  const raw = input.proof;
  if (raw === undefined || raw === null || raw === '') {
    return failure('invalid_dpop_proof', 'DPoP proof is missing');
  }
  if (Array.isArray(raw) ? raw.length !== 1 : raw.includes(',')) {
    return failure('invalid_dpop_proof', 'Exactly one DPoP proof is allowed');
  }
  const proof = Array.isArray(raw) ? raw[0] : raw;

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    return failure('invalid_dpop_proof', 'Malformed DPoP proof');
  }
  if (header.typ !== 'dpop+jwt') return failure('invalid_dpop_proof', 'typ must be dpop+jwt');
  if (!header.alg || !input.algorithms.includes(header.alg)) {
    return failure('invalid_dpop_proof', 'Unsupported DPoP algorithm');
  }
  const jwk = header.jwk as JWK | undefined;
  if (!jwk || typeof jwk !== 'object')
    return failure('invalid_dpop_proof', 'jwk header is required');
  if ('d' in jwk || jwk.kty === 'oct') {
    return failure('invalid_dpop_proof', 'jwk must be a public key');
  }

  const nowMs = (input.now ?? Date.now)();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(proof, EmbeddedJWK, {
      algorithms: input.algorithms,
      typ: 'dpop+jwt',
      currentDate: new Date(nowMs),
    }));
  } catch {
    return failure('invalid_dpop_proof', 'DPoP proof signature is invalid');
  }

  const { jti, htm, htu, iat, ath, nonce } = payload as Record<string, unknown>;
  if (typeof jti !== 'string' || jti.length < 8 || jti.length > 256) {
    return failure('invalid_dpop_proof', 'jti is required');
  }
  if (typeof htm !== 'string' || htm !== input.method.toUpperCase()) {
    return failure('invalid_dpop_proof', 'htm does not match the request method');
  }
  const expectedHtu = normalizeHtu(input.url);
  if (typeof htu !== 'string' || !expectedHtu || normalizeHtu(htu) !== expectedHtu) {
    return failure('invalid_dpop_proof', 'htu does not match the request URL');
  }
  const nowS = Math.floor(nowMs / 1000);
  const skew = input.clockSkew ?? 5;
  if (typeof iat !== 'number' || iat > nowS + skew || iat < nowS - input.maxAge) {
    return failure('invalid_dpop_proof', 'iat is outside the acceptance window');
  }
  if (input.accessToken !== undefined) {
    if (typeof ath !== 'string' || ath !== accessTokenHash(input.accessToken)) {
      return failure('invalid_dpop_proof', 'ath does not match the access token');
    }
  }

  let jkt: string;
  try {
    jkt = await calculateJwkThumbprint(jwk, 'sha256');
  } catch {
    return failure('invalid_dpop_proof', 'Invalid jwk');
  }
  if (input.expectedJkt !== undefined && jkt !== input.expectedJkt) {
    return failure('invalid_dpop_proof', 'DPoP key does not match the token binding');
  }

  if (input.nonce?.required) {
    if (typeof nonce !== 'string' || !input.nonce.source.valid(nonce)) {
      return failure('use_dpop_nonce', 'A DPoP nonce issued by the server is required');
    }
  } else if (nonce !== undefined && input.nonce && typeof nonce === 'string') {
    // Nonce mandado sem ser exigido: se vier, tem de ser um nosso e válido.
    if (!input.nonce.source.valid(nonce)) {
      return failure('use_dpop_nonce', 'The DPoP nonce is invalid or expired');
    }
  }

  // Replay por último: uma prova inválida não queima o `jti`.
  const expiresAt = new Date((iat + input.maxAge + skew) * 1000);
  if (!(await input.replay.claim(replayKey('dpop', jkt, jti), expiresAt))) {
    return failure('invalid_dpop_proof', 'DPoP proof was already used');
  }
  return { ok: true, jkt, jti };
}
