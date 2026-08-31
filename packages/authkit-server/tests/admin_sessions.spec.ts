import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { AdminSessionsService } from '../src/host/admin_sessions_service.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

/** Cria a tabela única usada pelo DatabaseAdapter (mesmo schema da migration do host). */
async function migrate(db: any) {
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
}

async function startService(port: number, db: any) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'c1',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code', 'refresh_token'],
        },
      ],
      accountStore: fakeAccountStore(),
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

/**
 * Persiste artefatos OIDC (Session/Grant/AccessToken/RefreshToken) como o provider
 * faria. Os ids são prefixados pelo accountId — a PK do adapter é `(model, id)`,
 * então ids distintos por conta evitam que uma sobrescreva a outra.
 */
async function seedArtifacts(db: any, accountId: string, grantId: string) {
  const session = new DatabaseAdapter('Session', db);
  const grant = new DatabaseAdapter('Grant', db);
  const at = new DatabaseAdapter('AccessToken', db);
  const rt = new DatabaseAdapter('RefreshToken', db);
  const p = accountId;

  await session.upsert(`sess-${p}`, { accountId, loginTs: 1700000000, amr: ['pwd'] } as any, 3600);
  await grant.upsert(grantId, { accountId, clientId: 'c1' } as any, 3600);
  await at.upsert(`at1-${p}`, { accountId, clientId: 'c1', grantId } as any, 3600);
  await at.upsert(`at2-${p}`, { accountId, clientId: 'c1', grantId } as any, 3600);
  await rt.upsert(`rt1-${p}`, { accountId, clientId: 'c1', grantId } as any, 3600);
}

test.group('AdminSessionsService (sessões/grants + revogação adapter-backed)', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('enumera sessões e grants criados por um fluxo, com contagem de tokens', async ({
    assert,
    cleanup,
  }) => {
    const port = 9851;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    await seedArtifacts(db, 'acc-1', 'grant-1');
    // Artefatos de OUTRA conta não devem aparecer.
    await seedArtifacts(db, 'acc-2', 'grant-2');

    const admin = new AdminSessionsService(service);
    assert.isTrue(admin.canList);

    const sessions = await admin.listSessions('acc-1');
    assert.lengthOf(sessions, 1);
    assert.equal(sessions[0].id, 'sess-acc-1');
    assert.equal(sessions[0].loginTs, 1700000000);

    const grants = await admin.listGrants('acc-1');
    assert.lengthOf(grants, 1);
    assert.equal(grants[0].id, 'grant-1');
    assert.equal(grants[0].clientId, 'c1');
    assert.equal(grants[0].accessTokens, 2);
    assert.equal(grants[0].refreshTokens, 1);
  });

  test('revokeAll destrói sessões + grants (provider não acha mais) + tokens', async ({
    assert,
    cleanup,
  }) => {
    const port = 9852;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    await seedArtifacts(db, 'acc-1', 'grant-1');
    await seedArtifacts(db, 'acc-2', 'grant-2');

    const admin = new AdminSessionsService(service);
    const result = await admin.revokeAll('acc-1');
    assert.deepEqual(result, { sessions: 1, grants: 1, accessTokens: 2, refreshTokens: 1 });

    // O provider não acha mais a session nem o grant da conta revogada.
    assert.isUndefined(await (service.provider as any).Session.find('sess-acc-1'));
    assert.isUndefined(await (service.provider as any).Grant.find('grant-1'));
    // Tokens destruídos (belt-and-braces).
    assert.isUndefined(await new DatabaseAdapter('AccessToken', db).find('at1-acc-1'));
    assert.isUndefined(await new DatabaseAdapter('RefreshToken', db).find('rt1-acc-1'));

    // A conta NÃO revogada permanece intacta.
    assert.isOk(await (service.provider as any).Grant.find('grant-2'));
    assert.lengthOf(await admin.listSessions('acc-2'), 1);
  });

  test('revokeAllExcept grava a revogação por sub (M7) com cutoff antes do iat da sessão preservada', async ({
    assert,
    cleanup,
  }) => {
    const port = 9856;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Duas sessões da MESMA conta: uma "antiga" e a "nova" (preservada). loginTs distintos.
    const session = new DatabaseAdapter('Session', db);
    await session.upsert('sess-old', { accountId: 'acc-1', loginTs: 1700000000 } as any, 3600);
    const NEW_IAT = 1700000100;
    await session.upsert('sess-new', { accountId: 'acc-1', loginTs: NEW_IAT } as any, 3600);

    // Subclasse que captura a chamada protegida recordSubRevocation (em vez de
    // tocar o db global, que não existe neste harness standalone).
    const calls: Array<{ accountId: string; revokedAt?: Date }> = [];
    class SpySessions extends AdminSessionsService {
      protected async recordSubRevocation(accountId: string, revokedAt?: Date): Promise<void> {
        calls.push({ accountId, revokedAt });
      }
    }

    const admin = new SpySessions(service);
    const result = await admin.revokeAllExcept('acc-1', 'sess-new');

    // A sessão antiga foi destruída; a nova preservada.
    assert.equal(result.sessions, 1);
    assert.isUndefined(await (service.provider as any).Session.find('sess-old'));
    assert.isOk(await (service.provider as any).Session.find('sess-new'));

    // M7: gravou a revogação por sub.
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].accountId, 'acc-1');
    // Cutoff ESTRITAMENTE antes do iat da sessão nova (loginTs - 1s), para que a
    // sessão preservada NÃO se auto-derrube (revoked_at < iat_nova).
    assert.instanceOf(calls[0].revokedAt, Date);
    assert.isBelow(calls[0].revokedAt!.getTime(), NEW_IAT * 1000);
    assert.equal(calls[0].revokedAt!.getTime(), (NEW_IAT - 1) * 1000);
  });

  test('revokeClientGrants revoga só os grants de um client (consentimento)', async ({
    assert,
    cleanup,
  }) => {
    const port = 9853;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Mesma conta, dois clients distintos (grants diferentes).
    const grant = new DatabaseAdapter('Grant', db);
    const at = new DatabaseAdapter('AccessToken', db);
    await grant.upsert('g-c1', { accountId: 'acc-1', clientId: 'c1' } as any, 3600);
    await grant.upsert('g-c2', { accountId: 'acc-1', clientId: 'c2' } as any, 3600);
    await at.upsert('at-c1', { accountId: 'acc-1', clientId: 'c1', grantId: 'g-c1' } as any, 3600);
    await at.upsert('at-c2', { accountId: 'acc-1', clientId: 'c2', grantId: 'g-c2' } as any, 3600);

    const admin = new AdminSessionsService(service);
    const result = await admin.revokeClientGrants('acc-1', 'c1');
    assert.equal(result.grants, 1);
    assert.equal(result.accessTokens, 1);

    // O grant/token de c1 some; os de c2 permanecem.
    assert.isUndefined(await (service.provider as any).Grant.find('g-c1'));
    assert.isUndefined(await new DatabaseAdapter('AccessToken', db).find('at-c1'));
    assert.isOk(await (service.provider as any).Grant.find('g-c2'));
    assert.isOk(await new DatabaseAdapter('AccessToken', db).find('at-c2'));
  });

  test('listAllSessions retorna sessões de todas as contas com email resolvido', async ({
    assert,
    cleanup,
  }) => {
    const port = 9854;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    await seedArtifacts(db, 'acc-1', 'grant-1');
    await seedArtifacts(db, 'acc-2', 'grant-2');

    const admin = new AdminSessionsService(service);
    const { sessions, truncated } = await admin.listAllSessions();

    // Ambas as contas aparecem na listagem global
    assert.isFalse(truncated);
    assert.lengthOf(sessions, 2);
    const ids = sessions.map((s) => s.accountId).sort();
    assert.deepEqual(ids, ['acc-1', 'acc-2']);

    // Email resolvido via fakeAccountStore (retorna email fixo: fixed.email de bootstrap)
    for (const s of sessions) {
      assert.isString(s.email);
    }
  });

  test('listAllSessions retorna truncated=true quando sessions > 500', async ({
    assert,
    cleanup,
  }) => {
    const port = 9855;
    const { service, server } = await startService(port, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // Insere 501 sessões (contas distintas para evitar colisão de PK)
    const session = new DatabaseAdapter('Session', db);
    for (let i = 0; i < 501; i++) {
      await session.upsert(
        `sess-bulk-${i}`,
        { accountId: `bulk-${i}`, loginTs: 1700000000 } as any,
        3600,
      );
    }

    const admin = new AdminSessionsService(service);
    const { sessions, truncated } = await admin.listAllSessions();
    assert.isTrue(truncated);
    assert.equal(sessions.length, 500);
  });

  test('canList=false e listas vazias quando o adapter não enumera', async ({ assert }) => {
    // Adapter sem `list`: o serviço degrada graciosamente.
    class NoListAdapter {
      async find() {
        return undefined;
      }
      async upsert() {}
      async destroy() {}
      async consume() {}
      async findByUid() {
        return undefined;
      }
      async findByUserCode() {
        return undefined;
      }
      async revokeByGrantId() {}
    }
    const fakeAccountStore = { findById: async () => null } as any;
    const fakeService = {
      config: { AdapterClass: NoListAdapter, accountStore: fakeAccountStore },
    } as any;
    const admin = new AdminSessionsService(fakeService);
    assert.isFalse(admin.canList);
    assert.lengthOf(await admin.listSessions('acc-1'), 0);
    assert.lengthOf(await admin.listGrants('acc-1'), 0);
    const result = await admin.revokeAll('acc-1');
    assert.deepEqual(result, { sessions: 0, grants: 0, accessTokens: 0, refreshTokens: 0 });
    // listAllSessions também retorna vazio quando canList=false
    const { sessions, truncated } = await admin.listAllSessions();
    assert.lengthOf(sessions, 0);
    assert.isFalse(truncated);
  });
});
