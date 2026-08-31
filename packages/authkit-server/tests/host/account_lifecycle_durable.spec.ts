import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '@adonis-agora/durable';
import { configProvider } from '@adonisjs/core';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import type { WebauthnCeremonies } from '../../src/accounts/lucid_account_store.js';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { DatabaseAdapter } from '../../src/adapters/database_adapter.js';
import { lucidAuditSink } from '../../src/audit/lucid_audit_sink.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import type { AccountExportWorkflowResult } from '../../src/host/durable/account_export_workflow.js';
import {
  ACCOUNT_DELETE_WORKFLOW,
  ACCOUNT_EXPORT_WORKFLOW,
  defineAccountDeletionWorkflow,
  defineAccountExportWorkflow,
} from '../../src/host/durable/index.js';
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
    generateRegistrationOptions: (async () => ({
      challenge: 'reg-challenge',
    })) as any,
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
    generateAuthenticationOptions: (async () => ({
      challenge: 'auth-challenge',
    })) as any,
    verifyAuthenticationResponse: (async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })) as any,
  };
}

async function migrate(db: any) {
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

async function startService(port: number, db: any, opts?: { durable?: boolean }) {
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
      accountLifecycle: opts?.durable ? { durable: true } : undefined,
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

/** Engine in-memory — o mesmo trio (store + transport + clock) do testing-kit. */
function makeEngine() {
  return new WorkflowEngine({
    store: new InMemoryStateStore(),
    transport: new InMemoryTransport(),
  });
}

test.group('Durable account lifecycle — deletion workflow', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('workflow executa TODAS as etapas e produz o DeletionResult', async ({
    assert,
    cleanup,
  }) => {
    const port = 9881;
    const { service, cfg, server, store } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

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
    await store.verifyPasskeyRegistration!(acc.id, { __valid: true }, 'reg-challenge');
    await cfg.patStore!.issue({ accountId: acc.id, name: 'ci-token' });
    await seedArtifacts(db, acc.id, 'grant-victim');
    await cfg.audit!.record({
      type: 'login.success',
      accountId: acc.id,
      email: acc.email,
      ip: '1.2.3.4',
    });

    const engine = makeEngine();
    const wf = defineAccountDeletionWorkflow({ oidc: () => service });
    engine.register(wf.name, wf.version, wf.body);

    const runId = `${ACCOUNT_DELETE_WORKFLOW}:${acc.id}`;
    await engine.start(
      ACCOUNT_DELETE_WORKFLOW,
      {
        accountId: acc.id,
        actor: { actorId: acc.id, ip: '1.2.3.4', source: 'self' },
      },
      runId,
    );
    const res = await engine.waitForRun(runId);

    assert.equal(res.status, 'completed');
    const result = res.output as any;
    assert.isTrue(result.ok);
    assert.equal(result.sessions, 1);
    assert.equal(result.grants, 1);
    assert.equal(result.pats, 1);
    assert.equal(result.passkeys, 1);
    assert.equal(result.providerIdentities, 1);

    // A conta foi deletada (etapa final).
    assert.isNull(await store.findById(acc.id));
    // PATs revogados.
    assert.lengthOf(await cfg.patStore!.listForAccount(acc.id), 0);
    // Audit anonimizado + preservado.
    const anonRows = await AuditLog.query().where('account_id', 'like', 'anon:%');
    assert.isAtLeast(anonRows.length, 2);

    // 11 checkpoints (uma por etapa do cascade).
    const checkpoints = await engine.listCheckpoints(runId);
    const names = checkpoints.map((c) => c.name);
    assert.includeMembers(names, [
      'snapshot',
      'audit.deleted',
      'revoke.sessions',
      'revoke.pats',
      'remove.passkeys',
      'disable.mfa',
      'unlink.providers',
      'remove.orgs',
      'delete.avatar',
      'anonymize.audit',
      'delete.account',
    ]);
  });

  test('idempotente + resumável: re-rodar um run concluído é no-op (replay dos checkpoints)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9882;
    const { service, server, store } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const acc = await store.create({
      email: 'idem@acme.test',
      password: 'pass123456',
    });
    await seedArtifacts(db, acc.id, 'grant-idem');

    // Conta o nº de deleteAccount efetivos (a etapa final só deve "deletar de verdade" 1x).
    let realDeletes = 0;
    const origDelete = (store as any).deleteAccount.bind(store);
    (store as any).deleteAccount = async (id: string) => {
      const existed = !!(await store.findById(id));
      const ok = await origDelete(id);
      if (existed && ok) realDeletes++;
      return ok;
    };

    const engine = makeEngine();
    const wf = defineAccountDeletionWorkflow({ oidc: () => service });
    engine.register(wf.name, wf.version, wf.body);

    const runId = `${ACCOUNT_DELETE_WORKFLOW}:${acc.id}`;
    await engine.start(
      ACCOUNT_DELETE_WORKFLOW,
      {
        accountId: acc.id,
        actor: { actorId: acc.id, ip: null, source: 'self' },
      },
      runId,
    );
    const first = await engine.waitForRun(runId);
    assert.equal(first.status, 'completed');
    assert.isNull(await store.findById(acc.id));

    // Re-rodar o MESMO run-id: idempotente (start dedupa) — devolve o estado terminal.
    const again = await engine.start(
      ACCOUNT_DELETE_WORKFLOW,
      {
        accountId: acc.id,
        actor: { actorId: acc.id, ip: null, source: 'self' },
      },
      runId,
    );
    assert.equal(again.status, 'completed');

    // Resume direto do run concluído também é no-op (não re-executa o corpo).
    await engine.resume(runId);

    // A deleção real aconteceu UMA vez só.
    assert.equal(realDeletes, 1);
  });

  test('self-service durável: revoga a sessão SINCRONAMENTE e depois enfileira o cascade', async ({
    assert,
    cleanup,
  }) => {
    const port = 9885;
    const { service, cfg, server, store } = await startService(port, db, {
      durable: true,
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // O modo durável está ligado na config resolvida.
    assert.isTrue(cfg.accountLifecycle.durable);

    const acc = await store.create({
      email: 'self@acme.test',
      password: 'pass123456',
    });
    await seedArtifacts(db, acc.id, 'grant-self');

    const engine = makeEngine();
    const wf = defineAccountDeletionWorkflow({ oidc: () => service });
    engine.register(wf.name, wf.version, wf.body);

    // Reproduz o ramo durável do controller self-service:
    //   1) logout IMEDIATO — revoga as sessões/grants OIDC do ator (síncrono);
    //   2) enfileira o cascade durável (run-id idempotente por accountId).
    const { revokeSessions } = await import('../../src/host/account_deletion_ops.js');
    const { enqueueAccountDeletion } = await import('../../src/host/durable/index.js');

    const revoked = await revokeSessions(service, acc.id);
    // A sessão OIDC do ator já foi destruída SINCRONAMENTE (logout imediato)...
    assert.equal(revoked.sessions, 1);
    assert.isUndefined(await (service.provider as any).Session.find(`sess-${acc.id}`));
    // ...mas a linha da conta AINDA existe (o resto do cascade é async).
    assert.isNotNull(await store.findById(acc.id));

    const runId = await enqueueAccountDeletion(engine, {
      accountId: acc.id,
      actor: { actorId: acc.id, ip: null, source: 'self' },
    });
    assert.equal(runId, `${ACCOUNT_DELETE_WORKFLOW}:${acc.id}`);

    // O cascade async então completa a deleção da conta.
    const res = await engine.waitForRun(runId);
    assert.equal(res.status, 'completed');
    assert.isNull(await store.findById(acc.id));
  });

  test('conta inexistente: workflow encerra como no-op (ok=false)', async ({ assert, cleanup }) => {
    const port = 9883;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const engine = makeEngine();
    const wf = defineAccountDeletionWorkflow({ oidc: () => service });
    engine.register(wf.name, wf.version, wf.body);

    const runId = `${ACCOUNT_DELETE_WORKFLOW}:ghost`;
    await engine.start(
      ACCOUNT_DELETE_WORKFLOW,
      {
        accountId: 'ghost',
        actor: { actorId: null, ip: null, source: 'admin' },
      },
      runId,
    );
    const res = await engine.waitForRun(runId);
    assert.equal(res.status, 'completed');
    assert.isFalse((res.output as any).ok);
  });
});

test.group('Durable account lifecycle — export workflow', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('export workflow coleta o payload, persiste o artefato e entrega', async ({
    assert,
    cleanup,
  }) => {
    const port = 9884;
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
    await cfg.patStore!.issue({
      accountId: acc.id,
      name: 'tok',
      scopes: ['read'],
    });
    await seedArtifacts(db, acc.id, 'grant-me');
    await cfg.audit!.record({
      type: 'login.success',
      accountId: acc.id,
      email: acc.email,
      ip: '8.8.8.8',
    });

    // Persist + deliver pluggados (em memória) — sem depender do drive nos testes.
    const artifacts = new Map<string, string>();
    let delivered: { artifactKey: string | null } | null = null;

    const engine = makeEngine();
    const wf = defineAccountExportWorkflow({
      oidc: () => service,
      persist: async ({ accountId, runId, json }) => {
        const key = `exports/${accountId}-${runId}.json`;
        artifacts.set(key, json);
        return key;
      },
      deliver: async ({ artifactKey }) => {
        delivered = { artifactKey };
      },
    });
    engine.register(wf.name, wf.version, wf.body);

    const runId = `${ACCOUNT_EXPORT_WORKFLOW}:${acc.id}`;
    await engine.start(ACCOUNT_EXPORT_WORKFLOW, { accountId: acc.id, ip: '8.8.8.8' }, runId);
    const res = await engine.waitForRun(runId);

    assert.equal(res.status, 'completed');
    const out = res.output as AccountExportWorkflowResult;
    assert.isTrue(out.ok);
    assert.isNotNull(out.artifactKey);
    assert.isAbove(out.bytes, 0);

    // O artefato foi persistido e contém o payload do export (sem segredos).
    const json = artifacts.get(out.artifactKey!)!;
    assert.isString(json);
    const payload = JSON.parse(json);
    assert.equal(payload.profile.email, 'me@acme.test');
    assert.lengthOf(payload.linkedIdentities, 1);
    assert.notInclude(json, 'token_hash');
    assert.notInclude(json, 'public_key');

    // Foi entregue ao titular com a referência ao artefato.
    assert.isNotNull(delivered);
    assert.equal(delivered!.artifactKey, out.artifactKey);

    // account.exported foi auditado.
    const exported = await AuditLog.query().where('type', 'account.exported');
    assert.lengthOf(exported, 1);
  });
});
