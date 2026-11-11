import { createHash } from 'node:crypto';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  EmbeddedJWK,
  type JWK,
  jwtVerify,
} from 'jose';

/** Asymmetric algorithms accepted for DPoP proofs (RFC 9449 forbids symmetric ones). */
export const DPOP_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA', 'PS256', 'RS256'];

export interface VerifyDpopProofInput {
  /** The `DPoP` request header. */
  proof: string | string[] | undefined;
  /** The request method. */
  method: string;
  /** The request URL; the query and fragment are ignored. */
  url: string;
  /** The access token sent with the proof, bound through `ath`. */
  accessToken: string;
  /** The `cnf.jkt` of the access token. */
  expectedJkt: string;
  /** Acceptance window for `iat`, in seconds. */
  maxAge: number;
  /** Seen `jti`s, to refuse a replayed proof. */
  replay: DpopReplayCache;
  now?: () => number;
}

function htu(value: string): string | null {
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

/** Bounded in-memory set of `jti`s seen within the proof window. */
export class DpopReplayCache {
  #seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}

  /** `true` the first time a `jti` is seen before `expiresAt` (ms). */
  remember(jti: string, expiresAt: number, now: number): boolean {
    for (const [key, exp] of this.#seen) {
      if (exp > now && this.#seen.size < this.max) break;
      this.#seen.delete(key);
    }
    const existing = this.#seen.get(jti);
    if (existing !== undefined && existing > now) return false;
    this.#seen.set(jti, expiresAt);
    return true;
  }
}

/**
 * Verifies a DPoP proof sent to a resource server (RFC 9449 §4.3, §7): one
 * `dpop+jwt` proof signed by the public key in its own header, matching the
 * request method and URL, fresh, not replayed, bound to the access token
 * (`ath`) and to the key the token is bound to (`cnf.jkt`).
 */
export async function verifyDpopProof(input: VerifyDpopProofInput): Promise<boolean> {
  const raw = input.proof;
  if (!raw || (Array.isArray(raw) ? raw.length !== 1 : raw.includes(','))) return false;
  const proof = Array.isArray(raw) ? raw[0] : raw;

  let jwk: JWK | undefined;
  try {
    const header = decodeProtectedHeader(proof);
    if (header.typ !== 'dpop+jwt' || !header.alg || !DPOP_ALGORITHMS.includes(header.alg)) {
      return false;
    }
    jwk = header.jwk as JWK | undefined;
  } catch {
    return false;
  }
  if (!jwk || typeof jwk !== 'object' || 'd' in jwk || jwk.kty === 'oct') return false;

  const nowMs = (input.now ?? Date.now)();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(proof, EmbeddedJWK, {
      algorithms: DPOP_ALGORITHMS,
      typ: 'dpop+jwt',
      currentDate: new Date(nowMs),
    }));
  } catch {
    return false;
  }

  const { jti, htm, htu: proofHtu, iat, ath } = payload;
  if (typeof jti !== 'string' || jti.length < 8 || jti.length > 256) return false;
  if (typeof htm !== 'string' || htm !== input.method.toUpperCase()) return false;
  const expectedHtu = htu(input.url);
  if (typeof proofHtu !== 'string' || !expectedHtu || htu(proofHtu) !== expectedHtu) return false;
  const nowS = Math.floor(nowMs / 1000);
  if (typeof iat !== 'number' || iat > nowS + 5 || iat < nowS - input.maxAge) return false;
  const tokenHash = createHash('sha256').update(input.accessToken).digest('base64url');
  if (ath !== tokenHash) return false;
  if ((await calculateJwkThumbprint(jwk, 'sha256')) !== input.expectedJkt) return false;

  return input.replay.remember(jti, (iat + input.maxAge + 5) * 1000, nowMs);
}
