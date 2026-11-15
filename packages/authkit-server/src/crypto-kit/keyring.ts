// agora crypto-kit v1 — copied verbatim from _1x/shared/crypto-kit; never edit in one lib only.
import { Encryption } from '@adonisjs/core/encryption';
import { AES256GCM } from '@adonisjs/core/encryption/drivers/aes_256_gcm';
import type { KmsAdapter } from './kms.js';

/**
 * What the kit needs from Adonis' encryption: an `Encryption` or the app's `EncryptionManager`
 * (`@adonisjs/core/services/encryption`) both fit.
 */
export interface EncrypterLike {
  encrypt(payload: unknown, options?: { purpose?: string }): string;
  decrypt<T = unknown>(value: string, purpose?: string): T | null;
}

/** A key: a string, or an Adonis `Secret` (`env.get('APP_KEY')`). At least 16 characters. */
export type SecretLike = string | { release(): string };

/**
 * Opens a value written before the kit (a lib's old format). Returns the plaintext, or `undefined`
 * when the value is not one it knows. A throw counts as `undefined`.
 */
export type LegacyReader = (sealed: string) => string | undefined | Promise<string | undefined>;

export interface KeyringOptions {
  /** Domain separation, e.g. `authkit:keystore`: bound into every value as Adonis' `purpose`. */
  purpose: string;
  /**
   * Keys, newest first: the first encrypts, every one decrypts (Adonis' AES-256-GCM driver). The
   * kit can then tell values sealed with an older key apart (`retired`).
   */
  keys?: SecretLike[];
  /**
   * Or an Adonis encryption instance (the app's `encryption` service by default in the libs). Its
   * own keys rotate in `config/encryption.ts`; the kit can't tell which of them sealed a value.
   */
  encryption?: EncrypterLike;
  /** Envelope encryption: a fresh data key per value, wrapped by the KMS and stored inline. */
  kms?: KmsAdapter;
  /** Readers for values written before the kit, tried in order. Never used to write. */
  legacy?: LegacyReader[];
}

export interface Keyring {
  readonly purpose: string;
  /** Opens with every key. */
  readonly all: EncrypterLike;
  /** Opens with the encrypting key only; `undefined` when the kit can't tell keys apart. */
  readonly active: EncrypterLike | undefined;
  readonly kms: KmsAdapter | undefined;
  readonly legacy: readonly LegacyReader[];
}

/** Adonis `Encryption` over AES-256-GCM with these keys (first encrypts). */
export function gcmEncryption(keys: SecretLike[], id = 'agora'): Encryption {
  return new Encryption({
    driver: (key) => new AES256GCM({ id, key }),
    keys: keys.map((key) => (typeof key === 'string' ? key : key.release())),
  });
}

export function createKeyring(options: KeyringOptions): Keyring {
  const { purpose, keys, encryption } = options;
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('crypto-kit: a keyring needs a `purpose`');
  }
  if ((keys === undefined) === (encryption === undefined)) {
    throw new Error('crypto-kit: give a keyring either `keys` or `encryption`');
  }
  if (keys !== undefined && keys.length === 0) {
    throw new Error('crypto-kit: `keys` needs at least one key');
  }
  if (
    options.kms &&
    (typeof options.kms.wrap !== 'function' || typeof options.kms.unwrap !== 'function')
  ) {
    throw new Error('crypto-kit: `kms` needs wrap() and unwrap()');
  }
  const all = keys ? gcmEncryption(keys) : (encryption as EncrypterLike);
  const active = keys ? (keys.length === 1 ? all : gcmEncryption(keys.slice(0, 1))) : undefined;
  return {
    purpose,
    all,
    active,
    kms: options.kms,
    legacy: [...(options.legacy ?? [])],
  };
}
