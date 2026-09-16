import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

/** Conta com o mesmo nome de tabela que o scaffold da lib usa. */
class AuthUserModel extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'auth_users';

  @column({ isPrimary: true })
  declare id: string;
}

/** Conta sem `static table`: o nome tem de sair da naming strategy do Lucid. */
class PersonModel extends compose(BaseModel, withAuthUser(), withCredentials()) {
  @column({ isPrimary: true })
  declare id: string;
}

test.group('ensureAuthkitSchema', (group) => {
  let db: ReturnType<typeof createTestDatabase>;

  group.each.setup(() => {
    db = createTestDatabase();
    return () => db.manager.closeAll();
  });

  test('cria todas as tabelas do authkit num banco vazio', async ({ assert }) => {
    const report = await ensureAuthkitSchema(db);

    assert.sameMembers(report.created, [
      'authkit_oidc_payloads',
      'auth_settings',
      'auth_password_history',
      'auth_mfa',
      'auth_organizations',
      'auth_organization_members',
      'auth_organization_invitations',
      'auth_session_revocations',
    ]);
    assert.deepEqual(report.altered, {});

    /* as tabelas funcionam de verdade */
    await db.table('auth_settings').insert({ key: 'registration', value: '{"enabled":true}' });
    const rows = await db.query().from('auth_settings').select('*');
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].key, 'registration');
  });

  test('é idempotente — segunda execução não cria nem altera nada', async ({ assert }) => {
    await ensureAuthkitSchema(db);
    const second = await ensureAuthkitSchema(db);

    assert.deepEqual(second.created, []);
    assert.deepEqual(second.altered, {});
  });

  test('adiciona colunas faltantes em tabela já existente (aditivo)', async ({ assert }) => {
    /* simula host com uma versão antiga da tabela: sem organization_id/updated_by */
    await db.connection().schema.createTable('auth_settings', (t) => {
      t.string('key').primary();
      t.text('value').notNullable();
      t.timestamp('updated_at').nullable();
    });
    await db.table('auth_settings').insert({ key: 'lockout', value: '{}' });

    const report = await ensureAuthkitSchema(db);

    assert.notInclude(report.created, 'auth_settings');
    assert.sameMembers(report.altered.auth_settings, ['organization_id', 'updated_by']);

    /* dado pré-existente intacto + coluna nova utilizável */
    const rows = await db
      .query()
      .from('auth_settings')
      .select('key', 'value', 'organization_id', 'updated_by');
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].key, 'lockout');
    assert.isNull(rows[0].organization_id);
  });

  test('não cria tabelas que não são do authkit, mas garante login_methods em users', async ({
    assert,
  }) => {
    await db.connection().schema.createTable('users', (t) => {
      t.increments('id');
      t.string('email');
    });

    const report = await ensureAuthkitSchema(db);

    assert.notInclude(report.created, 'users');
    /* coluna consumida pela lib foi adicionada (users é host-owned; não criamos a tabela) */
    assert.sameMembers(report.altered.users ?? [], ['login_methods']);
    const hasLoginMethods = await db.connection().schema.hasColumn('users', 'login_methods');
    assert.isTrue(hasLoginMethods);
    /* dados pré-existentes intactos */
    const info = await db.connection().schema.hasColumn('users', 'email');
    assert.isTrue(info);
  });

  test('login_methods: idempotente em users já com a coluna', async ({ assert }) => {
    await db.connection().schema.createTable('users', (t) => {
      t.increments('id');
      t.string('email');
    });
    await ensureAuthkitSchema(db);

    const second = await ensureAuthkitSchema(db);
    assert.notInclude(second.altered.users ?? [], 'login_methods');
  });

  test('accountTable: coluna vai para a tabela da CONTA, não para um `users` homônimo (regressão)', async ({
    assert,
  }) => {
    /**
     * Cenário real do bug: a conta vive em `auth_users` (nome que o próprio
     * scaffold da lib usa) e existe OUTRA tabela chamada `users`, de outro dono
     * — o starter do AdonisJS cria uma. Com o nome fixo, o ALTER acertava a
     * tabela errada e passava, sem erro.
     */
    await db.connection().schema.createTable('users', (t) => {
      t.increments('id');
      t.string('email');
    });
    await db.connection().schema.createTable('auth_users', (t) => {
      t.string('id').primary();
      t.string('email');
    });

    const report = await ensureAuthkitSchema(db, { accountTable: 'auth_users' });

    assert.isTrue(await db.connection().schema.hasColumn('auth_users', 'login_methods'));
    assert.isFalse(
      await db.connection().schema.hasColumn('users', 'login_methods'),
      'a coluna não pode ir para a tabela homônima',
    );
    assert.sameMembers(report.altered.auth_users ?? [], ['login_methods']);
    assert.deepEqual(report.loginMethods, { table: 'auth_users', ensured: true });
  });

  test('sem accountTable mantém `users` (back-compat para stores próprios)', async ({ assert }) => {
    await db.connection().schema.createTable('users', (t) => {
      t.increments('id');
      t.string('email');
    });

    const report = await ensureAuthkitSchema(db);

    assert.deepEqual(report.loginMethods, { table: 'users', ensured: true });
    assert.sameMembers(report.altered.users ?? [], ['login_methods']);
  });

  test('reporta ensured: false quando a tabela da conta não existe', async ({ assert }) => {
    /**
     * É o silêncio que escondia o sintoma: nada foi feito e o host não tinha como
     * saber. Agora o report (e o warning do provider) dizem.
     */
    const report = await ensureAuthkitSchema(db, { accountTable: 'auth_users' });

    assert.deepEqual(report.loginMethods, { table: 'auth_users', ensured: false });
    assert.notProperty(report.altered, 'auth_users');
  });

  test('o store expõe accountTable — de `static table` e da naming strategy', async ({
    assert,
  }) => {
    BaseModel.useAdapter(db.modelAdapter());

    assert.equal(lucidAccountStore(AuthUserModel).accountTable, 'auth_users');
    /* sem `static table`, o nome sai da naming strategy (snake_case + plural) */
    assert.equal(lucidAccountStore(PersonModel).accountTable, 'person_models');
  });

  test('auth_mfa: tabela lib-owned aceita estado de MFA por account_id', async ({ assert }) => {
    await ensureAuthkitSchema(db);

    await db.table('auth_mfa').insert({
      account_id: 'u1',
      totp_secret: 'enc-secret',
      mfa_enabled_at: new Date(),
      recovery_codes: JSON.stringify(['hash1', 'hash2']),
      last_totp_step: 1234567,
    });
    const rows = await db.query().from('auth_mfa').where('account_id', 'u1').select('*');
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].totp_secret, 'enc-secret');
    assert.equal(Number(rows[0].last_totp_step), 1234567);

    /* account_id é PK → 2ª inserção do mesmo id falha */
    await assert.rejects(() => db.table('auth_mfa').insert({ account_id: 'u1' }));
  });

  test('organizations: FK e unique funcionam nas tabelas criadas', async ({ assert }) => {
    await ensureAuthkitSchema(db);

    await db.table('auth_organizations').insert({ id: 'org1', name: 'Acme', slug: 'acme' });
    await db
      .table('auth_organization_members')
      .insert({ id: 'm1', organization_id: 'org1', account_id: 'u1', role: 'owner' });

    /* unique (organization_id, account_id) */
    await assert.rejects(() =>
      db
        .table('auth_organization_members')
        .insert({ id: 'm2', organization_id: 'org1', account_id: 'u1' }),
    );
  });
});
