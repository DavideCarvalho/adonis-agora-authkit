import {
  createKeyring,
  type EncrypterLike,
  type Keyring,
  type KmsAdapter,
  type SecretLike,
} from '../crypto-kit/index.js';
import { KeystoreCodec } from '../keys/keystore_codec.js';
import { loadEncryptionService } from '../keys/keystore_crypto.js';

/** Bound into every sealed value: one key never opens values of another use. */
export const KEYSTORE_PURPOSE = 'authkit:keystore';
export const ACCOUNT_SECRETS_PURPOSE = 'authkit:account-secrets';

/**
 * How AuthKit seals what it keeps at rest (the JWKS private keys, TOTP secrets): `crypto` in
 * `config/authkit.ts`. Default: the app's `encryption` service (`config/encryption.ts`).
 */
export interface AuthkitCryptoConfig {
  /**
   * Keys, newest first: the first seals, every one opens (AES-256-GCM through Adonis' encryption).
   * With `keys`, `authkit:crypto:reseal` moves values off the older ones.
   */
  keys?: SecretLike[];
  /** An Adonis encryption instance to seal with (instead of the app's `encryption` service). */
  encryption?: EncrypterLike;
  /** Envelope encryption through a KMS: a fresh data key per value, wrapped by the KMS. */
  kms?: KmsAdapter;
}

/** Per-column state of what is sealed at rest, and what a reseal did. */
export interface SealedColumnReport {
  column: string;
  scanned: number;
  /** Open with the key that seals now. */
  active: number;
  /** Open only with an older key in `crypto.keys` (or are not in the configured KMS envelope). */
  retired: number;
  /** Written by AuthKit before the crypto kit (Adonis encryption, no purpose). */
  legacy: number;
  /** Nothing configured opens them. */
  unreadable: number;
  /** Re-sealed with the key that seals now (with `dryRun`: would be). */
  resealed: number;
  /** Could not be re-sealed (did not open). */
  failed: number;
  /** Changed by the app between the read and the write; left alone (run again). */
  skipped: number;
}

export interface ResealOptions {
  /** Count and test-open; write nothing. */
  dryRun?: boolean;
  /** Re-seal every value that opens, not only retired/legacy ones. */
  all?: boolean;
}

export function emptyColumnReport(column: string): SealedColumnReport {
  return {
    column,
    scanned: 0,
    active: 0,
    retired: 0,
    legacy: 0,
    unreadable: 0,
    resealed: 0,
    failed: 0,
    skipped: 0,
  };
}

/**
 * The keyring of one AuthKit purpose, plus why the app's `encryption` could not be loaded (when it
 * could not): {@link authkitKeyring} without hiding the cause.
 */
async function resolveAuthkitKeyring(
  purpose: string,
  crypto: AuthkitCryptoConfig | undefined,
  appEncryption?: EncrypterLike,
): Promise<{ keyring?: Keyring; loadError?: unknown }> {
  let loadError: unknown;
  const app =
    appEncryption ??
    (await loadEncryptionService().catch((error: unknown) => {
      loadError = error;
      return undefined;
    }));
  const source = crypto?.keys?.length
    ? { keys: crypto.keys }
    : (crypto?.encryption ?? app)
      ? { encryption: (crypto?.encryption ?? app) as EncrypterLike }
      : undefined;
  if (!source) return { loadError };
  const keyring = createKeyring({
    purpose,
    ...source,
    ...(crypto?.kms ? { kms: crypto.kms } : {}),
    legacy: app ? [(value) => app.decrypt<string>(value) ?? undefined] : [],
  });
  return { keyring, loadError };
}

/**
 * The keyring of one AuthKit purpose: `crypto.keys` / `crypto.encryption` when set, else the
 * app's `encryption` service. Values AuthKit wrote before the kit (the app's encryption, with no
 * purpose) still open through a legacy reader. `undefined` when no encryption is available at all.
 */
export async function authkitKeyring(
  purpose: string,
  crypto: AuthkitCryptoConfig | undefined,
  appEncryption?: EncrypterLike,
): Promise<Keyring | undefined> {
  return (await resolveAuthkitKeyring(purpose, crypto, appEncryption)).keyring;
}

/**
 * The keystore codec: sealed with the `authkit:keystore` keyring when `encrypt`. Throws when
 * `encrypt` is asked for and no encryption is available (the keystore never degrades to plain).
 */
export async function keystoreCodec(
  encrypt: boolean,
  crypto: AuthkitCryptoConfig | undefined,
  options: { required?: boolean } = {},
): Promise<KeystoreCodec> {
  if (!encrypt) return new KeystoreCodec({ encrypt: false });
  const { keyring, loadError } = await resolveAuthkitKeyring(KEYSTORE_PURPOSE, crypto);
  if (!keyring && options.required !== false) {
    // A causa (o erro do container, do import) vai junto: sem ela a mensagem não diz o que falhou.
    const reason = loadError instanceof Error ? `: ${loadError.message}` : '.';
    throw new Error(`AuthKit keystore: serviço de encryption (APP_KEY) indisponível${reason}`, {
      cause: loadError,
    });
  }
  return new KeystoreCodec({ encrypt, keyring });
}

/**
 * What a `lucidAccountStore` with the default encrypter exposes (as `accountSecrets`) for its
 * sealed TOTP secrets. `report: true` only classifies (the doctor); otherwise it re-seals.
 */
export interface AccountSecretsCapability {
  reseal(options?: ResealOptions & { report?: boolean }): Promise<SealedColumnReport>;
}

/**
 * Hidden hook a store built by `lucidAccountStore` exposes so `defineConfig` can hand it the
 * `crypto` option (the store is built before `defineConfig` runs).
 */
export const BIND_CRYPTO: unique symbol = Symbol.for('authkit.bindCrypto');

export function bindCrypto(store: unknown, crypto: AuthkitCryptoConfig | undefined): void {
  const bind = (store as Record<symbol, unknown> | undefined)?.[BIND_CRYPTO];
  if (typeof bind === 'function') bind(crypto);
}
