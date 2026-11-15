import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { generateSync } from 'otplib';
import {
  __resetAppKeyEncryption,
  __setAppKeyEncryptionForTesting,
  lucidAccountStore,
} from '../../src/accounts/lucid_account_store.js';
import {
  type AccountSecretsCapability,
  bindCrypto,
  type SealedColumnReport,
} from '../../src/crypto/authkit_crypto.js';
import { gcmEncryption } from '../../src/crypto-kit/index.js';
import { sealedAtRestResult } from '../../src/doctor/agora_checks.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { createTestDatabase } from '../bootstrap.js';

class SecretsAccount extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @beforeCreate()
  static assignId(row: SecretsAccount) {
    if (!row.id) row.id = randomUUID();
  }
}

const APP_KEY = 'app-key-of-the-test-app-32-chars';
const NEW_KEY = 'the-new-sealing-key-of-32-chars!';

/** The app's `encryption` service (config/encryption.ts): what older versions sealed TOTP with. */
const appEncryption = gcmEncryption([APP_KEY], 'app');

const totpRow = (db: any, accountId: string) =>
  db.connection().from('auth_mfa').where('account_id', accountId).first();

const secretsOf = (store: unknown) =>
  (store as { accountSecrets: AccountSecretsCapability }).accountSecrets;

test.group('authkit crypto at rest: TOTP secrets', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('users', (t: any) => {
      t.string('id').primary();
      t.string('email').notNullable();
      t.string('password').notNullable();
      t.string('full_name').nullable();
      t.text('global_roles').nullable();
      t.timestamp('email_verified_at').nullable();
      t.string('email_verification_token').nullable();
      t.string('password_reset_token').nullable();
      t.timestamp('password_reset_expires_at').nullable();
      t.timestamp('disabled_at').nullable();
      t.string('avatar_url').nullable();
    });
    await db.connection().schema.createTable('auth_mfa', (t: any) => {
      t.string('account_id').primary();
      t.text('totp_secret').nullable();
      t.timestamp('mfa_enabled_at').nullable();
      t.json('recovery_codes').nullable();
      t.bigInteger('last_totp_step').nullable();
    });
    __setAppKeyEncryptionForTesting(appEncryption);
    return async () => {
      __resetAppKeyEncryption();
      await db.manager.closeAll();
    };
  });

  async function enrolled(store: any, email: string) {
    const account = await store.create({ email, password: 'pass123456' });
    const started = await store.startTotpEnrollment(account.id);
    await store.confirmTotpEnrollment(account.id, generateSync({ secret: started.secret }));
    return { account, secret: started.secret as string };
  }

  test('new secrets are sealed with the kit, bound to their account', async ({ assert }) => {
    const store: any = lucidAccountStore(SecretsAccount);
    const { account, secret } = await enrolled(store, 'a@x.test');
    const row = await totpRow(db, account.id);
    assert.match(row.totp_secret, /^agora:v1:app\.v1:/);
    assert.notInclude(row.totp_secret, secret);
    assert.isTrue(await store.verifyTotp(account.id, generateSync({ secret })));

    // Copied onto another account, the secret does not open: that account's TOTP fails.
    const other = await enrolled(store, 'b@x.test');
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', other.account.id)
      .update({ totp_secret: row.totp_secret, last_totp_step: null });
    assert.isFalse(await store.verifyTotp(other.account.id, generateSync({ secret })));
  });

  test('secrets written by earlier versions (app encryption, no purpose) still verify', async ({
    assert,
  }) => {
    const store: any = lucidAccountStore(SecretsAccount);
    const { account, secret } = await enrolled(store, 'legacy@x.test');
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', account.id)
      .update({ totp_secret: appEncryption.encrypt(secret), last_totp_step: null });
    assert.isTrue(await store.verifyTotp(account.id, generateSync({ secret })));
    const report = await secretsOf(store).reseal({ report: true });
    assert.include(report, { column: 'auth_mfa.totp_secret', scanned: 1, legacy: 1 });
  });

  test('reseal migrates legacy secrets (dry-run writes nothing), then all are active', async ({
    assert,
  }) => {
    const store: any = lucidAccountStore(SecretsAccount);
    const { account, secret } = await enrolled(store, 'm@x.test');
    const legacy = appEncryption.encrypt(secret);
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', account.id)
      .update({ totp_secret: legacy, last_totp_step: null });

    const dry = await secretsOf(store).reseal({ dryRun: true });
    assert.include(dry, { legacy: 1, resealed: 1, failed: 0 });
    assert.equal((await totpRow(db, account.id)).totp_secret, legacy);

    const done = await secretsOf(store).reseal();
    assert.include(done, { resealed: 1, failed: 0, skipped: 0 });
    const after = (await totpRow(db, account.id)).totp_secret;
    assert.match(after, /^agora:v1:/);
    assert.include(await secretsOf(store).reseal({ report: true }), { active: 1, legacy: 0 });
    assert.isTrue(await store.verifyTotp(account.id, generateSync({ secret })));
  });

  test('crypto.keys: a secret under an older key is `retired`; reseal moves it; a dropped key is unreadable', async ({
    assert,
  }) => {
    const store: any = lucidAccountStore(SecretsAccount);
    bindCrypto(store, { keys: [APP_KEY] });
    const { account, secret } = await enrolled(store, 'r@x.test');

    bindCrypto(store, { keys: [NEW_KEY, APP_KEY] });
    assert.include(await secretsOf(store).reseal({ report: true }), { retired: 1 });
    assert.isTrue(await store.verifyTotp(account.id, generateSync({ secret })));
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', account.id)
      .update({ last_totp_step: null });
    assert.include(await secretsOf(store).reseal(), { resealed: 1 });

    bindCrypto(store, { keys: [NEW_KEY] });
    assert.include(await secretsOf(store).reseal({ report: true }), { active: 1 });
    assert.isTrue(await store.verifyTotp(account.id, generateSync({ secret })));

    bindCrypto(store, { keys: ['yet-another-key-of-32-characters'] });
    const gone = await secretsOf(store).reseal();
    assert.include(gone, { unreadable: 1, failed: 1 });
    assert.equal(sealedAtRestResult({ columns: [gone] }).status, 'error');
  });

  test('a tampered secret is refused (verifyTotp false)', async ({ assert }) => {
    const store: any = lucidAccountStore(SecretsAccount);
    const { account, secret } = await enrolled(store, 't@x.test');
    const sealed: string = (await totpRow(db, account.id)).totp_secret;
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[3] as string, 'base64url');
    tag[5] = (tag[5] as number) ^ 0x10;
    parts[3] = tag.toString('base64url');
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', account.id)
      .update({ totp_secret: parts.join('.'), last_totp_step: null });
    assert.isFalse(await store.verifyTotp(account.id, generateSync({ secret })));
    assert.include(await secretsOf(store).reseal({ report: true }), { unreadable: 1 });
  });

  test('a custom encrypter has no accountSecrets capability', async ({ assert }) => {
    const store: any = lucidAccountStore(SecretsAccount, {
      encrypter: { encrypt: (v) => v, decrypt: (v) => v },
    });
    assert.isUndefined(store.accountSecrets);
    assert.isUndefined(
      (lucidAccountStore(SecretsAccount, { encrypter: false }) as any).accountSecrets,
    );
  });
});

test.group('authkit.crypto doctor verdict', () => {
  const column = (overrides: Partial<SealedColumnReport>): SealedColumnReport => ({
    column: 'auth_mfa.totp_secret',
    scanned: 2,
    active: 2,
    retired: 0,
    legacy: 0,
    unreadable: 0,
    resealed: 0,
    failed: 0,
    skipped: 0,
    ...overrides,
  });

  test('ok, warn (legacy / retired), error (unreadable), skip (nothing sealed)', ({ assert }) => {
    assert.equal(sealedAtRestResult({ columns: [column({})] }).status, 'ok');
    const legacy = sealedAtRestResult({ columns: [column({ active: 1, legacy: 1 })] });
    assert.equal(legacy.status, 'warn');
    assert.include(legacy.message, 'pre-1.0');
    assert.include(legacy.fix ?? '', 'authkit:crypto:reseal');
    assert.equal(
      sealedAtRestResult({ columns: [column({ column: 'keystore', retired: 1, scanned: 1 })] })
        .status,
      'warn',
    );
    assert.equal(sealedAtRestResult({ columns: [column({ unreadable: 1 })] }).status, 'error');
    assert.equal(sealedAtRestResult({ columns: [] }).status, 'skip');
  });
});
