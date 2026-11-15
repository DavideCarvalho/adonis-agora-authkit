/**
 * `jwks.readOnly`: this instance serves keys another authkit-server writes (same keystore row,
 * same `auth_settings`, a different issuer). It reads the keystore and picks up rotations through
 * the reload poll, but never generates, rotates, retires or reseals keys, and never edits the
 * rotation policy.
 */

/** The write the instance refused. */
export type KeystoreWriteAction = 'rotate' | 'generate' | 'retire' | 'reseal' | 'setting';

/** Thrown by every keystore write on a `jwks.readOnly` instance. */
export class KeystoreReadOnlyError extends Error {
  readonly code = 'E_KEYSTORE_READ_ONLY';
  readonly action: KeystoreWriteAction;
  constructor(action: KeystoreWriteAction, detail?: string) {
    super(
      detail ??
        `AuthKit: this instance has \`jwks.readOnly\` set, so it cannot ${action} signing keys. Do it on the instance that writes the keystore.`,
    );
    this.name = 'KeystoreReadOnlyError';
    this.action = action;
  }
}

/** Thrown at boot by a `jwks.readOnly` instance when the keystore row is missing or can't be read. */
export class KeystoreUnavailableError extends Error {
  readonly code = 'E_KEYSTORE_UNAVAILABLE';
  readonly reason: 'missing' | 'unreadable';
  constructor(reason: 'missing' | 'unreadable', cause?: unknown) {
    super(
      reason === 'missing'
        ? 'AuthKit: `jwks.readOnly` is set but the keystore is empty. A read-only instance never creates keys: boot the instance that writes the keystore first (it creates it), or point `jwks.store` at the same table/key it uses.'
        : `AuthKit: \`jwks.readOnly\` is set but the keystore could not be read${cause instanceof Error ? ` (${cause.message})` : ''}. Check that \`jwks.store\`, \`jwks.encrypt\` and \`crypto.keys\` match the instance that writes it.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'KeystoreUnavailableError';
    this.reason = reason;
  }
}
