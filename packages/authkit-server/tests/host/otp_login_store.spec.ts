import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { supportsOtpLogin } from '../../src/accounts/account_store.js';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { decodeOtpToken } from '../../src/host/otp_login.js';
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
    t.timestamp('disabled_at').nullable();
    t.text('global_roles').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
  await db.connection().schema.createTable('auth_mfa', (t: any) => {
    t.string('account_id').primary();
    t.text('totp_secret').nullable();
    t.timestamp('mfa_enabled_at').nullable();
    t.json('recovery_codes').nullable();
    t.bigInteger('last_totp_step').nullable();
  });
  return db;
}

const OPTS = { digits: 6, ttlMinutes: 10 };
const MAX = { maxAttempts: 5 };

test.group('otp login (lucid store)', (group) => {
  let close: () => Promise<void>;
  group.each.setup(async () => {
    const db = await setupDb();
    close = async () => db.manager.closeAll();
    return () => close();
  });

  test('store expõe a capacidade de OTP login', async ({ assert }) => {
    assert.isTrue(supportsOtpLogin(lucidAccountStore(TestAccount)));
  });

  test('issueMagicLinkWithCode emite token de link (ml2:) + código de 6 dígitos', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'a@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('a@l.com', 'uid-1', OPTS);
    assert.isNotNull(issued);
    assert.isTrue(issued!.token.startsWith('ml2:'));
    assert.match(issued!.code, /^[0-9]{6}$/);
    // O código NÃO vaza no token da URL.
    assert.notInclude(issued!.token, issued!.code);
  });

  test('e-mail inexistente → null (anti-enumeração no controller)', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    assert.isNull(await store.issueMagicLinkWithCode!('ghost@l.com', 'uid-1', OPTS));
  });

  test('verify feliz completa (devolve a conta) — mesmo resultado do link', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    const created = await store.create({ email: 'b@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('b@l.com', 'uid-2', OPTS);
    const res = await store.verifyLoginCode!('b@l.com', 'uid-2', issued!.code, MAX);
    assert.equal(res.status, 'ok');
    assert.equal(res.status === 'ok' ? res.account.id : null, created.id);
  });

  test('código atrelado à interaction: uid diferente → invalid', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'c@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('c@l.com', 'uid-A', OPTS);
    const res = await store.verifyLoginCode!('c@l.com', 'uid-B', issued!.code, MAX);
    assert.equal(res.status, 'invalid');
  });

  test('código errado 5× → invalidado; e o LINK AINDA funciona', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'd@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('d@l.com', 'uid-3', OPTS);

    // 4 falhas: invalid (contador incrementa).
    for (let i = 0; i < 4; i++) {
      const r = await store.verifyLoginCode!('d@l.com', 'uid-3', '000000', MAX);
      assert.equal(r.status, 'invalid');
    }
    // 5ª falha: locked (código invalidado).
    assert.equal(
      (await store.verifyLoginCode!('d@l.com', 'uid-3', '000000', MAX)).status,
      'locked',
    );
    // Tentar o código CERTO depois de travado → locked (código morto).
    assert.equal(
      (await store.verifyLoginCode!('d@l.com', 'uid-3', issued!.code, MAX)).status,
      'locked',
    );
    // Mas o MAGIC LINK continua válido e consumível.
    const acc = await store.consumeMagicLinkToken!(issued!.token);
    assert.isNotNull(acc);
    assert.equal(acc!.email, 'd@l.com');
  });

  test('single-use conjunto: consumir o CÓDIGO mata o LINK', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'e@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('e@l.com', 'uid-4', OPTS);
    assert.equal(
      (await store.verifyLoginCode!('e@l.com', 'uid-4', issued!.code, MAX)).status,
      'ok',
    );
    // Link morto após o código ser usado.
    assert.isNull(await store.consumeMagicLinkToken!(issued!.token));
  });

  test('single-use conjunto: consumir o LINK mata o CÓDIGO', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'f@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('f@l.com', 'uid-5', OPTS);
    assert.isNotNull(await store.consumeMagicLinkToken!(issued!.token));
    // Código morto após o link ser usado.
    assert.equal(
      (await store.verifyLoginCode!('f@l.com', 'uid-5', issued!.code, MAX)).status,
      'no_code',
    );
  });

  test('código expirado → expired', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'g@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('g@l.com', 'uid-6', {
      digits: 6,
      ttlMinutes: 10,
    });
    // Força a expiração DO CÓDIGO reescrevendo o slot com codeExpMs no passado.
    const row = await TestAccount.findBy('email', 'g@l.com');
    const slot = row!.passwordResetToken as string;
    const parts = slot.split(':'); // ml2:<link>:<hash>:<exp>:<att>
    parts[3] = String(Date.now() - 1000);
    row!.passwordResetToken = parts.join(':');
    await row!.save();
    assert.equal(
      (await store.verifyLoginCode!('g@l.com', 'uid-6', issued!.code, MAX)).status,
      'expired',
    );
  });

  test('contador NÃO vaza entre contas/interactions distintas', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'h1@l.com', password: 'pw12345678' });
    await store.create({ email: 'h2@l.com', password: 'pw12345678' });
    const i1 = await store.issueMagicLinkWithCode!('h1@l.com', 'uid-h1', OPTS);
    const i2 = await store.issueMagicLinkWithCode!('h2@l.com', 'uid-h2', OPTS);
    // Esgota a conta 1.
    for (let i = 0; i < 5; i++) await store.verifyLoginCode!('h1@l.com', 'uid-h1', '000000', MAX);
    assert.equal(
      (await store.verifyLoginCode!('h1@l.com', 'uid-h1', i1!.code, MAX)).status,
      'locked',
    );
    // A conta 2 está intacta: código certo → ok.
    assert.equal((await store.verifyLoginCode!('h2@l.com', 'uid-h2', i2!.code, MAX)).status, 'ok');
  });

  test('re-request substitui o código e REINICIA o contador (gera código NOVO)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'i@l.com', password: 'pw12345678' });
    const first = await store.issueMagicLinkWithCode!('i@l.com', 'uid-7', OPTS);
    // Gasta 3 tentativas.
    for (let i = 0; i < 3; i++) await store.verifyLoginCode!('i@l.com', 'uid-7', '000000', MAX);
    // Re-request: novo código, contador zerado. O código ANTIGO deixa de valer.
    const second = await store.issueMagicLinkWithCode!('i@l.com', 'uid-7', OPTS);
    assert.notEqual(first!.code, second!.code);
    assert.equal(
      (await store.verifyLoginCode!('i@l.com', 'uid-7', first!.code, MAX)).status,
      'invalid',
    );
    // O NOVO código verifica de primeira (contador reiniciado, sem herdar as 3 falhas).
    assert.equal(
      (await store.verifyLoginCode!('i@l.com', 'uid-7', second!.code, MAX)).status,
      'ok',
    );
  });

  test('slot ml2: NÃO é consumível como reset de senha', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'j@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('j@l.com', 'uid-8', OPTS);
    assert.isFalse(await store.consumePasswordResetToken(issued!.token, 'hacked12345'));
    // A senha original continua válida.
    assert.isNotNull(await store.verifyCredentials('j@l.com', 'pw12345678'));
  });

  test('concorrência NÃO derrota o lockout: N chutes errados simultâneos ≤ maxAttempts', async ({
    assert,
  }) => {
    // Regressão de segurança (Critical): o read-modify-write do contador de
    // lockout precisa ser ATÔMICO. Sem atomicidade, N requests concorrentes leem
    // o mesmo contador e todos gravam `attempts+1` (last-write-wins) → o lockout
    // de 5 tentativas nunca dispara e o código de 6 dígitos vira brute-forceável.
    // Aqui disparamos 20 verificações concorrentes com o código ERRADO contra o
    // MESMO e-mail (DB real do harness) e provamos que:
    //   (a) no MÁXIMO maxAttempts chutes foram CONTADOS (status 'invalid'); e
    //   (b) o estado final é LOCKED (contador saturado, codeHash zerado); e
    //   (c) o código CERTO depois disso é recusado (locked); mas
    //   (d) o LINK — barreira separada — continua válido (o lockout não o mata).
    // Prova de mutação: revertendo verifyLoginCode para `row.save()` simples (sem
    // transação/forUpdate), o passo (a) fica VERMELHO (os 20 viram 'invalid',
    // 20 > 5) e o (b)/(c) também (contador preso em 1, código certo → 'ok').
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'race@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('race@l.com', 'uid-race', OPTS);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.verifyLoginCode!('race@l.com', 'uid-race', '000000', MAX),
      ),
    );

    // (a) No máximo maxAttempts tentativas foram ACEITAS (consumiram slot →
    // 'invalid'); as demais bateram no lockout já saturado ('locked').
    const invalidCount = results.filter((r) => r.status === 'invalid').length;
    const lockedCount = results.filter((r) => r.status === 'locked').length;
    assert.isAtMost(invalidCount, MAX.maxAttempts);
    assert.equal(invalidCount + lockedCount, 20);
    assert.isAbove(lockedCount, 0);

    // (b) Estado final: contador saturado e código invalidado (locked).
    const row = await TestAccount.findBy('email', 'race@l.com');
    const parsed = decodeOtpToken(row!.passwordResetToken);
    assert.isNotNull(parsed);
    assert.equal(parsed!.attempts, MAX.maxAttempts);
    assert.equal(parsed!.codeHash, '');

    // (c) O código CERTO agora é recusado — o lockout venceu a corrida.
    assert.equal(
      (await store.verifyLoginCode!('race@l.com', 'uid-race', issued!.code, MAX)).status,
      'locked',
    );

    // (d) O LINK (barreira separada) NÃO foi morto pelo lockout do código.
    const acc = await store.consumeMagicLinkToken!(issued!.token);
    assert.isNotNull(acc);
    assert.equal(acc!.email, 'race@l.com');
  });

  test('verifyLoginCode para conta sem código pendente → no_code', async ({ assert }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'k@l.com', password: 'pw12345678' });
    assert.equal(
      (await store.verifyLoginCode!('k@l.com', 'uid-9', '000000', MAX)).status,
      'no_code',
    );
    assert.equal(
      (await store.verifyLoginCode!('ghost@l.com', 'uid-9', '000000', MAX)).status,
      'no_code',
    );
  });

  test('slot ml2: o link-token ARMAZENADO é um hash (não contém o token bruto da URL)', async ({
    assert,
  }) => {
    // Segurança (plan 007): a parte "link" do slot ml2 é a mais fácil de
    // implementar "parecendo hasheada" mas não estar — o slot é um composto que
    // o código PARSEIA (linkToken:codeHash:codeExpMs:attempts), e a busca é um
    // LIKE por prefixo, não uma igualdade.
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'hash-ml2@l.com', password: 'pw12345678' });
    const issued = await store.issueMagicLinkWithCode!('hash-ml2@l.com', 'uid-hash', OPTS);
    const row = await TestAccount.findBy('email', 'hash-ml2@l.com');
    const rawLinkToken = issued!.token.slice('ml2:'.length);
    assert.notInclude(row!.passwordResetToken!, rawLinkToken);
    // O round-trip com o token BRUTO da URL ainda funciona (consome o link).
    const acc = await store.consumeMagicLinkToken!(issued!.token);
    assert.isNotNull(acc);
  });

  test('consumeMagicLinkToken (ml2) com link-token ERRADO (mas hex de 64 válido) falha', async ({
    assert,
  }) => {
    const store = lucidAccountStore(TestAccount);
    await store.create({ email: 'wrong-ml2@l.com', password: 'pw12345678' });
    await store.issueMagicLinkWithCode!('wrong-ml2@l.com', 'uid-wrong', OPTS);
    assert.isNull(await store.consumeMagicLinkToken!(`ml2:${'a'.repeat(64)}`));
  });
});
