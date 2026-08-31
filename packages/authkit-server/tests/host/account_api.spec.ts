import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
/**
 * Account self-service JSON API — tests
 *
 * Covers:
 *   - GET  /account/api/me             — shape + fields
 *   - GET  /account/api/security        — overview shape
 *   - PATCH /account/api/profile        — updateProfile happy path + capability absent
 *   - POST /account/api/password        — changePassword happy/error paths + sudo gate
 *   - POST /account/api/email-change    — requestEmailChange happy path + sudo gate
 *   - POST /account/api/email-change/cancel — cancelEmailChange
 *   - GET  /account/api/sessions        — listSessions supported + unsupported
 *   - DELETE /account/api/sessions/:id  — revokeSession
 *   - POST /account/api/sessions/revoke-others — revokeOtherSessions
 *   - GET  /account/api/apps            — listApps
 *   - DELETE /account/api/apps/:clientId — revokeApp
 *   - GET  /account/api/mfa             — mfaStatus
 *   - GET  /account/api/passkeys        — listPasskeys supported + unsupported
 *   - DELETE /account/api/passkeys/:id  — removePasskey + sudo gate
 *   - GET  /account/api/tokens          — listTokens supported + unsupported
 *   - POST /account/api/tokens          — createToken happy + sudo gate
 *   - DELETE /account/api/tokens/:id    — revokeToken happy + not found
 *   - GET  /account/api/orgs            — listOrgs supported + unsupported
 *   - GET  /account/api/orgs/invitations — listOrgInvitations
 *   - GET  /account/api/orgs/:id        — showOrg + not member
 *   - accountGuard: sem sessão retorna redirect/401
 *   - registerAuthHost: rotas /account/api/* são registradas no grupo accountGuard
 */
import { test } from '@japa/runner';
import type { AccountStore, AuthAccount } from '../../src/accounts/account_store.js';
import type { AuditSink, StoredAuditEvent } from '../../src/audit/audit_sink.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import AccountApiController from '../../src/host/account_api/account_api_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';
import { withPersonalAccessToken } from '../../src/mixins/with_personal_access_token.js';
import { lucidPatStore } from '../../src/pat/lucid_pat_store.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase } from '../bootstrap.js';

// ─── Test PAT model ──────────────────────────────────────────────────────────

class TestPat extends compose(BaseModel, withPersonalAccessToken()) {
  static table = 'personal_access_tokens';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: TestPat) {
    if (!row.id) row.id = randomUUID();
  }
}

// ─── In-memory stores ────────────────────────────────────────────────────────

function memoryAccountStore(
  extra: Partial<AccountStore> = {},
): AccountStore & { accounts: Map<string, AuthAccount & { password: string }> } {
  const accounts = new Map<string, AuthAccount & { password: string }>();
  const store: AccountStore & { accounts: typeof accounts } = {
    accounts,
    findById: async (id) => accounts.get(id) ?? null,
    verifyCredentials: async (email, password) => {
      const a = [...accounts.values()].find((x) => x.email === email);
      return a && (a as any).password === password ? a : null;
    },
    findByEmail: async (email) => [...accounts.values()].find((a) => a.email === email) ?? null,
    create: async (input) => {
      const id = randomUUID();
      const acc: any = {
        id,
        email: input.email,
        name: input.fullName ?? undefined,
        globalRoles: input.globalRoles ?? [],
        password: input.password,
      };
      accounts.set(id, acc);
      return acc;
    },
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    findByProviderIdentity: async () => null,
    linkProviderIdentity: async () => {},
    listAccounts: async ({ search = '', limit = 20, page = 1 }) => {
      let list = [...accounts.values()];
      if (search) list = list.filter((a) => a.email.includes(search));
      const total = list.length;
      const start = (page - 1) * limit;
      return { data: list.slice(start, start + limit), total };
    },
    setGlobalRoles: async (id, roles) => {
      const a = accounts.get(id);
      if (a) (a as any).globalRoles = roles;
    },
    updateProfile: async (id, patch) => {
      const a = accounts.get(id);
      if (!a) return null;
      if (patch.name !== undefined) (a as any).name = patch.name ?? undefined;
      if (patch.avatarUrl !== undefined) (a as any).avatarUrl = patch.avatarUrl ?? undefined;
      return a;
    },
    changePassword: async (id, newPassword) => {
      const a = accounts.get(id);
      if (!a) return false;
      (a as any).password = newPassword;
      return true;
    },
    requestEmailChange: async (id, newEmail) => {
      const a = accounts.get(id);
      if (!a) return null;
      return { token: `ec-${randomUUID()}`, account: a, newEmail };
    },
    confirmEmailChange: async () => ({ ok: false }),
    ...extra,
  };
  return store;
}

function memoryAuditSink(): AuditSink & { events: StoredAuditEvent[] } {
  const events: StoredAuditEvent[] = [];
  return {
    events,
    record: async (e) => {
      events.push({ ...e, id: `ev-${events.length + 1}`, createdAt: new Date() });
    },
    list: async ({ page = 1, limit = 20, type, subject }) => {
      let list = events;
      if (type) list = list.filter((e) => e.type === type);
      if (subject) list = list.filter((e) => e.accountId === subject);
      const total = list.length;
      const start = (page - 1) * limit;
      return { data: list.slice(start, start + limit), total };
    },
  };
}

// ─── Fake HTTP context ────────────────────────────────────────────────────────

/**
 * `sessionData` de uma sessão com sudo ATIVO.
 *
 * A marca de sudo é o par timestamp + conta que confirmou: `isSudoActive`
 * recusa uma marca que não esteja vinculada à conta logada (fail-closed), então
 * o timestamp sozinho não concede mais nada. Passe o MESMO id usado em
 * `sessionUserId`.
 */
function activeSudo(accountId: string): Record<string, unknown> {
  return { authkit_sudo_at: Date.now(), authkit_sudo_account: accountId };
}

function fakeCtx(opts: {
  service?: any;
  inputs?: Record<string, unknown>;
  params?: Record<string, string>;
  sessionUserId?: string;
  /** Session data map (key→value). Gets merged with sessionUserId shortcut. */
  sessionData?: Record<string, unknown>;
  cookies?: Record<string, string>;
}) {
  let status = 200;
  let body: any;
  let redirectTarget: string | undefined;

  const sessionMap = new Map<string, unknown>();
  if (opts.sessionUserId) sessionMap.set(ACCOUNT_SESSION_KEY, opts.sessionUserId);
  if (opts.sessionData) {
    for (const [k, v] of Object.entries(opts.sessionData)) sessionMap.set(k, v);
  }

  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const errFn = (code: number) => (payload?: any) => {
    status = code;
    return setBody(payload);
  };
  const ctx = {
    request: {
      input: (k: string, def?: unknown) => opts.inputs?.[k] ?? def,
      param: (k: string) => opts.params?.[k],
      ip: () => '127.0.0.1',
      protocol: () => 'http',
      host: () => 'localhost',
      body: () => opts.inputs ?? {},
      cookie: (k: string) => opts.cookies?.[k],
      file: () => null,
      url: () => '/account/api/test',
      parsedUrl: { search: '' },
      /**
       * Mock de validateUsing: executa o validator Vine com o body fornecido.
       * Vine validators são plain functions quando invocados diretamente.
       */
      validateUsing: async (validator: any) => {
        const data = opts.inputs ?? {};
        // Vine compiled validators expose `.validate(data)`.
        return validator.validate(data, { meta: {} });
      },
    },
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      redirect: (target: string) => {
        redirectTarget = target;
        return undefined;
      },
      notFound: errFn(404),
      unauthorized: errFn(401),
      badRequest: errFn(400),
      conflict: errFn(409),
    },
    session: {
      get: (k: string) => sessionMap.get(k),
      put: (k: string, v: unknown) => sessionMap.set(k, v),
      forget: (k: string) => sessionMap.delete(k),
      flashMessages: { get: () => undefined },
    },
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    containerResolver: { make: async () => opts.service },
  } as any;
  return {
    ctx,
    captured: {
      status: () => status,
      body: () => body,
      redirectTarget: () => redirectTarget,
    },
  };
}

// ─── Service factory ──────────────────────────────────────────────────────────

async function makeService(port: number, db: any, accountStore?: AccountStore, extra: any = {}) {
  BaseModel.useAdapter(db.modelAdapter());
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
      accountStore: accountStore ?? memoryAccountStore(),
      patStore: lucidPatStore(TestPat),
      audit: memoryAuditSink(),
      mail: { onPasswordReset: async () => {} },
      ...extra,
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

async function migrateDb(db: any) {
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
}

// ─── Test groups ──────────────────────────────────────────────────────────────

let globalPort = 10100;

test.group('AccountApiController — GET /account/api/me', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'me@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('retorna perfil com campos obrigatórios', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.me(ctx);
    assert.equal(captured.status(), 200);
    assert.equal(result.id, userId);
    assert.equal(result.email, 'me@test.com');
    assert.isBoolean(result.mfaEnabled);
    assert.isNumber(result.passkeyCount);
    assert.isBoolean(result.sudoActive);
    assert.isBoolean(result.hasPassword);
    assert.isObject(result.capabilities);
    assert.isBoolean(result.capabilities.securitySupported);
    assert.isBoolean(result.capabilities.tokensSupported);
  });

  test('sem sessão → 401', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: undefined });
    // Simula store.findById retornando null (userId undefined → not found).
    await ctrl.me(ctx);
    assert.equal(captured.status(), 401);
  });
});

test.group('AccountApiController — GET /account/api/security', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'sec@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('retorna shape de overview de segurança', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.securityOverview(ctx);
    assert.equal(captured.status(), 200);
    assert.equal(result.email, 'sec@test.com');
    assert.isBoolean(result.sessionsSupported);
    assert.isArray(result.activeSessions);
    assert.isObject(result.mfa);
    assert.isBoolean(result.mfa.enabled);
    assert.isNumber(result.mfa.passkeyCount);
  });
});

test.group('AccountApiController — PATCH /account/api/profile', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'profile@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('atualiza nome e retorna perfil atualizado', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      inputs: { name: 'Alice Test' },
    });
    const result: any = await ctrl.updateProfile(ctx);
    assert.equal(captured.status(), 200);
    assert.equal(result.name, 'Alice Test');
    assert.isString(result.id);
  });

  test('store sem updateProfile → 422', async ({ assert }) => {
    const store = memoryAccountStore();
    (store as any).updateProfile = undefined;
    const started = await makeService(globalPort++, db, store);
    const ctrl = new AccountApiController();
    const acc = await store.create({ email: 'noprofile@test.com', password: 'pw' });
    const { ctx, captured } = fakeCtx({
      service: started.service,
      sessionUserId: acc.id,
      inputs: { name: 'X' },
    });
    await ctrl.updateProfile(ctx);
    assert.equal(captured.status(), 422);
    await new Promise<void>((r) => started.server.close(() => r()));
  });
});

test.group('AccountApiController — POST /account/api/password', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'pw@test.com', password: 'OldPass123' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('muda senha com sudo ativo + senha atual correta', async ({ assert }) => {
    const ctrl = new AccountApiController();
    // Sudo ativo: coloca authkit_sudo_at recente na sessão.
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { currentPassword: 'OldPass123', newPassword: 'NewPass456!' },
    });
    const result: any = await ctrl.changePassword(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.ok);
  });

  test('senha atual incorreta → 422', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { currentPassword: 'WRONG', newPassword: 'NewPass456!' },
    });
    await ctrl.changePassword(ctx);
    assert.equal(captured.status(), 422);
  });

  test('sem sudo ativo → 403', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      // Sem authkit_sudo_at → sudo não ativo.
      inputs: { currentPassword: 'OldPass123', newPassword: 'NewPass456!' },
    });
    await ctrl.changePassword(ctx);
    assert.equal(captured.status(), 403);
  });
});

test.group('AccountApiController — POST /account/api/email-change', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'ec@test.com', password: 'Passw0rd!' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('solicita troca de e-mail com sudo + senha', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { currentPassword: 'Passw0rd!', newEmail: 'new@test.com' },
    });
    const result: any = await ctrl.requestEmailChange(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.ok);
    assert.equal(result.email, 'new@test.com');
  });

  test('sem sudo → 403', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      inputs: { currentPassword: 'Passw0rd!', newEmail: 'new@test.com' },
    });
    await ctrl.requestEmailChange(ctx);
    assert.equal(captured.status(), 403);
  });

  test('cancelar troca de e-mail', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.cancelEmailChange(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.ok);
  });
});

test.group('AccountApiController — GET /account/api/sessions', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'sess@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('retorna sessions (adapter de banco suporta list)', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listSessions(ctx);
    assert.equal(captured.status(), 200);
    assert.isBoolean(result.supported);
    assert.isArray(result.sessions);
  });

  test('POST revoke-others retorna resultado', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.revokeOtherSessions(ctx);
    assert.equal(captured.status(), 200);
    assert.isBoolean(result.ok);
  });
});

test.group('AccountApiController — DELETE /account/api/sessions/:id', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'revokeS@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('sessão inexistente → 404 ou 422 (sem list no adapter)', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      params: { id: 'nonexistent-session' },
    });
    await ctrl.revokeSession(ctx);
    // Quando o adapter não suporta list → 422; quando suporta e não encontra → 404.
    assert.isTrue(
      [404, 422].includes(captured.status()),
      `Expected 404 or 422, got ${captured.status()}`,
    );
  });
});

test.group('AccountApiController — GET /account/api/apps', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'apps@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('retorna apps (grants), com supported flag', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listApps(ctx);
    assert.equal(captured.status(), 200);
    assert.isBoolean(result.supported);
    assert.isArray(result.apps);
  });

  test('DELETE revokeApp retorna resultado', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      params: { clientId: 'c1' },
    });
    const result: any = await ctrl.revokeApp(ctx);
    // Quando o adapter não suporta list → 422; senão retorna ok.
    assert.isTrue(
      [200, 422].includes(captured.status()),
      `Expected 200 or 422, got ${captured.status()}`,
    );
    if (captured.status() === 200) {
      assert.isTrue(result.ok);
    }
  });
});

test.group('AccountApiController — GET /account/api/mfa', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'mfa@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('retorna status MFA', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.mfaStatus(ctx);
    assert.equal(captured.status(), 200);
    assert.isBoolean(result.enabled);
    assert.isObject(result.totp);
    assert.isObject(result.passkeys);
    assert.isNumber(result.passkeys.count);
    assert.isObject(result.recovery);
  });
});

test.group('AccountApiController — GET /account/api/passkeys', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'pk@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('store sem passkeys → supported:false', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listPasskeys(ctx);
    assert.equal(captured.status(), 200);
    // Memory store não implementa listPasskeys, então supported=false.
    assert.isFalse(result.supported);
    assert.isArray(result.passkeys);
    assert.isEmpty(result.passkeys);
  });

  test('store com passkeys → supported:true + array', async ({ assert }) => {
    const storeWithPk = memoryAccountStore({
      listPasskeys: async () => [
        { id: 'pk1', label: 'My Yubikey', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    } as any);
    const acc = await storeWithPk.create({ email: 'pk2@test.com', password: 'pw123456' });
    const started2 = await makeService(globalPort++, db, storeWithPk);
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service: started2.service, sessionUserId: acc.id });
    const result: any = await ctrl.listPasskeys(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.supported);
    assert.lengthOf(result.passkeys, 1);
    assert.equal(result.passkeys[0].id, 'pk1');
    await new Promise<void>((r) => started2.server.close(() => r()));
  });

  test('DELETE removePasskey sem sudo → 403', async ({ assert }) => {
    const storeWithPk = memoryAccountStore({
      listPasskeys: async () => [],
      removePasskey: async () => {},
    } as any);
    const acc = await storeWithPk.create({ email: 'pkrm@test.com', password: 'pw123456' });
    const started2 = await makeService(globalPort++, db, storeWithPk);
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service: started2.service,
      sessionUserId: acc.id,
      params: { id: 'pk1' },
    });
    await ctrl.removePasskey(ctx);
    assert.equal(captured.status(), 403);
    await new Promise<void>((r) => started2.server.close(() => r()));
  });

  test('DELETE removePasskey com sudo → ok', async ({ assert }) => {
    const storeWithPk = memoryAccountStore({
      listPasskeys: async () => [],
      removePasskey: async () => {},
    } as any);
    const acc = await storeWithPk.create({ email: 'pkrm2@test.com', password: 'pw123456' });
    const started2 = await makeService(globalPort++, db, storeWithPk);
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service: started2.service,
      sessionUserId: acc.id,
      sessionData: activeSudo(acc.id),
      params: { id: 'pk1' },
    });
    const result: any = await ctrl.removePasskey(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.ok);
    await new Promise<void>((r) => started2.server.close(() => r()));
  });
});

test.group('AccountApiController — Tokens (PATs)', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'token@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, store);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('GET /account/api/tokens → lista tokens', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listTokens(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.supported);
    assert.isArray(result.tokens);
  });

  test('POST /account/api/tokens com sudo → cria token + retorna secret', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { name: 'My CI Token' },
    });
    const result: any = await ctrl.createToken(ctx);
    assert.equal(captured.status(), 201);
    assert.isString(result.id);
    assert.isString(result.secret);
    assert.equal(result.name, 'My CI Token');
  });

  test('POST /account/api/tokens sem sudo → 403', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      inputs: { name: 'No Sudo Token' },
    });
    await ctrl.createToken(ctx);
    assert.equal(captured.status(), 403);
  });

  test('DELETE /account/api/tokens/:id com sudo → revoga', async ({ assert }) => {
    const ctrl = new AccountApiController();

    // Cria primeiro.
    const createCtx = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { name: 'To Revoke' },
    });
    const created: any = await ctrl.createToken(createCtx.ctx);
    assert.isString(created.id);

    // Revoga.
    const revokeCtx = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      params: { id: created.id },
    });
    const result: any = await ctrl.revokeToken(revokeCtx.ctx);
    assert.equal(revokeCtx.captured.status(), 200);
    assert.isTrue(result.ok);
  });

  test('DELETE /account/api/tokens/:id token inexistente → 404', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      params: { id: 'nonexistent-token-id' },
    });
    await ctrl.revokeToken(ctx);
    assert.equal(captured.status(), 404);
  });

  test('DELETE /account/api/tokens/:id sem sudo → 403', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      params: { id: 'some-id' },
    });
    await ctrl.revokeToken(ctx);
    assert.equal(captured.status(), 403);
  });
});

test.group('AccountApiController — Orgs', (group) => {
  let db: any;
  let server: Server;
  // Store com suporte a orgs (minimal mock).
  const orgStore: AccountStore = {
    ...memoryAccountStore(),
    listOrgsForAccount: async () => [
      { id: 'org1', name: 'Acme', slug: 'acme', logoUrl: null, role: 'owner' },
    ],
    findOrgById: async (id) =>
      id === 'org1' ? { id: 'org1', name: 'Acme', slug: 'acme', logoUrl: null } : null,
    getOrgMembership: async (orgId, accountId) =>
      orgId === 'org1' ? { orgId, accountId, role: 'owner', joinedAt: '2026-01-01' } : null,
    listOrgMembers: async () => [],
    listPendingInvitationsForEmail: async () => [],
    createOrg: async () => ({ id: 'org2', name: 'New', slug: 'new' }),
    createOrgInvitation: async () => ({ invitation: { id: 'inv1' } as any, token: 'tok' }),
    removeOrgMember: async () => ({ ok: true }),
    revokeInvitation: async () => {},
    findInvitationByTokenHash: async () => null,
    acceptInvitation: async () => ({ ok: false }),
  } as any;

  let service: any;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const acc = await (orgStore as any).create({ email: 'orgs@test.com', password: 'pw123456' });
    userId = acc.id;
    const started = await makeService(globalPort++, db, orgStore);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('GET /account/api/orgs → lista orgs', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listOrgs(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.supported);
    assert.isArray(result.orgs);
    assert.lengthOf(result.orgs, 1);
    assert.equal(result.orgs[0].slug, 'acme');
  });

  test('GET /account/api/orgs sem suporte → supported:false', async ({ assert }) => {
    const noOrgStore = memoryAccountStore();
    const accNoOrg = await noOrgStore.create({ email: 'noordg@test.com', password: 'pw' });
    const started2 = await makeService(globalPort++, db, noOrgStore);
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service: started2.service, sessionUserId: accNoOrg.id });
    const result: any = await ctrl.listOrgs(ctx);
    assert.equal(captured.status(), 200);
    assert.isFalse(result.supported);
    await new Promise<void>((r) => started2.server.close(() => r()));
  });

  test('GET /account/api/orgs/:id → detalhe se membro', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      params: { id: 'org1' },
    });
    const result: any = await ctrl.showOrg(ctx);
    assert.equal(captured.status(), 200);
    assert.equal(result.id, 'org1');
    assert.equal(result.slug, 'acme');
    assert.isBoolean(result.canManage);
    assert.isArray(result.members);
  });

  test('GET /account/api/orgs/:id org inexistente → 404', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      params: { id: 'unknown-org' },
    });
    await ctrl.showOrg(ctx);
    assert.equal(captured.status(), 404);
  });

  test('GET /account/api/orgs/invitations → lista convites', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listOrgInvitations(ctx);
    assert.equal(captured.status(), 200);
    assert.isTrue(result.supported);
    assert.isArray(result.invitations);
  });
});

test.group('AccountApiController — sem patStore → tokens 422', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let userId: string;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateDb(db);
    const store = memoryAccountStore();
    const acc = await store.create({ email: 'nopat@test.com', password: 'pw123456' });
    userId = acc.id;
    BaseModel.useAdapter(db.modelAdapter());
    const issuer = `http://localhost:${globalPort}`;
    const fakeApp = { container: { make: async () => db } } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer,
        adapter: adapters.database({}),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [],
        accountStore: store,
        // patStore omitido intencionalmente.
        mail: { onPasswordReset: async () => {} },
      }),
    );
    const svc = new OidcService(cfg!, 'a'.repeat(32));
    const srv: Server = createServer(svc.callback);
    await new Promise<void>((r) => srv.listen(globalPort++, r));
    service = svc;
    server = srv;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('GET /account/api/tokens sem patStore → supported:false', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({ service, sessionUserId: userId });
    const result: any = await ctrl.listTokens(ctx);
    assert.equal(captured.status(), 200);
    assert.isFalse(result.supported);
  });

  test('POST /account/api/tokens sem patStore → 422', async ({ assert }) => {
    const ctrl = new AccountApiController();
    const { ctx, captured } = fakeCtx({
      service,
      sessionUserId: userId,
      sessionData: activeSudo(userId),
      inputs: { name: 'No Pat' },
    });
    await ctrl.createToken(ctx);
    assert.equal(captured.status(), 422);
  });
});

test.group('registerAuthHost — /account/api/* rotas registradas', () => {
  function fakeRouter() {
    const routes: Array<{ method: string; pattern: string }> = [];
    const mk = (method: string) => (pattern: string) => {
      routes.push({ method, pattern });
      return { as: () => ({ as: () => {} }), middleware: () => {}, use: () => {} } as any;
    };
    const groupChain: any = {
      as: () => groupChain,
      prefix: () => groupChain,
      middleware: () => groupChain,
      use: () => groupChain,
    };
    return {
      get: mk('GET'),
      post: mk('POST'),
      patch: mk('PATCH'),
      delete: mk('DELETE'),
      put: mk('PUT'),
      any: mk('ANY'),
      group: (cb: () => void) => {
        cb();
        return groupChain;
      },
      routes,
    } as any;
  }

  test('GET /account/api/me registrada', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/me' && r.method === 'GET'),
    );
  });

  test('GET /account/api/security registrada', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/security' && r.method === 'GET'),
    );
  });

  test('PATCH /account/api/profile registrada', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/profile' && r.method === 'PATCH'),
    );
  });

  test('POST /account/api/password registrada', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/password' && r.method === 'POST'),
    );
  });

  test('POST /account/api/email-change + cancel registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/email-change' && r.method === 'POST',
      ),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/email-change/cancel' && r.method === 'POST',
      ),
    );
  });

  test('GET/DELETE sessions registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/sessions' && r.method === 'GET'),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/sessions/:id' && r.method === 'DELETE',
      ),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/sessions/revoke-others' && r.method === 'POST',
      ),
    );
  });

  test('GET/DELETE apps registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/apps' && r.method === 'GET'),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/apps/:clientId' && r.method === 'DELETE',
      ),
    );
  });

  test('GET /account/api/mfa registrada', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/mfa' && r.method === 'GET'),
    );
  });

  test('GET/DELETE passkeys registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/passkeys' && r.method === 'GET'),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/passkeys/:id' && r.method === 'DELETE',
      ),
    );
  });

  test('GET/POST/DELETE tokens registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/tokens' && r.method === 'GET'),
    );
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/tokens' && r.method === 'POST'),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/tokens/:id' && r.method === 'DELETE',
      ),
    );
  });

  test('GET orgs + invitations + :id registradas (invitations ANTES de :id)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/orgs' && r.method === 'GET'),
    );
    assert.isTrue(
      router.routes.some(
        (r: any) => r.pattern === '/account/api/orgs/invitations' && r.method === 'GET',
      ),
    );
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/account/api/orgs/:id' && r.method === 'GET'),
    );

    // /account/api/orgs/invitations deve vir ANTES de /account/api/orgs/:id.
    const idxInvitations = router.routes.findIndex(
      (r: any) => r.pattern === '/account/api/orgs/invitations' && r.method === 'GET',
    );
    const idxOrgId = router.routes.findIndex(
      (r: any) => r.pattern === '/account/api/orgs/:id' && r.method === 'GET',
    );
    assert.isBelow(
      idxInvitations,
      idxOrgId,
      '/account/api/orgs/invitations deve ser registrada antes de /account/api/orgs/:id',
    );
  });

  test('email-change/cancel registrada ANTES de /email-change (anti-shadowing)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    const idxCancel = router.routes.findIndex(
      (r: any) => r.pattern === '/account/api/email-change/cancel' && r.method === 'POST',
    );
    const idxEmailChange = router.routes.findIndex(
      (r: any) => r.pattern === '/account/api/email-change' && r.method === 'POST',
    );
    assert.isBelow(
      idxCancel,
      idxEmailChange,
      '/account/api/email-change/cancel deve vir antes de /account/api/email-change',
    );
  });
});
