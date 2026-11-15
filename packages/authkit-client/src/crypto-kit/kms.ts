// agora crypto-kit v1 — copied verbatim from _1x/shared/crypto-kit; never edit in one lib only.
import { randomBytes } from 'node:crypto';
import { Encryption } from '@adonisjs/core/encryption';
import { AES256GCM } from '@adonisjs/core/encryption/drivers/aes_256_gcm';

/** What a data key is wrapped for: a KMS can bind it (AWS/GCP "encryption context"). */
export interface KmsContext {
  purpose: string;
}

/**
 * Envelope encryption: every sealed value gets a fresh data key, the KMS wraps it, and the wrapped
 * key is stored inside the sealed value. Only the KMS can unwrap it.
 */
export interface KmsAdapter {
  wrap(dataKey: Uint8Array, context: KmsContext): Uint8Array | Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: KmsContext): Uint8Array | Promise<Uint8Array>;
}

/**
 * A KMS that lives in memory, for tests and local development: Adonis' AES-256-GCM under a master
 * key that never leaves the process (pass the same `masterKey` to read values back later).
 */
export function createInMemoryKms(
  masterKey: string = randomBytes(32).toString('base64url'),
): KmsAdapter {
  const encryption = new Encryption({
    driver: (key) => new AES256GCM({ id: 'kms', key }),
    keys: [masterKey],
  });
  const purposeOf = (context: KmsContext) => `kms:${context.purpose}`;
  return {
    wrap(dataKey, context) {
      const payload = Buffer.from(dataKey).toString('base64url');
      return Buffer.from(encryption.encrypt(payload, { purpose: purposeOf(context) }), 'utf8');
    },
    unwrap(wrapped, context) {
      const payload = encryption.decrypt<string>(
        Buffer.from(wrapped).toString('utf8'),
        purposeOf(context),
      );
      if (typeof payload !== 'string') {
        throw new Error('crypto-kit: in-memory KMS could not unwrap');
      }
      return Buffer.from(payload, 'base64url');
    },
  };
}
