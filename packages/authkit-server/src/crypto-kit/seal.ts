// agora crypto-kit v1 — copied verbatim from _1x/shared/crypto-kit; never edit in one lib only.
import { randomBytes } from 'node:crypto';
import { type EncrypterLike, gcmEncryption, type Keyring } from './keyring.js';

/** Every value the kit writes starts with this; the rest is Adonis' own ciphertext. */
export const SEALED_PREFIX = 'agora:v1:';
/** `agora:v1:kms:<wrapped data key>:<ciphertext under the data key>` */
const KMS_MARK = 'kms:';

export interface SealOptions {
  /**
   * Context bound into the value with the lib's purpose (e.g. `auth_mfa.totp_secret:<account id>`):
   * not stored, and the same string must be passed to `open`, so a value can't move to another row.
   */
  aad?: string;
}

export type SealedValueErrorCode = 'format' | 'unreadable' | 'kms' | 'legacy';

/** A value that can't be opened. The message never contains the value or a key. */
export class SealedValueError extends Error {
  readonly code: SealedValueErrorCode;
  constructor(code: SealedValueErrorCode, message: string) {
    super(`crypto-kit: ${message}`);
    this.name = 'SealedValueError';
    this.code = code;
  }
}

/**
 * - `active`: opens with the encrypting key (or, with an opaque `encryption`, opens at all).
 * - `retired`: opens only with an older key, or is not in the KMS envelope the keyring now uses.
 * - `legacy`: a lib's pre-kit format that one of its legacy readers opens.
 * - `unreadable`: nothing configured opens it (key gone, tampered, wrong aad).
 */
export type SealedStatus = 'active' | 'retired' | 'legacy' | 'unreadable';

const purposeOf = (keyring: Keyring, aad: string | undefined) =>
  JSON.stringify([keyring.purpose, aad ?? null]);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** Strict base64url: only the canonical spelling of its bytes. */
function decode(part: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  const bytes = Buffer.from(part, 'base64url');
  return b64(bytes) === part ? bytes : undefined;
}

type Parsed = { kind: 'plain'; body: string } | { kind: 'kms'; wrapped: Buffer; body: string };

/** `undefined`: not a kit value. `null`: a kit value that is malformed. */
function parse(sealed: string): Parsed | null | undefined {
  if (!sealed.startsWith(SEALED_PREFIX)) return undefined;
  const rest = sealed.slice(SEALED_PREFIX.length);
  if (!rest.startsWith(KMS_MARK)) return rest.length > 0 ? { kind: 'plain', body: rest } : null;
  const end = rest.indexOf(':', KMS_MARK.length);
  if (end === -1) return null;
  const wrapped = decode(rest.slice(KMS_MARK.length, end));
  const body = rest.slice(end + 1);
  return wrapped && body.length > 0 ? { kind: 'kms', wrapped, body } : null;
}

/** Adonis' payload is `{ v: value }`: its message format drops an empty string. */
const opened = (payload: unknown): string | undefined => {
  const value = (payload as { v?: unknown } | null)?.v;
  return typeof value === 'string' ? value : undefined;
};

/** Seals `value` with the keyring's encrypting key (or a fresh KMS-wrapped data key). */
export async function seal(
  keyring: Keyring,
  value: string,
  options: SealOptions = {},
): Promise<string> {
  if (typeof value !== 'string') throw new TypeError('crypto-kit: seal() takes a string');
  const purpose = purposeOf(keyring, options.aad);
  if (!keyring.kms) return `${SEALED_PREFIX}${keyring.all.encrypt({ v: value }, { purpose })}`;
  const dataKey = randomBytes(32);
  const wrapped = await keyring.kms.wrap(dataKey, { purpose: keyring.purpose });
  const body = gcmEncryption([dataKey.toString('base64url')]).encrypt({ v: value }, { purpose });
  dataKey.fill(0);
  return `${SEALED_PREFIX}${KMS_MARK}${b64(wrapped)}:${body}`;
}

async function openKms(
  keyring: Keyring,
  parsed: { wrapped: Buffer; body: string },
  purpose: string,
): Promise<string | undefined> {
  if (!keyring.kms) {
    throw new SealedValueError('kms', 'value is KMS-sealed but no `kms` is configured');
  }
  let dataKey: Buffer;
  try {
    dataKey = Buffer.from(await keyring.kms.unwrap(parsed.wrapped, { purpose: keyring.purpose }));
  } catch {
    throw new SealedValueError('kms', 'the KMS could not unwrap the data key');
  }
  if (dataKey.length !== 32) {
    throw new SealedValueError('kms', 'unwrapped data key is not 32 bytes');
  }
  try {
    return opened(gcmEncryption([dataKey.toString('base64url')]).decrypt(parsed.body, purpose));
  } finally {
    dataKey.fill(0);
  }
}

async function openLegacy(keyring: Keyring, sealed: string): Promise<string | undefined> {
  for (const reader of keyring.legacy) {
    try {
      const value = await reader(sealed);
      if (typeof value === 'string') return value;
    } catch {
      // not this reader's format
    }
  }
  return undefined;
}

/** Opens a value from {@link seal} (or, through the keyring's legacy readers, an older format). */
export async function open(
  keyring: Keyring,
  sealed: string,
  options: SealOptions = {},
): Promise<string> {
  if (typeof sealed !== 'string') {
    throw new SealedValueError('format', 'sealed value must be a string');
  }
  const parsed = parse(sealed);
  if (parsed === undefined) {
    const value = await openLegacy(keyring, sealed);
    if (value === undefined) {
      throw new SealedValueError('legacy', 'not an agora:v1 value and no legacy reader opened it');
    }
    return value;
  }
  if (parsed === null) throw new SealedValueError('format', 'malformed sealed value');
  const purpose = purposeOf(keyring, options.aad);
  const value =
    parsed.kind === 'kms'
      ? await openKms(keyring, parsed, purpose)
      : opened(keyring.all.decrypt(parsed.body, purpose));
  if (value === undefined) {
    throw new SealedValueError(
      'unreadable',
      'sealed value did not open (tampered, wrong aad, or its key is not configured)',
    );
  }
  return value;
}

const opensWith = (encryption: EncrypterLike, body: string, purpose: string) =>
  opened(encryption.decrypt(body, purpose)) !== undefined;

/** Where a sealed value stands against the keyring (tries to open it; never returns the value). */
export async function sealedStatus(
  keyring: Keyring,
  sealed: string,
  options: SealOptions = {},
): Promise<SealedStatus> {
  const parsed = typeof sealed === 'string' ? parse(sealed) : null;
  if (parsed === undefined) {
    return (await openLegacy(keyring, sealed)) === undefined ? 'unreadable' : 'legacy';
  }
  if (parsed === null) return 'unreadable';
  const purpose = purposeOf(keyring, options.aad);
  if (parsed.kind === 'kms') {
    if (!keyring.kms) return 'unreadable';
    try {
      return (await openKms(keyring, parsed, purpose)) === undefined ? 'unreadable' : 'active';
    } catch {
      return 'unreadable';
    }
  }
  if (keyring.kms) return opensWith(keyring.all, parsed.body, purpose) ? 'retired' : 'unreadable';
  if (keyring.active && opensWith(keyring.active, parsed.body, purpose)) return 'active';
  if (!opensWith(keyring.all, parsed.body, purpose)) return 'unreadable';
  return keyring.active ? 'retired' : 'active';
}

/** True when the value opens but not with the encrypting key (an older key, a legacy format). */
export async function needsReseal(
  keyring: Keyring,
  sealed: string,
  options: SealOptions = {},
): Promise<boolean> {
  const status = await sealedStatus(keyring, sealed, options);
  return status === 'retired' || status === 'legacy';
}

/**
 * Opens and seals again with the encrypting key. Returns `sealed` unchanged when nothing is to do,
 * unless `force` (rewrite anyway: rotating keys the kit can't tell apart, e.g. the app's own).
 */
export async function reseal(
  keyring: Keyring,
  sealed: string,
  options: SealOptions & { force?: boolean } = {},
): Promise<string> {
  const aad = options.aad === undefined ? {} : { aad: options.aad };
  if (options.force !== true && !(await needsReseal(keyring, sealed, aad))) return sealed;
  return seal(keyring, await open(keyring, sealed, aad), aad);
}
