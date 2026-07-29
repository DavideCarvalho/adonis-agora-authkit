import { randomBytes, randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { authenticator } from 'otplib';
import {
  supportsAccountDeletion,
  supportsAccountImport,
  supportsEmailVerificationStatus,
  supportsPasskeys,
  supportsProviderIdentity,
} from '../../src/accounts/account_store.js';
import {
  __resetAppKeyEncryption,
  __setAppKeyEncryptionForTesting,
  appKeyEncrypter,
  lucidAccountStore,
} from '../../src/accounts/lucid_account_store.js';
import type { WebauthnCeremonies } from '../../src/accounts/lucid_account_store.js';
import { sha256Hex } from '../../src/accounts/lucid_store/token_hash.js';
import type { AuditEvent } from '../../src/audit/audit_sink.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { withMfa } from '../../src/mixins/with_mfa.js';
import { withProviderIdentity } from '../../src/mixins/with_provider_identity.js';
import { withWebauthnCredential } from '../../src/mixins/with_webauthn_credential.js';
import { PasswordPolicyError } from '../../src/password/password_manager.js';
import type { FetchLike } from '../../src/password/pwned.js';
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

class TestProviderIdentity extends compose(BaseModel, withProviderIdentity()) {
  static table = 'provider_identities';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: TestProviderIdentity) {
    if (!row.id) row.id = randomUUID();
  }
}

class TestWebauthnCredential extends compose(BaseModel, withWebauthnCredential()) {
  static table = 'webauthn_credentials';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
}

/**
 * Cerimônias WebAuthn mockadas: permitem testar registro/autenticação SEM um
 * authenticator real. `generate*` devolvem um challenge fixo + um id "fake";
 * `verify*` aceitam quando a resposta carrega `__valid: true`.
 */
function fakeCeremonies(credentialId = 'cred-1'): WebauthnCeremonies {
  return {
    generateRegistrationOptions: (async () => ({
      challenge: 'reg-challenge',
      rp: { name: 'Test', id: 'localhost' },
    })) as any,
    verifyRegistrationResponse: (async ({ response }: any) => {
      if (!response?.__valid) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: credentialId,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ['internal'],
          },
        },
      };
    }) as any,
    generateAuthenticationOptions: (async () => ({
      challenge: 'auth-challenge',
      rpId: 'localhost',
    })) as any,
    verifyAuthenticationResponse: (async ({ response }: any) => {
      if (!response?.__valid) return { verified: false, authenticationInfo: { newCounter: 0 } };
      return { verified: true, authenticationInfo: { newCounter: 5 } };
    }) as any,
  };
}

/**
 * Lê a linha lib-owned de `auth_mfa` (estado de MFA) por account_id. Substitui a
 * leitura antiga das colunas de MFA na própria `row` do model.
 */
async function readMfaRow(db: any, accountId: string) {
  const row = await db.connection().from('auth_mfa').where('account_id', accountId).first();
  if (!row) return null;
  return {
    totpSecret: row.totp_secret ?? null,
    mfaEnabledAt: row.mfa_enabled_at ?? null,
    recoveryCodes:
      row.recovery_codes === null || row.recovery_codes === undefined
        ? null
        : typeof row.recovery_codes === 'string'
          ? JSON.parse(row.recovery_codes)
          : row.recovery_codes,
    lastTotpStep:
      row.last_totp_step === null || row.last_totp_step === undefined
        ? null
        : Number(row.last_totp_step),
  };
}

test.group('lucidAccountStore', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
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
    // Estado de MFA agora é LIB-OWNED (tabela auth_mfa) — não mais colunas em users.
    await db.connection().schema.createTable('auth_mfa', (t: any) => {
      t.string('account_id').primary();
      t.text('totp_secret').nullable();
      t.timestamp('mfa_enabled_at').nullable();
      t.json('recovery_codes').nullable();
      t.bigInteger('last_totp_step').nullable();
    });
    await db.connection().schema.createTable('provider_identities', (t: any) => {
      t.string('id').primary();
      t.string('provider').notNullable();
      t.string('provider_user_id').notNullable();
      t.string('account_id').notNullable();
      t.string('email').nullable();
      t.timestamp('created_at').nullable();
      t.timestamp('updated_at').nullable();
      t.unique(['provider', 'provider_user_id']);
    });
    await db.connection().schema.createTable('webauthn_credentials', (t: any) => {
      t.string('id').primary();
      t.string('account_id').notNullable();
      t.text('public_key').notNullable();
      t.integer('counter').notNullable().defaultTo(0);
      t.text('transports').nullable();
      t.string('label').nullable();
      t.timestamp('created_at').nullable();
      t.timestamp('updated_at').nullable();
    });
    return async () => db.manager.closeAll();
  });

  test('create hasheia a senha e mapeia AuthAccount', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({
      email: 'a@b.com',
      password: 'Xk9pQ!mZr7nL', // senha única, não está na lista de senhas comuns
      fullName: 'Alice',
      globalRoles: ['ADMIN'],
    });
    assert.equal(acc.email, 'a@b.com');
    assert.equal(acc.name, 'Alice');
    assert.deepEqual(acc.globalRoles, ['ADMIN']);
    const row = await TestAccount.findBy('email', 'a@b.com');
    assert.notEqual(row!.password, 'Xk9pQ!mZr7nL'); // hash
  });

  test('findById e findByEmail retornam AuthAccount ou null', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const created = await store.create({ email: 'c@d.com', password: 'pw12345678' });
    assert.equal((await store.findById(created.id))!.email, 'c@d.com');
    assert.equal((await store.findByEmail('c@d.com'))!.id, created.id);
    assert.isNull(await store.findById('nope'));
    assert.isNull(await store.findByEmail('nobody@x.com'));
  });

  test('verifyCredentials confere a senha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'e@f.com', password: 'rightpass1' });
    assert.equal((await store.verifyCredentials('e@f.com', 'rightpass1'))!.email, 'e@f.com');
    assert.isNull(await store.verifyCredentials('e@f.com', 'wrongpass'));
    assert.isNull(await store.verifyCredentials('ghost@f.com', 'rightpass1'));
  });

  test('H5 anti-enumeração: e-mail inexistente também chama o verify (dummy hash)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    // Espia o PasswordManager.verify exposto internamente.
    const pm = (store as any).__passwordManager;
    assert.isOk(pm, 'deve expor __passwordManager');
    const original = pm.verify.bind(pm);
    let calledWithoutRow = false;
    pm.verify = async (hashed: string, plain: string, hooks: any) => {
      // O caminho sem-row roda contra um scrypt dummy ($scrypt$...).
      if (typeof hashed === 'string' && hashed.startsWith('$scrypt$')) {
        calledWithoutRow = true;
      }
      return original(hashed, plain, hooks);
    };
    try {
      const result = await store.verifyCredentials('ghost@nowhere.com', 'whatever1');
      assert.isNull(result);
      assert.isTrue(
        calledWithoutRow,
        'verify deve ser chamado mesmo sem conta (verificação dummy anti-timing)',
      );
    } finally {
      pm.verify = original;
    }
  });

  test('reset de senha: issue → consume válido troca a senha; reuso falha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'g@h.com', password: 'oldpass123' });
    const issued = await store.issuePasswordResetToken('g@h.com');
    assert.isNotNull(issued);
    assert.equal(issued!.account.email, 'g@h.com');

    const ok = await store.consumePasswordResetToken(issued!.token, 'newpass123');
    assert.isTrue(ok);
    assert.isNotNull(await store.verifyCredentials('g@h.com', 'newpass123'));
    // token foi limpo → reuso falha
    assert.isFalse(await store.consumePasswordResetToken(issued!.token, 'another123'));
  });

  test('issuePasswordResetToken retorna null pra email inexistente', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isNull(await store.issuePasswordResetToken('void@x.com'));
  });

  test('consumePasswordResetToken falha se expirado', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'i@j.com', password: 'oldpass123' });
    const issued = await store.issuePasswordResetToken('i@j.com');
    // força expiração no passado
    const row = await TestAccount.findBy('email', 'i@j.com');
    row!.passwordResetExpiresAt = DateTime.now().minus({ hours: 2 });
    await row!.save();
    assert.isFalse(await store.consumePasswordResetToken(issued!.token, 'newpass123'));
  });

  test('reset de senha: valor ARMAZENADO é um hash, não o token bruto devolvido', async ({
    assert,
  }) => {
    // Segurança (plan 007): um dump/leitura da tabela `users` não pode devolver
    // um token de reset diretamente usável.
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'hash-reset@h.com', password: 'oldpass123' });
    const issued = await store.issuePasswordResetToken('hash-reset@h.com');
    const row = await TestAccount.findBy('email', 'hash-reset@h.com');
    assert.notEqual(row!.passwordResetToken, issued!.token);
    // O round-trip com o token BRUTO ainda funciona (consumo hasheia antes do where).
    const ok = await store.consumePasswordResetToken(issued!.token, 'newpass1234');
    assert.isTrue(ok);
  });

  test('consumePasswordResetToken com token ERRADO (mas bem-formado) falha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'wrong-reset@h.com', password: 'oldpass123' });
    await store.issuePasswordResetToken('wrong-reset@h.com');
    const wrongToken = 'a'.repeat(64); // hex válido, mas não é o token emitido
    assert.isFalse(await store.consumePasswordResetToken(wrongToken, 'newpass1234'));
  });

  test('verificação de e-mail: issue → consume válido marca verificado; reuso falha', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'k@l.com', password: 'pass123456' });
    const issued = await store.issueEmailVerificationToken('k@l.com');
    assert.isNotNull(issued);
    assert.equal(issued!.account.email, 'k@l.com');

    const ok = await store.consumeEmailVerificationToken(issued!.token);
    assert.isTrue(ok);
    const row = await TestAccount.findBy('email', 'k@l.com');
    assert.isTrue(row!.isEmailVerified);
    assert.isNull(row!.emailVerificationToken);
    // token foi limpo → reuso falha
    assert.isFalse(await store.consumeEmailVerificationToken(issued!.token));
  });

  test('issueEmailVerificationToken retorna null pra email inexistente', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isNull(await store.issueEmailVerificationToken('void@x.com'));
  });

  test('consumeEmailVerificationToken falha pra token inválido ou vazio', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'm@n.com', password: 'pass123456' });
    assert.isFalse(await store.consumeEmailVerificationToken('nope'));
    assert.isFalse(await store.consumeEmailVerificationToken(''));
  });

  // ----- Self-service de segurança (senha / e-mail) -----

  test('changePassword: senha errada falha em verifyCredentials; nova passa', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'sec1@x.com', password: 'oldpass123' });
    // Senha atual errada não autentica.
    assert.isNull(await store.verifyCredentials('sec1@x.com', 'wrongpass'));
    // Troca de senha e verifica que a nova passa e a antiga não.
    assert.isTrue(await store.changePassword!(acc.id, 'newpass123'));
    assert.isNotNull(await store.verifyCredentials('sec1@x.com', 'newpass123'));
    assert.isNull(await store.verifyCredentials('sec1@x.com', 'oldpass123'));
  });

  test('changePassword retorna false para conta inexistente', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isFalse(await store.changePassword!('nope', 'whatever123'));
  });

  test('troca de e-mail: request → confirm aplica o novo e-mail (roundtrip)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'old@x.com', password: 'pass123456' });
    const issued = await store.requestEmailChange!(acc.id, 'new@x.com');
    assert.isNotNull(issued);
    assert.equal(issued!.newEmail, 'new@x.com');
    // O e-mail ainda NÃO mudou antes de confirmar.
    assert.equal((await store.findById(acc.id))!.email, 'old@x.com');

    const confirmed = await store.confirmEmailChange!(issued!.token);
    assert.isTrue(confirmed.ok);
    if (confirmed.ok) assert.equal(confirmed.newEmail, 'new@x.com');
    assert.equal((await store.findById(acc.id))!.email, 'new@x.com');
    const row = await TestAccount.find(acc.id);
    assert.isTrue(row!.isEmailVerified);
    // Token consumido → reuso falha.
    assert.isFalse((await store.confirmEmailChange!(issued!.token)).ok);
  });

  test('confirmEmailChange falha com token bogus / verificação normal não consome ec:', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'sec2@x.com', password: 'pass123456' });
    assert.isFalse((await store.confirmEmailChange!('bogus')).ok);
    assert.isFalse((await store.confirmEmailChange!('ec:bad')).ok);

    // Um token de troca de e-mail NÃO pode ser consumido como verificação de cadastro.
    const issued = await store.requestEmailChange!(acc.id, 'sec2new@x.com');
    assert.isFalse(await store.consumeEmailVerificationToken(issued!.token));
  });

  test('requestEmailChange retorna null quando o novo e-mail já pertence a outra conta', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'taken@x.com', password: 'pass123456' });
    const acc = await store.create({ email: 'me@x.com', password: 'pass123456' });
    assert.isNull(await store.requestEmailChange!(acc.id, 'taken@x.com'));
  });

  test('confirmEmailChange recusa se o e-mail foi tomado por OUTRA conta entre o pedido e a confirmação', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'race-a@x.com', password: 'pass123456' });
    const issued = await store.requestEmailChange!(acc.id, 'race-target@x.com');
    // Outra conta toma o e-mail-alvo ANTES da confirmação.
    await store.create({ email: 'race-target@x.com', password: 'pass123456' });
    const confirmed = await store.confirmEmailChange!(issued!.token);
    assert.isFalse(confirmed.ok);
    assert.equal((await store.findById(acc.id))!.email, 'race-a@x.com');
  });

  // ----- Expiração dos tokens de verificação/troca de e-mail (plan 009) -----

  test('verificação de e-mail: token expirado é recusado e NÃO marca verificado', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'exp-verify@x.com', password: 'pass123456' });
    const issued = await store.issueEmailVerificationToken('exp-verify@x.com');
    const [, random] = issued!.token.split(':');
    // Força o `exp` embutido para o passado — recomputa o dbValue coerente com
    // ele (senão a igualdade de hash nunca bateria e o teste não provaria nada
    // sobre expiração, só sobre token errado).
    const pastExp = DateTime.now().minus({ hours: 1 }).toMillis();
    const tamperedRaw = `${pastExp}:${random}`;
    const row = await TestAccount.findBy('email', 'exp-verify@x.com');
    row!.emailVerificationToken = `${pastExp}:${sha256Hex(random)}`;
    await row!.save();

    assert.isFalse(await store.consumeEmailVerificationToken(tamperedRaw));
    const after = await TestAccount.findBy('email', 'exp-verify@x.com');
    assert.isNull(after!.emailVerifiedAt);
  });

  test('troca de e-mail: token expirado é recusado e o e-mail NÃO muda', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'exp-change@x.com', password: 'pass123456' });
    const issued = await store.requestEmailChange!(acc.id, 'exp-change-new@x.com');
    const parts = issued!.token.split(':'); // ['ec', b64email, exp, random]
    const pastExp = DateTime.now().minus({ hours: 1 }).toMillis();
    const tamperedRaw = `ec:${parts[1]}:${pastExp}:${parts[3]}`;
    const row = await TestAccount.find(acc.id);
    row!.emailVerificationToken = `ec:${parts[1]}:${pastExp}:${sha256Hex(parts[3])}`;
    await row!.save();

    const confirmed = await store.confirmEmailChange!(tamperedRaw);
    assert.isFalse(confirmed.ok);
    assert.equal((await store.findById(acc.id))!.email, 'exp-change@x.com');
  });

  test('verificação de e-mail: exp ausente/não-parseável no valor armazenado conta como EXPIRADO (fail-closed)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'noexp-verify@x.com', password: 'pass123456' });
    const random = randomBytes(24).toString('hex');
    const garbageExp = 'not-a-number';
    const rawToken = `${garbageExp}:${random}`;
    const row = await TestAccount.findBy('email', 'noexp-verify@x.com');
    row!.emailVerificationToken = `${garbageExp}:${sha256Hex(random)}`;
    await row!.save();

    // O hash reconstruído a partir de `rawToken` BATE com o valor gravado
    // (mesmo `garbageExp`, mesmo `random`) — a linha É encontrada. O que
    // precisa falhar é a checagem de `exp`: `garbageExp` não é dígitos, então
    // `parseExpiringTokenExp` devolve null, e null DEVE contar como expirado.
    assert.isFalse(await store.consumeEmailVerificationToken(rawToken));
    const after = await TestAccount.findBy('email', 'noexp-verify@x.com');
    assert.isNull(after!.emailVerifiedAt);
  });

  test('troca de e-mail: exp ausente/não-parseável no valor armazenado conta como EXPIRADO (fail-closed)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'noexp-change@x.com', password: 'pass123456' });
    const encodedEmail = Buffer.from('noexp-change-new@x.com', 'utf8').toString('base64url');
    const random = randomBytes(24).toString('hex');
    const garbageExp = 'nope';
    const rawToken = `ec:${encodedEmail}:${garbageExp}:${random}`;
    const row = await TestAccount.find(acc.id);
    row!.emailVerificationToken = `ec:${encodedEmail}:${garbageExp}:${sha256Hex(random)}`;
    await row!.save();

    const confirmed = await store.confirmEmailChange!(rawToken);
    assert.isFalse(confirmed.ok);
    assert.equal((await store.findById(acc.id))!.email, 'noexp-change@x.com');
  });

  test('verificação de e-mail: exp adulterado pelo cliente (empurrado pro futuro) é recusado — hash não bate mais', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'tamper-verify@x.com', password: 'pass123456' });
    const issued = await store.issueEmailVerificationToken('tamper-verify@x.com');
    const [origExp, random] = issued!.token.split(':');
    const futureExp = DateTime.now().plus({ years: 10 }).toMillis();
    assert.notEqual(String(futureExp), origExp);
    const tamperedRaw = `${futureExp}:${random}`;

    // O `exp` é reescrito no token BRUTO (não no banco) — simula o cliente
    // editando a URL/valor antes de enviar. O dbValue reconstruído
    // (`futureExp:sha256(random)`) difere do que está gravado
    // (`origExp:sha256(random)`) só no segmento `exp` — a busca não encontra
    // NENHUMA linha.
    assert.isFalse(await store.consumeEmailVerificationToken(tamperedRaw));
    const after = await TestAccount.findBy('email', 'tamper-verify@x.com');
    assert.isNull(after!.emailVerifiedAt);
  });

  test('troca de e-mail: exp adulterado pelo cliente é recusado — hash não bate mais', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'tamper-change@x.com', password: 'pass123456' });
    const issued = await store.requestEmailChange!(acc.id, 'tamper-change-new@x.com');
    const parts = issued!.token.split(':');
    const futureExp = DateTime.now().plus({ years: 10 }).toMillis();
    assert.notEqual(String(futureExp), parts[2]);
    const tamperedRaw = `ec:${parts[1]}:${futureExp}:${parts[3]}`;

    const confirmed = await store.confirmEmailChange!(tamperedRaw);
    assert.isFalse(confirmed.ok);
    assert.equal((await store.findById(acc.id))!.email, 'tamper-change@x.com');
  });

  test('emailTokens.changeTtlHours customizado é aplicado no exp gravado', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, { emailTokens: { changeTtlHours: 2 } });
    const acc = await store.create({ email: 'custom-ttl-change@x.com', password: 'pass123456' });
    const before = DateTime.now();
    const issued = await store.requestEmailChange!(acc.id, 'custom-ttl-change-new@x.com');
    const parts = issued!.token.split(':');
    const exp = Number(parts[2]);
    const expectedApprox = before.plus({ hours: 2 }).toMillis();
    assert.isTrue(
      Math.abs(exp - expectedApprox) < 5000,
      'exp deveria refletir o TTL customizado (2h)',
    );
  });

  test('emailTokens.verificationTtlHours customizado é aplicado no exp gravado', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount, { emailTokens: { verificationTtlHours: 48 } });
    await store.create({ email: 'custom-ttl-verify@x.com', password: 'pass123456' });
    const before = DateTime.now();
    const issued = await store.issueEmailVerificationToken('custom-ttl-verify@x.com');
    const [exp] = issued!.token.split(':');
    const expectedApprox = before.plus({ hours: 48 }).toMillis();
    assert.isTrue(
      Math.abs(Number(exp) - expectedApprox) < 5000,
      'exp deveria refletir o TTL customizado (48h)',
    );
  });

  // ----- Status (disable/enable) + Perfil -----

  test('disable/enable: isDisabled reflete o estado e updateProfile altera nome/avatar', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'st1@x.com', password: 'pass123456', fullName: 'Old' });

    // Status: capacidade presente (model tem disabled_at).
    assert.isTrue('disableAccount' in store);
    assert.isFalse(await store.isDisabled!(acc.id));
    await store.disableAccount!(acc.id);
    assert.isTrue(await store.isDisabled!(acc.id));
    await store.enableAccount!(acc.id);
    assert.isFalse(await store.isDisabled!(acc.id));
    // Conta inexistente: isDisabled false, métodos no-op.
    assert.isFalse(await store.isDisabled!('nope'));
    await assert.doesNotReject(() => store.disableAccount!('nope'));

    // Perfil: capacidade presente (model tem full_name/avatar_url).
    assert.isTrue('updateProfile' in store);
    const updated = await store.updateProfile!(acc.id, {
      name: 'New',
      avatarUrl: 'https://x/a.png',
    });
    assert.equal(updated!.name, 'New');
    assert.equal(updated!.avatarUrl, 'https://x/a.png');
    const reloaded = await store.findById(acc.id);
    assert.equal(reloaded!.name, 'New');
    assert.equal(reloaded!.avatarUrl, 'https://x/a.png');
    // null limpa o valor; undefined preserva.
    const cleared = await store.updateProfile!(acc.id, { avatarUrl: null });
    assert.equal(cleared!.name, 'New');
    assert.isUndefined(cleared!.avatarUrl);
    assert.isNull(await store.updateProfile!('nope', { name: 'X' }));
  });

  // ----- Verificação de e-mail (estado) -----

  test('isEmailVerified reflete o estado da conta (capability presente)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isTrue(supportsEmailVerificationStatus(store));
    const acc = await store.create({ email: 'ev1@x.com', password: 'pass123456' });
    // Recém-criada sem emailVerified → false.
    assert.isFalse(await store.isEmailVerified!(acc.id));
    // Verifica via token → true.
    const issued = await store.issueEmailVerificationToken('ev1@x.com');
    await store.consumeEmailVerificationToken(issued!.token);
    assert.isTrue(await store.isEmailVerified!(acc.id));
    // Conta inexistente → false.
    assert.isFalse(await store.isEmailVerified!('nope'));
  });

  test('create com emailVerified: true marca verificado', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({
      email: 'ev2@x.com',
      password: 'pass123456',
      emailVerified: true,
    });
    assert.isTrue(await store.isEmailVerified!(acc.id));
  });

  test('capability isEmailVerified AUSENTE quando o model não tem email_verified_at', async ({
    assert,
  }) => {
    // Model mínimo SEM a coluna email_verified_at → a capacidade não é montada.
    class NoVerifyAccount extends compose(BaseModel, withAuthUser(), withCredentials(), withMfa()) {
      static table = 'users';
      static selfAssignPrimaryKey = true;
      @column({ isPrimary: true })
      declare id: string;
      @beforeCreate()
      static assignId(row: NoVerifyAccount) {
        if (!row.id) row.id = randomUUID();
      }
    }
    // Remove a coluna da definição (o probe usa $columnsDefinitions).
    NoVerifyAccount.$columnsDefinitions.delete('emailVerifiedAt');
    const store = lucidAccountStore(NoVerifyAccount);
    assert.isFalse('isEmailVerified' in store);
    assert.isFalse(supportsEmailVerificationStatus(store));
  });

  // ----- Deleção de conta (LGPD) -----

  test('deleteAccount apaga a linha (capability sempre presente) e retorna false p/ inexistente', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isTrue(supportsAccountDeletion(store));
    const acc = await store.create({ email: 'del1@x.com', password: 'pass123456' });
    assert.isTrue(await store.deleteAccount!(acc.id));
    assert.isNull(await store.findById(acc.id));
    // Segunda vez → false (não existe mais).
    assert.isFalse(await store.deleteAccount!(acc.id));
    assert.isFalse(await store.deleteAccount!('nope'));
  });

  test('unlinkAllProviderIdentities + listProviderIdentities (sem tokens)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, { providerIdentityModel: TestProviderIdentity });
    const acc = await store.create({ email: 'del2@x.com', password: 'pass123456' });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-1',
      email: 'g@x.com',
    });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'github',
      providerUserId: 'h-1',
    });

    const list = await store.listProviderIdentities!(acc.id);
    assert.lengthOf(list, 2);
    // Só provider/providerUserId/email — nenhum campo de token.
    assert.deepEqual(Object.keys(list[0]).sort(), ['email', 'provider', 'providerUserId']);

    const removed = await store.unlinkAllProviderIdentities!(acc.id);
    assert.equal(removed, 2);
    assert.lengthOf(await store.listProviderIdentities!(acc.id), 0);
  });

  // ----- MFA / TOTP -----

  test('startTotpEnrollment retorna secret + otpauthUri e deixa o MFA pendente', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount, { mfaIssuer: 'MyApp' });
    const acc = await store.create({ email: 'mfa1@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    assert.isNotNull(started);
    assert.isString(started!.secret);
    assert.match(started!.otpauthUri, /^otpauth:\/\/totp\//);
    assert.include(decodeURIComponent(started!.otpauthUri), 'MyApp');
    // ainda pendente → getMfaState desligado
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);
  });

  test('startTotpEnrollment retorna null pra conta inexistente', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isNull(await store.startTotpEnrollment!('nope'));
  });

  test('confirmTotpEnrollment com código válido ativa o MFA e gera recovery codes', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa2@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    const code = authenticator.generate(started!.secret);

    const result = await store.confirmTotpEnrollment!(acc.id, code);
    assert.isTrue(result.ok);
    assert.lengthOf(result.recoveryCodes!, 8);
    assert.isTrue((await store.getMfaState!(acc.id)).enabled);

    const mfa = await readMfaRow(db, acc.id);
    assert.isNotNull(mfa!.mfaEnabledAt);
    // armazenados como hashes, não plaintext
    assert.notInclude(mfa!.recoveryCodes ?? [], result.recoveryCodes![0]);
    assert.lengthOf(mfa!.recoveryCodes ?? [], 8);
  });

  test('confirmTotpEnrollment com código inválido não ativa', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa3@x.com', password: 'pass123456' });
    await store.startTotpEnrollment!(acc.id);
    const result = await store.confirmTotpEnrollment!(acc.id, '000000');
    assert.isFalse(result.ok);
    assert.isUndefined(result.recoveryCodes);
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);
  });

  test('verifyTotp confere o código contra o segredo ativo', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa4@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));

    assert.isTrue(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));
    assert.isFalse(await store.verifyTotp!(acc.id, '000000'));
  });

  test('verifyTotp é false quando o MFA não está ativo (segredo pendente)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa5@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    // pendente, não confirmado
    assert.isFalse(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));
  });

  // ----- M3: anti-replay TOTP -----

  test('verifyTotp: o MESMO código falha na 2ª verificação (anti-replay)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'replay1@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));

    const code = authenticator.generate(started!.secret);
    // 1ª vez: aceito.
    assert.isTrue(await store.verifyTotp!(acc.id, code));
    // 2ª vez, MESMO código, MESMA janela: rejeitado (replay).
    assert.isFalse(await store.verifyTotp!(acc.id, code));

    // O step aceito foi persistido.
    const mfa = await readMfaRow(db, acc.id);
    assert.isNumber(mfa!.lastTotpStep);
  });

  test('verifyTotp: persiste o step ATUAL (floor(epoch/period)) no sucesso', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'replay2@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));

    const period = authenticator.allOptions().step || 30;
    const expectedStep = Math.floor(Date.now() / 1000 / period);

    assert.isTrue(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));
    const mfa = await readMfaRow(db, acc.id);
    assert.equal(mfa!.lastTotpStep, expectedStep);
  });

  test('verifyTotp: um step FUTURO (maior que o último) é aceito; um <= é rejeitado', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'replay2b@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));

    const period = authenticator.allOptions().step || 30;
    const currentStep = Math.floor(Date.now() / 1000 / period);

    // Pré-condição: lastTotpStep ANTERIOR ao step atual → o código atual (step maior) é aceito.
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', acc.id)
      .update({ last_totp_step: currentStep - 1 });
    assert.isTrue(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));

    // Agora lastTotpStep == currentStep → o MESMO código (step == último) é rejeitado.
    assert.isFalse(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));

    // E um lastTotpStep no FUTURO (maior) rejeita o código atual (step menor).
    await db
      .connection()
      .from('auth_mfa')
      .where('account_id', acc.id)
      .update({ last_totp_step: currentStep + 5 });
    assert.isFalse(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));
  });

  test('verifyTotp: re-enroll zera o anti-replay (novo segredo aceita de novo)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'replay3@x.com', password: 'pass123456' });
    const s1 = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(s1!.secret));
    const code1 = authenticator.generate(s1!.secret);
    assert.isTrue(await store.verifyTotp!(acc.id, code1));

    // Re-enroll: novo segredo, lastTotpStep deve ser zerado.
    const s2 = await store.startTotpEnrollment!(acc.id);
    const mfa = await readMfaRow(db, acc.id);
    assert.isNull(mfa!.lastTotpStep);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(s2!.secret));
    // Verifica com o novo segredo — funciona normalmente.
    assert.isTrue(await store.verifyTotp!(acc.id, authenticator.generate(s2!.secret)));
  });

  test('consumeRecoveryCode é single-use', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa6@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    const { recoveryCodes } = await store.confirmTotpEnrollment!(
      acc.id,
      authenticator.generate(started!.secret),
    );
    const code = recoveryCodes![0];

    assert.isTrue(await store.consumeRecoveryCode!(acc.id, code));
    // segunda vez falha (consumido)
    assert.isFalse(await store.consumeRecoveryCode!(acc.id, code));
    // código inexistente falha
    assert.isFalse(await store.consumeRecoveryCode!(acc.id, 'zzzzz-zzzzz'));
  });

  test('disableMfa limpa segredo + mfaEnabledAt + recovery codes', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa7@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));
    assert.isTrue((await store.getMfaState!(acc.id)).enabled);

    await store.disableMfa!(acc.id);
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);
    // disable LIMPA o estado lib-owned: a linha de auth_mfa some por completo.
    const mfa = await readMfaRow(db, acc.id);
    assert.isNull(mfa);
  });

  test('com encrypter: segredo TOTP é encriptado em repouso e verifyTotp continua válido', async ({
    assert,
  }) => {
    // Encrypter stub: round-trip base64 (não é o raw secret no banco).
    const encrypter = {
      encrypt: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
      decrypt: (v: string) => {
        try {
          return Buffer.from(v, 'base64').toString('utf8');
        } catch {
          return null;
        }
      },
    };
    const store = lucidAccountStore(TestAccount, { encrypter });
    const acc = await store.create({ email: 'enc1@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);

    // O valor persistido NÃO é o segredo raw — está encriptado.
    const mfa = await readMfaRow(db, acc.id);
    assert.notEqual(mfa!.totpSecret, started!.secret);
    assert.equal(encrypter.decrypt(mfa!.totpSecret as string), started!.secret);

    // Confirma + verifica usando códigos gerados a partir do segredo raw.
    const confirmed = await store.confirmTotpEnrollment!(
      acc.id,
      authenticator.generate(started!.secret),
    );
    assert.isTrue(confirmed.ok);
    assert.isTrue(await store.verifyTotp!(acc.id, authenticator.generate(started!.secret)));
    assert.isFalse(await store.verifyTotp!(acc.id, '000000'));
  });

  test('com encrypter: segredo adulterado (decrypt → null) invalida verifyTotp/confirm', async ({
    assert,
  }) => {
    // decrypt sempre falha → trata como "sem segredo".
    const encrypter = {
      encrypt: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
      decrypt: (_v: string) => null,
    };
    const store = lucidAccountStore(TestAccount, { encrypter });
    const acc = await store.create({ email: 'enc2@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    // confirm falha porque o segredo "não abre"
    const confirmed = await store.confirmTotpEnrollment!(
      acc.id,
      authenticator.generate(started!.secret),
    );
    assert.isFalse(confirmed.ok);
  });

  test('sem encrypter: segredo TOTP fica em claro (comportamento legado)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'enc3@x.com', password: 'pass123456' });
    const started = await store.startTotpEnrollment!(acc.id);
    const mfa = await readMfaRow(db, acc.id);
    assert.equal(mfa!.totpSecret, started!.secret);
  });

  // ----- M4: appKeyEncrypter fail-closed -----

  test('appKeyEncrypter: decrypt de valor adulterado retorna null (fail-closed)', async ({
    assert,
    cleanup,
  }) => {
    // Injeta um serviço de encryption fake cujo decrypt LANÇA (simula ciphertext
    // adulterado / APP_KEY trocada). O encrypter NÃO pode degradar para o valor
    // cru — deve negar retornando null.
    __setAppKeyEncryptionForTesting({
      encrypt: (v: string) => `enc:${v}`,
      decrypt: () => {
        throw new Error('invalid mac / tampered');
      },
    });
    cleanup(() => __resetAppKeyEncryption());

    const enc = appKeyEncrypter();
    // M4: o catch do decrypt retorna null (negar), NÃO o ciphertext cru.
    assert.isNull(enc.decrypt('garbage-ciphertext'));
  });

  test('appKeyEncrypter: decrypt válido faz round-trip (serviço presente)', async ({
    assert,
    cleanup,
  }) => {
    const map = new Map<string, string>();
    __setAppKeyEncryptionForTesting({
      encrypt: (v: string) => {
        const c = `enc:${v}`;
        map.set(c, v);
        return c;
      },
      decrypt: <T = string>(c: string) => (map.get(c) as T) ?? null,
    });
    cleanup(() => __resetAppKeyEncryption());

    const enc = appKeyEncrypter();
    const cipher = enc.encrypt('topsecret');
    assert.notEqual(cipher, 'topsecret');
    assert.equal(enc.decrypt(cipher), 'topsecret');
  });

  test('appKeyEncrypter: decrypt que devolve null (sem throw) também é null', async ({
    assert,
    cleanup,
  }) => {
    __setAppKeyEncryptionForTesting({
      encrypt: (v: string) => v,
      decrypt: () => null,
    });
    cleanup(() => __resetAppKeyEncryption());
    const enc = appKeyEncrypter();
    assert.isNull(enc.decrypt('whatever'));
  });

  test('getMfaState reflete habilitado/desabilitado', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({ email: 'mfa8@x.com', password: 'pass123456' });
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);
    const started = await store.startTotpEnrollment!(acc.id);
    await store.confirmTotpEnrollment!(acc.id, authenticator.generate(started!.secret));
    assert.isTrue((await store.getMfaState!(acc.id)).enabled);
  });

  // ----- Account linking por provider identity -----

  test('linkProviderIdentity → findByProviderIdentity retorna a conta', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      providerIdentityModel: TestProviderIdentity,
    });
    const acc = await store.create({ email: 'link1@x.com', password: 'pass123456' });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-123',
      email: 'link1@x.com',
    });
    const found = await store.findByProviderIdentity('google', 'g-123');
    assert.isNotNull(found);
    assert.equal(found!.id, acc.id);
    assert.equal(found!.email, 'link1@x.com');
  });

  test('linkProviderIdentity é idempotente: não duplica e atualiza o email', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      providerIdentityModel: TestProviderIdentity,
    });
    const acc = await store.create({ email: 'link2@x.com', password: 'pass123456' });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-dup',
      email: 'old@x.com',
    });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-dup',
      email: 'new@x.com',
    });
    const rows = await TestProviderIdentity.query()
      .where('provider', 'google')
      .where('providerUserId', 'g-dup');
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].email, 'new@x.com');
    assert.equal((await store.findByProviderIdentity('google', 'g-dup'))!.id, acc.id);
  });

  test('findByProviderIdentity retorna null pra identidade desconhecida', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      providerIdentityModel: TestProviderIdentity,
    });
    assert.isNull(await store.findByProviderIdentity('github', 'unknown'));
  });

  test('dois providers diferentes podem ligar à mesma conta', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      providerIdentityModel: TestProviderIdentity,
    });
    const acc = await store.create({ email: 'link3@x.com', password: 'pass123456' });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'gg-1',
    });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'github',
      providerUserId: 'gh-1',
    });
    assert.equal((await store.findByProviderIdentity('google', 'gg-1'))!.id, acc.id);
    assert.equal((await store.findByProviderIdentity('github', 'gh-1'))!.id, acc.id);
  });

  test('capacidade de provider-identity AUSENTE sem providerIdentityModel', async ({ assert }) => {
    // Sem o model, a capacidade inteira não é montada: os métodos não existem
    // (em vez de presentes-mas-lançando).
    const store = lucidAccountStore(TestAccount);
    assert.isFalse('findByProviderIdentity' in store);
    assert.isFalse('linkProviderIdentity' in store);
    assert.isFalse(supportsProviderIdentity(store));
  });

  test('capacidade de provider-identity PRESENTE com providerIdentityModel', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, { providerIdentityModel: TestProviderIdentity });
    assert.isTrue('findByProviderIdentity' in store);
    assert.isTrue('linkProviderIdentity' in store);
    assert.isTrue(supportsProviderIdentity(store));
  });

  // ----- Administração (console admin — B6) -----

  test('listAccounts retorna dados paginados + total', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    for (let i = 0; i < 5; i++) {
      await store.create({ email: `list-${i}@x.com`, password: 'pass123456' });
    }
    const firstPage = await store.listAccounts({ page: 1, limit: 2 });
    assert.equal(firstPage.total, 5);
    assert.lengthOf(firstPage.data, 2);

    const secondPage = await store.listAccounts({ page: 2, limit: 2 });
    assert.lengthOf(secondPage.data, 2);
    // Páginas distintas não repetem (ordenado por email).
    assert.notEqual(firstPage.data[0].id, secondPage.data[0].id);

    const thirdPage = await store.listAccounts({ page: 3, limit: 2 });
    assert.lengthOf(thirdPage.data, 1);
  });

  test('listAccounts filtra por email (substring)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'alice@example.com', password: 'pass123456' });
    await store.create({ email: 'bob@example.com', password: 'pass123456' });
    await store.create({ email: 'carol@other.com', password: 'pass123456' });

    const example = await store.listAccounts({ search: 'example.com' });
    assert.equal(example.total, 2);

    const bob = await store.listAccounts({ search: 'bob' });
    assert.equal(bob.total, 1);
    assert.equal(bob.data[0].email, 'bob@example.com');

    const none = await store.listAccounts({ search: 'nobody' });
    assert.equal(none.total, 0);
    assert.lengthOf(none.data, 0);
  });

  test('setGlobalRoles persiste as roles globais', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const acc = await store.create({
      email: 'roles@x.com',
      password: 'pass123456',
      globalRoles: [],
    });
    await store.setGlobalRoles(acc.id, ['ADMIN', 'EDITOR']);

    const reloaded = await store.findById(acc.id);
    assert.deepEqual(reloaded!.globalRoles, ['ADMIN', 'EDITOR']);

    // Substitui (não acumula).
    await store.setGlobalRoles(acc.id, ['VIEWER']);
    assert.deepEqual((await store.findById(acc.id))!.globalRoles, ['VIEWER']);
  });

  test('setGlobalRoles em conta inexistente é no-op', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await assert.doesNotReject(() => store.setGlobalRoles('nope', ['ADMIN']));
  });

  // ----- MFA / WebAuthn (passkeys) -----

  const webauthnStore = () =>
    lucidAccountStore(TestAccount, {
      webauthnCredentialModel: TestWebauthnCredential,
      webauthn: { rpName: 'Test', rpId: 'localhost', origin: 'http://localhost' },
      webauthnCeremonies: fakeCeremonies(),
    });

  test('generatePasskeyRegistrationOptions devolve options + challenge; null pra conta inexistente', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk1@x.com', password: 'pass123456' });
    const gen = await store.generatePasskeyRegistrationOptions!(acc.id);
    assert.isNotNull(gen);
    assert.equal(gen!.challenge, 'reg-challenge');
    assert.isObject(gen!.options);
    assert.isNull(await store.generatePasskeyRegistrationOptions!('nope'));
  });

  test('verifyPasskeyRegistration: resposta válida persiste credencial e habilita MFA', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk2@x.com', password: 'pass123456' });
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);

    const ok = await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    assert.isTrue(ok);
    // MFA habilitado e credencial persistida.
    assert.isTrue((await store.getMfaState!(acc.id)).enabled);
    const list = await store.listPasskeys!(acc.id);
    assert.lengthOf(list, 1);
    assert.equal(list[0].id, 'cred-1');

    const row = await TestWebauthnCredential.find('cred-1');
    assert.equal(row!.accountId, acc.id);
    // publicKey armazenado como base64url (Uint8Array [1,2,3,4]).
    assert.equal(row!.publicKey, Buffer.from([1, 2, 3, 4]).toString('base64url'));
    assert.deepEqual(row!.transports, ['internal']);
  });

  test('verifyPasskeyRegistration: resposta inválida não persiste nada', async ({ assert }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk3@x.com', password: 'pass123456' });
    const ok = await store.verifyPasskeyRegistration!(acc.id, { __valid: false }, 'reg-challenge');
    assert.isFalse(ok);
    assert.lengthOf(await store.listPasskeys!(acc.id), 0);
    assert.isFalse((await store.getMfaState!(acc.id)).enabled);
  });

  test('listPasskeys / removePasskey funcionam por conta', async ({ assert }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk4@x.com', password: 'pass123456' });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    assert.lengthOf(await store.listPasskeys!(acc.id), 1);

    await store.removePasskey!(acc.id, 'cred-1');
    assert.lengthOf(await store.listPasskeys!(acc.id), 0);
  });

  test('generatePasskeyAuthenticationOptions: null sem credenciais, options + challenge com', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk5@x.com', password: 'pass123456' });
    assert.isNull(await store.generatePasskeyAuthenticationOptions!(acc.id));

    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    const gen = await store.generatePasskeyAuthenticationOptions!(acc.id);
    assert.isNotNull(gen);
    assert.equal(gen!.challenge, 'auth-challenge');
  });

  test('verifyPasskeyAuthentication: resposta válida atualiza o counter e retorna true', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk6@x.com', password: 'pass123456' });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');

    const ok = await store.verifyPasskeyAuthentication!(
      acc.id,
      { id: 'cred-1', __valid: true },
      'auth-challenge',
    );
    assert.isTrue(ok);
    // counter atualizado pelo newCounter mockado (5).
    const row = await TestWebauthnCredential.find('cred-1');
    assert.equal(row!.counter, 5);
  });

  test('verifyPasskeyAuthentication: resposta inválida retorna false e não muda o counter', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk7@x.com', password: 'pass123456' });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');

    const ok = await store.verifyPasskeyAuthentication!(
      acc.id,
      { id: 'cred-1', __valid: false },
      'auth-challenge',
    );
    assert.isFalse(ok);
    const row = await TestWebauthnCredential.find('cred-1');
    assert.equal(row!.counter, 0);
  });

  test('verifyPasskeyAuthentication: credential id desconhecido retorna false', async ({
    assert,
  }) => {
    const store = webauthnStore();
    const acc = await store.create({ email: 'pk8@x.com', password: 'pass123456' });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    const ok = await store.verifyPasskeyAuthentication!(
      acc.id,
      { id: 'unknown', __valid: true },
      'auth-challenge',
    );
    assert.isFalse(ok);
  });

  test('capacidade de passkey AUSENTE sem webauthnCredentialModel', async ({ assert }) => {
    // Sem o model, a capacidade WebAuthn inteira não é montada: os métodos não
    // existem no store (em vez de presentes-mas-lançando).
    const store = lucidAccountStore(TestAccount);
    assert.isFalse('generatePasskeyRegistrationOptions' in store);
    assert.isFalse('verifyPasskeyRegistration' in store);
    assert.isFalse('generatePasskeyAuthenticationOptions' in store);
    assert.isFalse('verifyPasskeyAuthentication' in store);
    assert.isFalse('listPasskeys' in store);
    assert.isFalse('removePasskey' in store);
    assert.isFalse(supportsPasskeys(store));
  });

  test('capacidade de passkey PRESENTE com webauthnCredentialModel', async ({ assert }) => {
    const store = webauthnStore();
    assert.isTrue('generatePasskeyRegistrationOptions' in store);
    assert.isTrue('listPasskeys' in store);
    assert.isTrue(supportsPasskeys(store));
  });

  // MFA é capacidade SEMPRE presente (não depende de model opcional).
  test('capacidade de MFA sempre presente', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isTrue('getMfaState' in store);
    assert.isTrue('verifyTotp' in store);
  });
});

test.group('lucidAccountStore — senha (rehash/legacy/política/import)', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
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
    // Estado de MFA agora é LIB-OWNED (tabela auth_mfa) — não mais colunas em users.
    await db.connection().schema.createTable('auth_mfa', (t: any) => {
      t.string('account_id').primary();
      t.text('totp_secret').nullable();
      t.timestamp('mfa_enabled_at').nullable();
      t.json('recovery_codes').nullable();
      t.bigInteger('last_totp_step').nullable();
    });
    return async () => db.manager.closeAll();
  });

  test('lazy rehash: hash legado migra no login + emite password.rehashed', async ({ assert }) => {
    const events: AuditEvent[] = [];
    // Senha legada armazenada num "formato de outro sistema" (prefixo desconhecido).
    const LEGACY_HASH = 'legacy$plain:secret';
    const store = lucidAccountStore(TestAccount, {
      audit: {
        record: async (e) => {
          events.push(e);
        },
      },
      password: {
        // Reconhece o formato legado: confere comparando o sufixo.
        legacyVerifier: async (hashed, plain) => {
          if (!hashed.startsWith('legacy$plain:')) return null;
          return hashed.slice('legacy$plain:'.length) === plain;
        },
      },
    });
    // Insere a conta com o hash legado COMO ESTÁ (via import — sem re-hash).
    const created = await store.importAccount({ email: 'leg@b.com', passwordHash: LEGACY_HASH });
    assert.isNotNull(created);
    let row = await TestAccount.findBy('email', 'leg@b.com');
    assert.equal(row!.password, LEGACY_HASH);

    // Login com a senha correta → confere via legacy → re-hasheia transparente.
    const acc = await store.verifyCredentials('leg@b.com', 'secret');
    assert.isNotNull(acc);
    row = await TestAccount.findBy('email', 'leg@b.com');
    assert.notEqual(row!.password, LEGACY_HASH); // migrado para o hasher atual (scrypt)
    assert.isTrue(row!.password.startsWith('$scrypt$'));
    // Login subsequente confere pelo hasher nativo (sem novo rehash).
    assert.isNotNull(await store.verifyCredentials('leg@b.com', 'secret'));
    assert.equal(events.filter((e) => e.type === 'password.rehashed').length, 1);
  });

  test('legacyVerifier false → login falha (senha errada)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      password: {
        legacyVerifier: async (hashed, plain) =>
          hashed === 'legacy$plain:right' ? plain === 'right' : null,
      },
    });
    await store.importAccount({ email: 'l2@b.com', passwordHash: 'legacy$plain:right' });
    assert.isNull(await store.verifyCredentials('l2@b.com', 'wrong'));
    assert.isNotNull(await store.verifyCredentials('l2@b.com', 'right'));
  });

  test('legacyVerifier null (formato não tratado) → login falha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, {
      password: { legacyVerifier: async () => null },
    });
    await store.importAccount({ email: 'l3@b.com', passwordHash: 'unknown-format-hash' });
    assert.isNull(await store.verifyCredentials('l3@b.com', 'whatever'));
  });

  test('rehash fail-safe: falha ao salvar o rehash NÃO falha o login', async ({ assert }) => {
    const events: AuditEvent[] = [];
    const store = lucidAccountStore(TestAccount, {
      audit: {
        record: async (e) => {
          events.push(e);
        },
      },
      password: {
        legacyVerifier: async (hashed, plain) =>
          hashed === 'legacy$plain:s' ? plain === 's' : null,
      },
    });
    await store.importAccount({ email: 'l4@b.com', passwordHash: 'legacy$plain:s' });
    // Força o save do rehash a falhar mockando o save no prototype da row.
    const proto = Object.getPrototypeOf(await TestAccount.findBy('email', 'l4@b.com'));
    const originalSave = proto.save;
    proto.save = async () => {
      throw new Error('save failed');
    };
    try {
      // Mesmo com o save do rehash falhando, o login deve ter sucesso.
      const acc = await store.verifyCredentials('l4@b.com', 's');
      assert.isNotNull(acc);
      // O evento de rehash NÃO é emitido (o save falhou antes).
      assert.equal(events.filter((e) => e.type === 'password.rehashed').length, 0);
    } finally {
      proto.save = originalSave;
    }
  });

  test('política: create rejeita senha curta com PasswordPolicyError', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount, { password: { policy: { minLength: 10 } } });
    await assert.rejects(
      () => store.create({ email: 'p@b.com', password: 'short' }),
      PasswordPolicyError as any,
    );
    // Senha cumprindo a política passa.
    const ok = await store.create({ email: 'p2@b.com', password: 'longenoughpw' });
    assert.equal(ok.email, 'p2@b.com');
  });

  test('política via policyOverride: assertAcceptable com minLength > 8 rejeita senha curta', async ({
    assert,
  }) => {
    // Política vive em runtime settings; testamos via assertAcceptable(password, policyOverride).
    const store = lucidAccountStore(TestAccount);
    // Acessa o PasswordManager interno via __passwordManager.
    const pm = (store as any).__passwordManager;
    assert.isOk(pm, 'deve expor __passwordManager');
    await assert.rejects(
      () => pm.assertAcceptable('short', { minLength: 10 }),
      PasswordPolicyError as any,
    );
    // Senha longa o suficiente passa.
    await pm.assertAcceptable('longenoughpw', { minLength: 10 });
  });

  test('política: checkPwned via policyOverride bloqueia senha vazada (fetch injetado)', async ({
    assert,
  }) => {
    const { createHash } = await import('node:crypto');
    const suffix = createHash('sha1')
      .update('leakedpass1', 'utf8')
      .digest('hex')
      .toUpperCase()
      .slice(5);
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => `${suffix}:5\n`,
    });
    const store = lucidAccountStore(TestAccount, {
      pwnedFetch: fetchImpl,
    });
    const pm = (store as any).__passwordManager;
    await assert.rejects(
      () => pm.assertAcceptable('leakedpass1', { checkPwned: true }),
      PasswordPolicyError as any,
    );
  });

  test('importAccount: insere hash COMO ESTÁ, pula duplicados', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isTrue(supportsAccountImport(store));
    const created = await store.importAccount({
      email: 'imp@b.com',
      passwordHash: '$2y$10$abcdefghijklmnopqrstuv',
      fullName: 'Acme Importer',
      emailVerified: true,
    });
    assert.isNotNull(created);
    const row = await TestAccount.findBy('email', 'imp@b.com');
    assert.equal(row!.password, '$2y$10$abcdefghijklmnopqrstuv'); // sem re-hash
    assert.isNotNull(row!.emailVerifiedAt);
    // Duplicado → null.
    const dup = await store.importAccount({ email: 'imp@b.com', passwordHash: 'x' });
    assert.isNull(dup);
  });

  test('importAccount sem passwordHash: cria com senha aleatória inutilizável', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    const created = await store.importAccount({ email: 'noh@b.com' });
    assert.isNotNull(created);
    const row = await TestAccount.findBy('email', 'noh@b.com');
    // Senha aleatória hasheada (scrypt) — não é vazia.
    assert.isTrue(row!.password.startsWith('$scrypt$'));
  });
});
