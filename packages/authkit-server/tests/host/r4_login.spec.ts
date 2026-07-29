import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { supportsMagicLink } from '../../src/accounts/account_store.js';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { resolvePasswordless } from '../../src/define_config.js';
import {
  buildTrustedDevicePayload,
  isTrustedDeviceValid,
  resolveTrustedDevices,
} from '../../src/host/trusted_device.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { withMfa } from '../../src/mixins/with_mfa.js';
import { createTestDatabase } from '../bootstrap.js';

class TestAccount extends compose(BaseModel, withAuthUser(), withCredentials(), withMfa()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @column()
  declare avatarUrl: string | null;
  @column.dateTime()
  declare disabledAt: DateTime | null;
  @beforeCreate()
  static assignId(row: TestAccount) {
    if (!row.id) row.id = randomUUID();
  }
}

async function setupDb() {
  const db = await createTestDatabase();
  BaseModel.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('users', (t: any) => {
    t.string('id').primary();
    t.string('email').notNullable();
    t.string('password').notNullable();
    t.string('full_name').nullable();
    t.string('avatar_url').nullable();
    t.timestamp('disabled_at').nullable();
    t.text('global_roles').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
  // Estado de MFA é LIB-OWNED (auth_mfa) — não mais colunas em users.
  await db.connection().schema.createTable('auth_mfa', (t: any) => {
    t.string('account_id').primary();
    t.text('totp_secret').nullable();
    t.timestamp('mfa_enabled_at').nullable();
    t.json('recovery_codes').nullable();
    t.bigInteger('last_totp_step').nullable();
  });
  return db;
}

// --------------------------------------------------------------------------
// 1) Trusted devices — cookie payload puro
// --------------------------------------------------------------------------

test.group('trusted devices (helper puro)', () => {
  test('resolve defaults: ligado, 30 dias (política via runtime setting)', ({ assert }) => {
    // resolveTrustedDevices sempre retorna lib defaults — política via settings.
    assert.deepEqual(resolveTrustedDevices(), { enabled: true, days: 30 });
    assert.deepEqual(resolveTrustedDevices({}), { enabled: true, days: 30 });
  });

  test('cookie válido pula o MFA no 2º login (mesma conta, não expirado)', ({ assert }) => {
    const cfg = resolveTrustedDevices();
    const now = 1_000_000;
    const payload = buildTrustedDevicePayload('acc-1', cfg, now);
    assert.isTrue(
      isTrustedDeviceValid(payload, { accountId: 'acc-1', mfaEnabledAt: 500_000, now: now + 1000 }),
    );
  });

  test('cookie de OUTRA conta não é válido', ({ assert }) => {
    const payload = buildTrustedDevicePayload('acc-1', resolveTrustedDevices(), 1000);
    assert.isFalse(isTrustedDeviceValid(payload, { accountId: 'acc-2', now: 2000 }));
  });

  test('cookie expirado não é válido', ({ assert }) => {
    // Usa cfg diretamente com 1 dia para testar expiração.
    const cfg = { enabled: true, days: 1 };
    const payload = buildTrustedDevicePayload('acc-1', cfg, 0);
    const afterExpiry = 2 * 24 * 60 * 60 * 1000;
    assert.isFalse(isTrustedDeviceValid(payload, { accountId: 'acc-1', now: afterExpiry }));
  });

  test('re-enrollment do MFA invalida cookie emitido antes (iat < mfaEnabledAt)', ({ assert }) => {
    const cfg = resolveTrustedDevices();
    const iat = 1000;
    const payload = buildTrustedDevicePayload('acc-1', cfg, iat);
    // MFA re-enrolado DEPOIS do cookie → inválido.
    assert.isFalse(
      isTrustedDeviceValid(payload, { accountId: 'acc-1', mfaEnabledAt: 5000, now: 6000 }),
    );
    // MFA enrolado ANTES do cookie → válido.
    assert.isTrue(
      isTrustedDeviceValid(payload, { accountId: 'acc-1', mfaEnabledAt: 500, now: 6000 }),
    );
  });

  test('payloads malformados são rejeitados', ({ assert }) => {
    assert.isFalse(isTrustedDeviceValid(null, { accountId: 'a' }));
    assert.isFalse(isTrustedDeviceValid('nope', { accountId: 'a' }));
    assert.isFalse(isTrustedDeviceValid({ a: 1 }, { accountId: 'a' }));
  });
});

// --------------------------------------------------------------------------
// 2) Passwordless — config resolver
// --------------------------------------------------------------------------

test.group('passwordless (config resolver)', () => {
  test('defaults desligados', ({ assert }) => {
    assert.deepEqual(resolvePasswordless(), {
      magicLink: false,
      passkeyFirst: false,
      signup: false,
    });
  });
  test('liga seletivamente', ({ assert }) => {
    assert.deepEqual(resolvePasswordless({ magicLink: true }), {
      magicLink: true,
      passkeyFirst: false,
      signup: false,
    });
    assert.deepEqual(resolvePasswordless({ passkeyFirst: true }), {
      magicLink: false,
      passkeyFirst: true,
      signup: false,
    });
    assert.deepEqual(resolvePasswordless({ signup: true }), {
      magicLink: false,
      passkeyFirst: false,
      signup: true,
    });
  });
});

// --------------------------------------------------------------------------
// 3) Magic link — store-backed (Lucid)
// --------------------------------------------------------------------------

test.group('magic link (lucid store)', (group) => {
  let close: () => Promise<void>;
  group.each.setup(async () => {
    const db = await setupDb();
    close = async () => db.manager.closeAll();
    return () => close();
  });

  test('store expõe a capacidade de magic link', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isTrue(supportsMagicLink(store));
  });

  test('issue → consume completa o login (devolve a conta)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const created = await store.create({ email: 'm@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkToken!('m@l.com');
    assert.isNotNull(issued);
    assert.isTrue(issued!.token.startsWith('ml:'));
    const acc = await store.consumeMagicLinkToken!(issued!.token);
    assert.equal(acc!.id, created.id);
  });

  test('consumo é single-use', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 's@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkToken!('s@l.com');
    assert.isNotNull(await store.consumeMagicLinkToken!(issued!.token));
    assert.isNull(await store.consumeMagicLinkToken!(issued!.token));
  });

  test('token bogus/expirado falha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'e@l.com', password: 'pw12345678' });
    assert.isNull(await store.consumeMagicLinkToken!('ml:bogus'));
    assert.isNull(await store.consumeMagicLinkToken!('not-a-magic-token'));
    // Token expirado.
    const issued = await store.issueMagicLinkToken!('e@l.com');
    const row = await TestAccount.findBy('email', 'e@l.com');
    row!.passwordResetExpiresAt = DateTime.now().minus({ minutes: 1 });
    await row!.save();
    assert.isNull(await store.consumeMagicLinkToken!(issued!.token));
  });

  test('issue para e-mail inexistente devolve null (anti-enumeração no controller)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isNull(await store.issueMagicLinkToken!('ghost@l.com'));
  });

  test('magic link NÃO pode ser consumido como reset de senha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'x@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkToken!('x@l.com');
    // O `ml:` é rejeitado pelo consumePasswordResetToken (não troca a senha).
    assert.isFalse(await store.consumePasswordResetToken(issued!.token, 'hacked12345'));
    // A senha original continua válida.
    assert.isNotNull(await store.verifyCredentials('x@l.com', 'pw12345678'));
  });

  test('valor ARMAZENADO do magic link é um hash, não o token bruto devolvido', async ({
    assert,
  }) => {
    // Segurança (plan 007): um dump/leitura da tabela `users` não pode devolver
    // um magic link diretamente usável. O prefixo `ml:` continua em CLARO (a
    // discriminação de fluxo depende de lê-lo direto do valor armazenado).
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'hash-ml@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkToken!('hash-ml@l.com');
    const row = await TestAccount.findBy('email', 'hash-ml@l.com');
    assert.notEqual(row!.passwordResetToken, issued!.token);
    assert.isTrue(row!.passwordResetToken!.startsWith('ml:'));
    // O round-trip com o token BRUTO ainda funciona.
    const acc = await store.consumeMagicLinkToken!(issued!.token);
    assert.isNotNull(acc);
  });

  test('consumeMagicLinkToken com token ERRADO (mas com prefixo ml: válido) falha', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'wrong-ml@l.com', password: 'pw12345678' });
    await store.issueMagicLinkToken!('wrong-ml@l.com');
    assert.isNull(await store.consumeMagicLinkToken!(`ml:${'a'.repeat(64)}`));
  });
});

// --------------------------------------------------------------------------
// 4) getMfaState expõe enabledAt (para o trusted-device check)
// --------------------------------------------------------------------------

test.group('getMfaState.enabledAt', (group) => {
  let close: () => Promise<void>;
  group.each.setup(async () => {
    const db = await setupDb();
    close = async () => db.manager.closeAll();
    return () => close();
  });

  test('enabledAt nulo quando MFA desligado; epoch ms quando ligado', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const created = await store.create({ email: 'mfa@l.com', password: 'pw12345678' });
    const before = await store.getMfaState!(created.id);
    assert.isFalse(before.enabled);
    assert.isNull(before.enabledAt ?? null);

    // Liga o MFA gravando mfa_enabled_at direto na tabela lib-owned auth_mfa
    // (sem cerimônia TOTP completa).
    await TestAccount.query()
      .client.table('auth_mfa')
      .insert({ account_id: created.id, mfa_enabled_at: new Date() });
    const after = await store.getMfaState!(created.id);
    assert.isTrue(after.enabled);
    assert.isNumber(after.enabledAt);
  });
});
