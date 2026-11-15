// agora crypto-kit v1 — copied verbatim from _1x/shared/crypto-kit; never edit in one lib only.
//
// Asymmetric primitives. Adonis' encryption is symmetric only, so this is the one file of the kit
// that uses node:crypto ciphers directly. Node 24/26 have no native HPKE: `sealTo` is an
// ECIES/HPKE-style construction (ephemeral X25519 + HKDF-SHA256 + AES-256-GCM).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign as nodeSign,
  verify as nodeVerify,
  randomBytes,
} from 'node:crypto';
import type { Keyring, SecretLike } from './keyring.js';
import { open, SealedValueError, type SealOptions, seal } from './seal.js';

/** An OKP JSON Web Key (RFC 8037): X25519 for encryption, Ed25519 for signatures. */
export interface OkpJwk {
  kty: 'OKP';
  crv: 'X25519' | 'Ed25519';
  x: string;
  /** Private part: present on a private key only. */
  d?: string;
  kid: string;
  use?: 'enc' | 'sig';
  alg?: 'EdDSA' | 'ECDH-ES';
}

export interface Jwks {
  keys: OkpJwk[];
}

/** One key, several (newest first), or a JWKS: lookup is by `kid`. */
export type JwkSource = OkpJwk | OkpJwk[] | Jwks;

export const SEALED_TO_PREFIX = 'agora:pk1:';
export const SIGNATURE_PREFIX = 'agora:sig1:';
const KID = /^[A-Za-z0-9._-]{1,128}$/;

/** RFC 7638 thumbprint of an OKP key: a stable `kid`. */
export function jwkThumbprint(jwk: Pick<OkpJwk, 'crv' | 'x'>): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: 'OKP', x: jwk.x });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** A fresh key pair as JWKs. `kid` defaults to the thumbprint. */
export function generateKeyPair(
  type: 'x25519' | 'ed25519',
  options: { kid?: string } = {},
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  const pair = type === 'x25519' ? generateKeyPairSync('x25519') : generateKeyPairSync('ed25519');
  return toPair(type, pair.privateKey.export({ format: 'jwk' }) as RawOkp, options.kid);
}

/** PKCS#8 prefix of a raw 32-byte X25519 / Ed25519 private key (RFC 8410). */
const PKCS8_PREFIX = {
  x25519: Buffer.from('302e020100300506032b656e04220420', 'hex'),
  ed25519: Buffer.from('302e020100300506032b657004220420', 'hex'),
};

/**
 * The same key pair every time from `secret` (an app key): HKDF-SHA256(secret, salt = `purpose`)
 * → the 32-byte private key. No private key to store: every instance derives it. Changing the
 * secret changes the key (and its thumbprint `kid`).
 */
export function deriveKeyPair(
  type: 'x25519' | 'ed25519',
  secret: SecretLike,
  purpose: string,
  options: { kid?: string } = {},
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  const raw = typeof secret === 'string' ? secret : secret.release();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error('crypto-kit: deriveKeyPair() needs a secret of at least 16 characters');
  }
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('crypto-kit: deriveKeyPair() needs a purpose');
  }
  const info = Buffer.from(`agora:okp:v1:${type}`, 'utf8');
  const seed = Buffer.from(hkdfSync('sha256', raw, Buffer.from(purpose, 'utf8'), info, 32));
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX[type], seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  return toPair(type, key.export({ format: 'jwk' }) as RawOkp, options.kid);
}

type RawOkp = { crv: string; x: string; d: string };

function toPair(
  type: 'x25519' | 'ed25519',
  raw: RawOkp,
  kidOption: string | undefined,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  const crv = type === 'x25519' ? 'X25519' : 'Ed25519';
  const kid = kidOption ?? jwkThumbprint({ crv, x: raw.x });
  if (!KID.test(kid)) throw new Error('crypto-kit: kid must match [A-Za-z0-9._-]{1,128}');
  const meta =
    type === 'x25519'
      ? ({ use: 'enc', alg: 'ECDH-ES' } as const)
      : ({ use: 'sig', alg: 'EdDSA' } as const);
  const publicKey: OkpJwk = { kty: 'OKP', crv, x: raw.x, kid, ...meta };
  return { publicKey, privateKey: { ...publicKey, d: raw.d } };
}

/** The public half of a JWK (drops `d`). */
export function publicJwk(jwk: OkpJwk): OkpJwk {
  const { d: _d, ...rest } = jwk;
  return rest;
}

/** A JWKS of the public halves, for discovery. */
export function toJwks(keys: OkpJwk[]): Jwks {
  return { keys: keys.map(publicJwk) };
}

function keysOf(source: JwkSource): OkpJwk[] {
  if (Array.isArray(source)) return source;
  if (source && Array.isArray((source as Jwks).keys)) return (source as Jwks).keys;
  return [source as OkpJwk];
}

function findKey(source: JwkSource, kid: string, crv: OkpJwk['crv'], priv: boolean) {
  return keysOf(source).find(
    (k) => k?.kty === 'OKP' && k.kid === kid && k.crv === crv && (!priv || typeof k.d === 'string'),
  );
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
function decode(part: string | undefined): Buffer | undefined {
  if (part === undefined || !/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  const bytes = Buffer.from(part, 'base64url');
  return b64(bytes) === part ? bytes : undefined;
}

const nodeKey = (jwk: OkpJwk, priv: boolean) =>
  priv
    ? createPrivateKey({
        key: { kty: 'OKP', crv: jwk.crv, x: jwk.x, d: jwk.d ?? '' },
        format: 'jwk',
      })
    : createPublicKey({ key: { kty: 'OKP', crv: jwk.crv, x: jwk.x }, format: 'jwk' });

function contentKey(shared: Buffer, kid: string, ephemeralX: string, recipientX: string): Buffer {
  const info = Buffer.from(JSON.stringify(['agora:pk1', kid, ephemeralX, recipientX]), 'utf8');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
}

const aadOf = (kid: string, aad: string | undefined) =>
  Buffer.from(JSON.stringify(['agora:pk1', kid, aad ?? null]), 'utf8');

/**
 * Encrypts `value` so only the holder of the X25519 private key opens it:
 * `agora:pk1:<kid>:<ephemeral x>:<iv>:<tag>:<ciphertext>`.
 */
export function sealTo(recipient: OkpJwk, value: string, options: SealOptions = {}): string {
  if (typeof value !== 'string') throw new TypeError('crypto-kit: sealTo() takes a string');
  if (recipient?.kty !== 'OKP' || recipient.crv !== 'X25519' || !KID.test(recipient.kid ?? '')) {
    throw new Error('crypto-kit: sealTo() needs an X25519 public JWK with a kid');
  }
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralX = (ephemeral.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: nodeKey(recipient, false),
  });
  const key = contentKey(shared, recipient.kid, ephemeralX, recipient.x);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aadOf(recipient.kid, options.aad));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const parts = [recipient.kid, ephemeralX, b64(iv), b64(cipher.getAuthTag()), b64(body)];
  return `${SEALED_TO_PREFIX}${parts.join(':')}`;
}

/** The `kid` a {@link sealTo} value was sealed for, or `undefined` when it isn't one. */
export function sealedToKid(sealed: string): string | undefined {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_TO_PREFIX)) return undefined;
  const kid = sealed.slice(SEALED_TO_PREFIX.length).split(':')[0];
  return kid && KID.test(kid) ? kid : undefined;
}

/** Opens a {@link sealTo} value with the private key whose `kid` it names. */
export function openWith(keys: JwkSource, sealed: string, options: SealOptions = {}): string {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_TO_PREFIX)) {
    throw new SealedValueError('format', 'not an agora:pk1 value');
  }
  const [kid, ephemeralX, ivPart, tagPart, bodyPart, ...extra] = sealed
    .slice(SEALED_TO_PREFIX.length)
    .split(':');
  const ephemeral = decode(ephemeralX);
  const iv = decode(ivPart);
  const tag = decode(tagPart);
  const body = bodyPart === '' ? Buffer.alloc(0) : decode(bodyPart);
  if (!kid || !KID.test(kid) || extra.length > 0 || ephemeral?.length !== 32) {
    throw new SealedValueError('format', 'malformed agora:pk1 value');
  }
  if (iv?.length !== 12 || tag?.length !== 16 || !body) {
    throw new SealedValueError('format', 'malformed agora:pk1 value');
  }
  const key = findKey(keys, kid, 'X25519', true);
  if (!key) throw new SealedValueError('unreadable', `no X25519 private key with kid "${kid}"`);
  try {
    const shared = diffieHellman({
      privateKey: nodeKey(key, true),
      publicKey: nodeKey({ ...key, x: ephemeralX as string }, false),
    });
    const cek = contentKey(shared, kid, ephemeralX as string, key.x);
    const decipher = createDecipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
    decipher.setAAD(aadOf(kid, options.aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedValueError(
      'unreadable',
      'agora:pk1 value did not open (tampered or wrong aad)',
    );
  }
}

/** Ed25519 detached signature over `payload`: `agora:sig1:<kid>:<signature>`. */
export function sign(privateKey: OkpJwk, payload: string | Uint8Array): string {
  if (
    privateKey?.crv !== 'Ed25519' ||
    typeof privateKey.d !== 'string' ||
    !KID.test(privateKey.kid ?? '')
  ) {
    throw new Error('crypto-kit: sign() needs an Ed25519 private JWK with a kid');
  }
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const signature = nodeSign(null, data, nodeKey(privateKey, true));
  return `${SIGNATURE_PREFIX}${privateKey.kid}:${b64(signature)}`;
}

/** Checks a {@link sign} signature against the Ed25519 public key its `kid` names. Never throws. */
export function verify(keys: JwkSource, payload: string | Uint8Array, signature: string): boolean {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  const [kid, sigPart, ...extra] = signature.slice(SIGNATURE_PREFIX.length).split(':');
  const bytes = decode(sigPart);
  if (!kid || extra.length > 0 || bytes?.length !== 64) return false;
  const key = findKey(keys, kid, 'Ed25519', false);
  if (!key) return false;
  try {
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    return nodeVerify(null, data, nodeKey(key, false), bytes);
  } catch {
    return false;
  }
}

/** A private JWK sealed at rest with the symmetric keyring (never stored plain). */
export function sealPrivateKey(
  keyring: Keyring,
  privateKey: OkpJwk,
  options: SealOptions = {},
): Promise<string> {
  return seal(keyring, JSON.stringify(privateKey), options);
}

export async function openPrivateKey(
  keyring: Keyring,
  sealed: string,
  options: SealOptions = {},
): Promise<OkpJwk> {
  return JSON.parse(await open(keyring, sealed, options)) as OkpJwk;
}
