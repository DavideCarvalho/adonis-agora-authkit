import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import type { WebauthnCeremonies } from '../../src/accounts/lucid_account_store.js';
import { DatabaseAdapter } from '../../src/adapters/database_adapter.js';
import { lucidAuditSink } from '../../src/audit/lucid_audit_sink.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import { AccountDeletionService } from '../../src/host/account_deletion_service.js';
import { AccountExportService } from '../../src/host/account_export_service.js';
import { withAuditLog } from '../../src/mixins/with_audit_log.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { withMfa } from '../../src/mixins/with_mfa.js';
import { withPersonalAccessToken } from '../../src/mixins/with_personal_access_token.js';
import { withProviderIdentity } from '../../src/mixins/with_provider_identity.js';
import { withWebauthnCredential } from '../../src/mixins/with_webauthn_credential.js';
import { lucidPatStore } from '../../src/pat/lucid_pat_store.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase } from '../bootstrap.js';

// ---- Models (Acme app) ----

class Account extends compose(BaseModel, withAuthUser(), withCredentials(), withMfa()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @column()
  declare fullName: string | null;
  @column()
  declare avatarUrl: string | null;
  @beforeCreate()
  static assignId(row: Account) {
    if (!row.id) row.id = randomUUID();
  }
}

class ProviderIdentity extends compose(BaseModel, withProviderIdentity()) {
  static table = 'provider_identities';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: ProviderIdentity) {
    if (!row.id) row.id = randomUUID();
  }
}

class WebauthnCredential extends compose(BaseModel, withWebauthnCredential()) {
  static table = 'webauthn_credentials';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
}

class Pat extends compose(BaseModel, withPersonalAccessToken()) {
  static table = 'personal_access_tokens';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: Pat) {
    if (!row.id) row.id = randomUUID();
  }
}

class AuditLog extends compose(BaseModel, withAuditLog()) {
  static table = 'audit_logs';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: AuditLog) {
    if (!row.id) row.id = randomUUID();
  }
}

function fakeCeremonies(credentialId = 'cred-1'): WebauthnCeremonies {
  return {
    generateRegistrationOptions: (async () => ({ challenge: 'reg-challenge' })) as any,
    verifyRegistrationResponse: (async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      },
    })) as any,
    generateAuthenticationOptions: (async () => ({ challenge: 'auth-challenge' })) as any,
    verifyAuthenticationResponse: (async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })) as any,
  };
}

async function migrate(db: any) {
  // Liga os models Lucid (Account/PAT/etc.) ao adapter deste DB de teste.
  BaseModel.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('authkit_oidc_payloads', (t: any) => {
    t.string('id').notNullable();
    t.string('model_name').notNullable();
    t.text('payload').notNullable();
    t.string('grant_id').nullable();
    t.string('user_code').nullable();
    t.string('uid').nullable();
    t.timestamp('expires_at').nullable();
    t.primary(['model_name', 'id']);
  });
  await db.connection().schema.createTable('users', (t: any) => {
    t.string('id').primary();
    t.string('email').notNullable();
    t.string('password').notNullable();
    t.string('full_name').nullable();
    t.string('avatar_url').nullable();
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
  await db.connection().schema.createTable('personal_access_tokens', (t: any) => {
    t.string('id').primary();
    t.string('user_id').notNullable();
    t.string('name').notNullable();
    t.string('token_hash').notNullable();
    t.text('scopes').nullable();
    t.string('audience').nullable();
    t.timestamp('expires_at').nullable();
    t.timestamp('last_used_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });
  await db.connection().schema.createTable('audit_logs', (t: any) => {
    t.string('id').primary();
    t.string('type').notNullable();
    t.string('account_id').nullable();
    t.string('email').nullable();
    t.string('client_id').nullable();
    t.string('actor_id').nullable();
    t.string('ip').nullable();
    t.text('metadata').nullable();
    t.timestamp('created_at').nullable();
  });
}

async function startService(port: number, db: any) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const store = lucidAccountStore(Account, {
    providerIdentityModel: ProviderIdentity,
    webauthnCredentialModel: WebauthnCredential,
    webauthn: { rpName: 'Acme', rpId: 'localhost', origin: 'http://localhost' },
    webauthnCeremonies: fakeCeremonies(),
  });
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'acme-web',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code', 'refresh_token'],
        },
      ],
      accountStore: store,
      patStore: lucidPatStore(Pat),
      audit: lucidAuditSink(AuditLog),
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, cfg: cfg!, server, store };
}

async function seedArtifacts(db: any, accountId: string, grantId: string) {
  const session = new DatabaseAdapter('Session', db);
  const grant = new DatabaseAdapter('Grant', db);
  const at = new DatabaseAdapter('AccessToken', db);
  const rt = new DatabaseAdapter('RefreshToken', db);
  await session.upsert(
    `sess-${accountId}`,
    { accountId, loginTs: 1700000000, amr: ['pwd'] } as any,
    3600,
  );
  await grant.upsert(grantId, { accountId, clientId: 'acme-web' } as any, 3600);
  await at.upsert(`at-${accountId}`, { accountId, clientId: 'acme-web', grantId } as any, 3600);
  await rt.upsert(`rt-${accountId}`, { accountId, clientId: 'acme-web', grantId } as any, 3600);
}

test.group('AccountDeletionService (cascade LGPD/GDPR)', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('cascade completo: cada artefato some, audit anonimizado mas preservado', async ({
    assert,
    cleanup,
  }) => {
    const port = 9871;
    const { service, cfg, server, store } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Conta alvo com TODOS os artefatos.
    const acc = await store.create({
      email: 'victim@acme.test',
      password: 'pass123456',
      fullName: 'V',
    });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-1',
      email: 'v@g.com',
    });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge'); // habilita MFA + passkey
    await cfg.patStore!.issue({ accountId: acc.id, name: 'ci-token' });
    await seedArtifacts(db, acc.id, 'grant-victim');
    // Histórico de audit da conta (com PII).
    await cfg.audit!.record({
      type: 'login.success',
      accountId: acc.id,
      email: acc.email,
      ip: '1.2.3.4',
    });
    await cfg.audit!.record({
      type: 'pat.issued',
      accountId: acc.id,
      email: acc.email,
      ip: '1.2.3.4',
    });

    // Outra conta (não deve ser tocada).
    const other = await store.create({ email: 'bystander@acme.test', password: 'pass123456' });
    await seedArtifacts(db, other.id, 'grant-other');
    await cfg.audit!.record({ type: 'login.success', accountId: other.id, email: other.email });

    const result = await new AccountDeletionService(service).delete(acc.id, {
      actorId: acc.id,
      ip: '1.2.3.4',
      source: 'self',
    });

    assert.isTrue(result.ok);
    assert.equal(result.sessions, 1);
    assert.equal(result.grants, 1);
    assert.equal(result.pats, 1);
    assert.equal(result.passkeys, 1);
    assert.equal(result.providerIdentities, 1);
    assert.isAtLeast(result.auditAnonymized, 3); // login + pat + account.deleted

    // 1) A linha da conta foi deletada.
    assert.isNull(await store.findById(acc.id));
    // 2) Sessões/grants do provider sumiram.
    assert.isUndefined(await (service.provider as any).Session.find(`sess-${acc.id}`));
    assert.isUndefined(await (service.provider as any).Grant.find('grant-victim'));
    // 3) PATs revogados.
    assert.lengthOf(await cfg.patStore!.listForAccount(acc.id), 0);
    // 4) Passkeys removidas.
    assert.lengthOf(await store.listPasskeys!(acc.id), 0);
    // 5) Provider identities desligadas.
    assert.isNull(await store.findByProviderIdentity!('google', 'g-1'));

    // 6) Audit: o histórico foi PRESERVADO (não deletado) mas anonimizado.
    const anonRows = await AuditLog.query().where('account_id', 'like', 'anon:%');
    assert.isAtLeast(anonRows.length, 3);
    for (const row of anonRows) {
      assert.isNull(row.email);
      assert.isNull(row.ip);
    }
    // Existe um account.deleted no histórico (anonimizado).
    const deletedEvents = anonRows.filter((r) => r.type === 'account.deleted');
    assert.lengthOf(deletedEvents, 1);

    // 7) A OUTRA conta permanece intacta.
    assert.isNotNull(await store.findById(other.id));
    assert.isOk(await (service.provider as any).Grant.find('grant-other'));
    const otherAudit = await AuditLog.query().where('account_id', other.id);
    assert.lengthOf(otherAudit, 1);
    assert.equal(otherAudit[0].email, other.email);
  });

  test('store sem deleteAccount: canDelete=false e delete() é no-op', async ({
    assert,
    cleanup,
  }) => {
    const port = 9872;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Substitui o store por um sem a capability de delete.
    const stripped = { ...service.config.accountStore };
    (stripped as any).deleteAccount = undefined;
    (service.config as any).accountStore = stripped;

    const svc = new AccountDeletionService(service);
    assert.isFalse(svc.canDelete);
    const result = await svc.delete('whatever', { actorId: null, ip: null, source: 'admin' });
    assert.isFalse(result.ok);
  });
});

test.group('AccountExportService (portabilidade LGPD/GDPR)', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('export reúne dados e NÃO vaza segredos (token/hash/key material)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9873;
    const { service, cfg, server, store } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const acc = await store.create({
      email: 'me@acme.test',
      password: 'pass123456',
      fullName: 'Me',
    });
    await store.linkProviderIdentity({
      accountId: acc.id,
      provider: 'github',
      providerUserId: 'h-9',
      email: 'me@gh.com',
    });
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    await cfg.patStore!.issue({ accountId: acc.id, name: 'tok', scopes: ['read'] });
    await seedArtifacts(db, acc.id, 'grant-me');
    await cfg.audit!.record({
      type: 'login.success',
      accountId: acc.id,
      email: acc.email,
      ip: '8.8.8.8',
    });

    const payload = await new AccountExportService(service).export(acc.id);
    assert.isNotNull(payload);
    const data = payload!;

    // Perfil.
    assert.equal(data.profile.id, acc.id);
    assert.equal(data.profile.email, 'me@acme.test');
    // Identidades (sem tokens).
    assert.lengthOf(data.linkedIdentities, 1);
    assert.equal(data.linkedIdentities[0].provider, 'github');
    // Apps autorizados + sessões.
    assert.lengthOf(data.authorizedApps, 1);
    assert.equal(data.authorizedApps[0].clientId, 'acme-web');
    assert.lengthOf(data.sessions, 1);
    // Passkeys (só metadados).
    assert.lengthOf(data.passkeys, 1);
    assert.deepEqual(Object.keys(data.passkeys[0]).sort(), ['createdAt', 'id', 'label']);
    // Audit do próprio usuário.
    assert.isAtLeast(data.auditLog.length, 1);

    // NENHUM segredo/material sensível no JSON serializado.
    const serialized = JSON.stringify(data);
    assert.notInclude(serialized, 'password');
    assert.notInclude(serialized, 'tokenHash');
    assert.notInclude(serialized, 'token_hash');
    assert.notInclude(serialized, 'publicKey');
    assert.notInclude(serialized, 'public_key');
    assert.notInclude(serialized, 'totpSecret');
    assert.notInclude(serialized, 'recoveryCodes');
    // O hash do PAT NÃO aparece.
    const patRow = await Pat.query().where('user_id', acc.id).first();
    assert.notInclude(serialized, patRow!.tokenHash);
  });

  test('export retorna null para conta inexistente', async ({ assert, cleanup }) => {
    const port = 9874;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.isNull(await new AccountExportService(service).export('ghost'));
  });
});
