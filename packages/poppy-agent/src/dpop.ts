import { SignJWT } from 'jose';
import { bareEcPublicJwk, generateEs256Key, importSigningKey, type StoredKey } from './keys.js';
import { nowSeconds, randomId, sha256b64url } from './util.js';

/** `htu`: the request URL without query or fragment (RFC 9449 4.2). */
export function htuOf(url: string | URL): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * A DPoP key (RFC 9449). The agent keeps one per User per Company (4.3); it is never published.
 */
export class DpopKey {
  constructor(readonly stored: StoredKey) {}

  static async generate(): Promise<DpopKey> {
    return new DpopKey(await generateEs256Key());
  }

  /** A fresh proof for one request. `accessToken` adds `ath`; token-endpoint proofs have none. */
  async proof(input: {
    htm: string;
    htu: string | URL;
    accessToken?: string;
    nonce?: string;
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      jti: randomId(),
      htm: input.htm.toUpperCase(),
      htu: htuOf(input.htu),
      iat: nowSeconds(),
    };
    if (input.accessToken) payload.ath = sha256b64url(input.accessToken);
    if (input.nonce) payload.nonce = input.nonce;
    return new SignJWT(payload)
      .setProtectedHeader({
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: bareEcPublicJwk(this.stored.publicJwk),
      })
      .sign(await importSigningKey(this.stored));
  }
}
