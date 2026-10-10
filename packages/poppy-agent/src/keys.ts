import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

/** An ES256 key pair as stored in the state file. */
export interface StoredKey {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

export async function generateEs256Key(): Promise<StoredKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(pub, 'sha256');
  return {
    kid,
    privateJwk: { ...priv, kid, alg: 'ES256', use: 'sig' },
    publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' },
  };
}

export type SigningKey = Awaited<ReturnType<typeof importJWK>>;

const cache = new WeakMap<StoredKey, Promise<SigningKey>>();

export function importSigningKey(key: StoredKey): Promise<SigningKey> {
  let p = cache.get(key);
  if (!p) {
    p = importJWK(key.privateJwk, 'ES256');
    cache.set(key, p);
  }
  return p;
}

/** Only the public members of an EC JWK, as embedded in a DPoP header (RFC 9449 4.2). */
export function bareEcPublicJwk(jwk: JWK): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
