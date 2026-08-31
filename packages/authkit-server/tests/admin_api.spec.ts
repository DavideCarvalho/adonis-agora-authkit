import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import type { AccountStore, AuthAccount } from '../src/accounts/account_store.js';
import type { AuditSink, StoredAuditEvent } from '../src/audit/audit_sink.js';
import type { AuthServerConfigInput } from '../src/define_config.js';
import { adapters, defineConfig } from '../src/define_config.js';
import { adminApiGuard } from '../src/host/admin_api/admin_api_guard.js';
import ApiClientsController from '../src/host/admin_api/api_clients_controller.js';
import ApiMiscController from '../src/host/admin_api/api_misc_controller.js';
import ApiUsersController from '../src/host/admin_api/api_users_controller.js';
import { attemptPasswordLogin } from '../src/host/login_attempt.js';
import { withPersonalAccessToken } from '../src/mixins/with_personal_access_token.js';
import { lucidPatStore } from '../src/pat/lucid_pat_store.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { createTestDatabase } from './bootstrap.js';

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

/** Store de contas em memória com status (disable/enable) + perfil + reset por token. */
function memoryAccountStore(): AccountStore {
  const byId = new Map<string, AuthAccount & { password: string; disabled: boolean }>();
  const resetTokens = new Map<string, string>(); // token -> accountId
  const findByEmail = (email: string) => [...byId.values()].find((a) => a.email === email) ?? null;
  return {
    findById: async (id) => byId.get(id) ?? null,
    verifyCredentials: async (email, password) => {
      const a = findByEmail(email);
      return a && a.password === password ? a : null;
    },
    findByEmail: async (email) => findByEmail(email),
    create: async (input) => {
      const id = `acc-${byId.size + 1}`;
      const acc = {
        id,
        email: input.email,
        name: input.fullName ?? undefined,
        globalRoles: input.globalRoles ?? [],
        password: input.password,
        disabled: false,
      };
      byId.set(id, acc);
      return acc;
    },
    issuePasswordResetToken: async (email) => {
      const a = findByEmail(email);
      if (!a) return null;
      const token = `rt-${randomUUID()}`;
      resetTokens.set(token, a.id);
      return { token, account: a };
    },
    consumePasswordResetToken: async (token, newPassword) => {
      const id = resetTokens.get(token);
      if (!id) return false;
      const a = byId.get(id);
      if (!a) return false;
      a.password = newPassword;
      resetTokens.delete(token);
      return true;
    },
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async ({ search, limit = 20, page = 1 }) => {
      let list = [...byId.values()];
      if (search) list = list.filter((a) => a.email.includes(search));
      const total = list.length;
      const start = (page - 1) * limit;
      return { data: list.slice(start, start + limit), total };
    },
    setGlobalRoles: async (id, roles) => {
      const a = byId.get(id);
      if (a) a.globalRoles = roles;
    },
    // capacidade de status
    disableAccount: async (id) => {
      const a = byId.get(id);
      if (a) a.disabled = true;
    },
    enableAccount: async (id) => {
      const a = byId.get(id);
      if (a) a.disabled = false;
    },
    isDisabled: async (id) => byId.get(id)?.disabled ?? false,
    // capacidade de perfil
    updateProfile: async (id, patch) => {
      const a = byId.get(id);
      if (!a) return null;
      if (patch.name !== undefined) a.name = patch.name ?? undefined;
      if (patch.avatarUrl !== undefined) a.avatarUrl = patch.avatarUrl ?? undefined;
      return a;
    },
  };
}

/** Sink de auditoria em memória que suporta list (para o /audit). */
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

/** Fake ctx: request.input/param + response que captura status/body. */
function fakeCtx(opts: {
  service?: any;
  inputs?: Record<string, unknown>;
  params?: Record<string, string>;
  authHeader?: string;
  /** id NÃO-SENSÍVEL da API key, como o adminApiGuard anexaria (M9). */
  apiKeyId?: string;
}) {
  let status = 200;
  let body: any;
  const captured = { status: () => status, body: () => body };
  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const err = (code: number) => (payload?: any) => {
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
      header: (h: string) => (h.toLowerCase() === 'authorization' ? opts.authHeader : undefined),
      // Vine compiled validators expõem `.validate(data)`; valida o body (inputs).
      validateUsing: async (validator: {
        validate: (data: unknown, options: { meta: object }) => Promise<unknown>;
      }) => validator.validate(opts.inputs ?? {}, { meta: {} }),
    },
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      notFound: err(404),
      unauthorized: err(401),
      badRequest: err(400),
      conflict: err(409),
    },
    containerResolver: { make: async () => opts.service },
    session: { get: () => undefined },
    adminApiKeyId: opts.apiKeyId,
  } as any;
  return { ctx, captured };
}

async function startService(port: number, db: any, extra: Partial<AuthServerConfigInput> = {}) {
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
      accountStore: memoryAccountStore(),
      patStore: lucidPatStore(TestPat),
      audit: memoryAuditSink(),
      // Hook de e-mail no-op: evita o fallback dev (que usa ctx.logger, ausente no fake ctx).
      mail: { onPasswordReset: async () => {} },
      ...extra,
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

test.group('adminApiGuard', () => {
  function guardCtx(adminApi: any, authHeader?: string) {
    let status = 0;
    let body: any;
    const ctx = {
      request: { header: () => authHeader },
      response: {
        notFound: () => {
          status = 404;
        },
        unauthorized: (b: any) => {
          status = 401;
          body = b;
        },
      },
      containerResolver: { make: async () => ({ config: { adminApi } }) },
    } as any;
    return { ctx, get: () => ({ status, body }) };
  }

  test('desabilitada → 404', async ({ assert }) => {
    const { ctx, get } = guardCtx({ enabled: false, apiKeys: ['k'] }, 'Bearer k');
    let next = false;
    await adminApiGuard(ctx, async () => {
      next = true;
    });
    assert.isFalse(next);
    assert.equal(get().status, 404);
  });

  test('key errada → 401', async ({ assert }) => {
    const { ctx, get } = guardCtx({ enabled: true, apiKeys: ['secret'] }, 'Bearer wrong');
    let next = false;
    await adminApiGuard(ctx, async () => {
      next = true;
    });
    assert.isFalse(next);
    assert.equal(get().status, 401);
    assert.equal(get().body.error.code, 'unauthorized');
  });

  test('sem header → 401', async ({ assert }) => {
    const { ctx, get } = guardCtx({ enabled: true, apiKeys: ['secret'] });
    await adminApiGuard(ctx, async () => {});
    assert.equal(get().status, 401);
  });

  test('key correta → next()', async ({ assert }) => {
    const { ctx, get } = guardCtx({ enabled: true, apiKeys: ['secret'] }, 'Bearer secret');
    let next = false;
    await adminApiGuard(ctx, async () => {
      next = true;
    });
    assert.isTrue(next);
    assert.equal(get().status, 0);
  });
});

test.group('Admin REST API (controllers)', (group) => {
  let db: any;
  let service: any;
  let server: Server;
  let port = 9870;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    const started = await startService(port++, db);
    service = started.service;
    server = started.server;
    return async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    };
  });

  test('users CRUD roundtrip: create → get → patch roles → disable → login blocked → enable', async ({
    assert,
  }) => {
    const users = new ApiUsersController();

    // create (com senha)
    const c = fakeCtx({
      service,
      inputs: { email: 'jane@x.com', name: 'Jane', password: 'pw-secret-123' },
    });
    const created: any = await users.store(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.equal(created.email, 'jane@x.com');
    const id = created.id;

    // get
    const g = fakeCtx({ service, params: { id } });
    const got: any = await users.show(g.ctx);
    assert.equal(got.id, id);
    assert.equal(got.name, 'Jane');

    // patch roles + name (ADMIN está no catálogo default; STAFF não — ver teste
    // dedicado "roles fora do catálogo via REST → 422" abaixo).
    const p = fakeCtx({
      service,
      params: { id },
      inputs: { globalRoles: ['ADMIN'], name: 'Jane Doe' },
    });
    const patched: any = await users.update(p.ctx);
    assert.deepEqual(patched.globalRoles, ['ADMIN']);
    assert.equal(patched.name, 'Jane Doe');

    // login works before disable
    const cfg = service.config;
    const before = await attemptPasswordLogin(cfg, {
      email: 'jane@x.com',
      password: 'pw-secret-123',
      ip: null,
    });
    assert.isTrue(before.ok);

    // disable
    const d = fakeCtx({ service, params: { id } });
    const dis: any = await users.disable(d.ctx);
    assert.deepEqual(dis, { id, disabled: true });

    // login blocked
    const after = await attemptPasswordLogin(cfg, {
      email: 'jane@x.com',
      password: 'pw-secret-123',
      ip: null,
    });
    assert.isFalse(after.ok);
    assert.isTrue((after as any).disabled);

    // enable → login works again
    const e = fakeCtx({ service, params: { id } });
    await users.enable(e.ctx);
    const reLogin = await attemptPasswordLogin(cfg, {
      email: 'jane@x.com',
      password: 'pw-secret-123',
      ip: null,
    });
    assert.isTrue(reLogin.ok);
  });

  // ─── H1: proteção de roles globais (REST) ──────────────────────────────────

  test('H1: remover a role do último admin via REST → 409 last_admin', async ({ assert }) => {
    const users = new ApiUsersController();
    // Cria o ÚNICO admin.
    const admin: any = await users.store(
      fakeCtx({ service, inputs: { email: 'sole-admin@x.com', password: 'pw-secret-123' } }).ctx,
    );
    await users.update(
      fakeCtx({ service, params: { id: admin.id }, inputs: { globalRoles: ['ADMIN'] } }).ctx,
    );

    // Tenta rebaixá-lo (key id != target → não é self-demote; é o ÚNICO admin).
    const p = fakeCtx({
      service,
      params: { id: admin.id },
      inputs: { globalRoles: [] },
      apiKeyId: 'admin-key:deadbeef',
    });
    const res: any = await users.update(p.ctx);
    assert.equal(p.captured.status(), 409);
    assert.equal(res.error.code, 'last_admin');
  });

  test('H1: conceder ADMIN a outro havendo >1 admin → ok', async ({ assert }) => {
    const users = new ApiUsersController();
    const a1: any = await users.store(
      fakeCtx({ service, inputs: { email: 'admin1@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const a2: any = await users.store(
      fakeCtx({ service, inputs: { email: 'admin2@x.com', password: 'pw-secret-123' } }).ctx,
    );
    await users.update(
      fakeCtx({ service, params: { id: a1.id }, inputs: { globalRoles: ['ADMIN'] } }).ctx,
    );
    // Agora há 2 admins → rebaixar a2 é permitido (não é o último).
    await users.update(
      fakeCtx({ service, params: { id: a2.id }, inputs: { globalRoles: ['ADMIN'] } }).ctx,
    );
    const p = fakeCtx({
      service,
      params: { id: a2.id },
      inputs: { globalRoles: [] },
      apiKeyId: 'admin-key:abc123',
    });
    const res: any = await users.update(p.ctx);
    assert.notEqual(p.captured.status(), 409);
    assert.deepEqual(res.globalRoles, []);
  });

  test('H1: auto-rebaixamento via REST (actor === target) → 409 cannot_self_demote', async ({
    assert,
  }) => {
    const users = new ApiUsersController();
    // Dois admins, para isolar a checagem de self-demote da de último-admin.
    const a1: any = await users.store(
      fakeCtx({ service, inputs: { email: 'self1@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const a2: any = await users.store(
      fakeCtx({ service, inputs: { email: 'self2@x.com', password: 'pw-secret-123' } }).ctx,
    );
    await users.update(
      fakeCtx({ service, params: { id: a1.id }, inputs: { globalRoles: ['ADMIN'] } }).ctx,
    );
    await users.update(
      fakeCtx({ service, params: { id: a2.id }, inputs: { globalRoles: ['ADMIN'] } }).ctx,
    );

    // O ator (key id === id do target) tenta remover a própria role admin.
    const p = fakeCtx({
      service,
      params: { id: a1.id },
      inputs: { globalRoles: [] },
      apiKeyId: a1.id,
    });
    const res: any = await users.update(p.ctx);
    assert.equal(p.captured.status(), 409);
    assert.equal(res.error.code, 'cannot_self_demote');
  });

  test('H1: conceder role fora do catálogo via REST → 422', async ({ assert }) => {
    const users = new ApiUsersController();
    const u: any = await users.store(
      fakeCtx({ service, inputs: { email: 'cat@x.com', password: 'pw-secret-123' } }).ctx,
    );
    // STAFF não está no catálogo default (só ADMIN) e o usuário não a tinha → 422.
    const p = fakeCtx({ service, params: { id: u.id }, inputs: { globalRoles: ['STAFF'] } });
    const res: any = await users.update(p.ctx);
    assert.equal(p.captured.status(), 422);
    assert.equal(res.error.code, 'invalid_role');
  });

  // ─── M9: ator (id da API key) na auditoria REST ────────────────────────────

  test('M9: escrita REST registra actor com o id da key (não vaza a key)', async ({ assert }) => {
    const users = new ApiUsersController();
    const u: any = await users.store(
      fakeCtx({ service, inputs: { email: 'm9@x.com', password: 'pw-secret-123' } }).ctx,
    );
    // revoke-sessions audita com actorId = ctx.adminApiKeyId.
    await users.revokeSessions(
      fakeCtx({ service, params: { id: u.id }, apiKeyId: 'admin-key:9f8e7d6c' }).ctx,
    );
    const ev = service.config.audit.events.find(
      (e: any) => e.type === 'session.revoked_all' && e.accountId === u.id,
    );
    assert.isObject(ev);
    assert.equal(ev.actorId, 'admin-key:9f8e7d6c');
    // NÃO vaza a key inteira (só o prefixo curto derivado).
    assert.equal(ev.metadata.actor, 'admin-api');
  });

  test('create sem senha (invite) dispara reset e marca invited', async ({ assert }) => {
    const users = new ApiUsersController();
    const c = fakeCtx({ service, inputs: { email: 'inv@x.com', invite: true } });
    const created: any = await users.store(c.ctx);
    assert.isTrue(created.invited);
    // auditoria registrou user.created com actor admin-api
    const ev = service.config.audit.events.find((e: any) => e.type === 'user.created');
    assert.equal(ev.metadata.actor, 'admin-api');
    assert.isTrue(ev.metadata.invited);
  });

  test('create com email duplicado → 409', async ({ assert }) => {
    const users = new ApiUsersController();
    await users.store(
      fakeCtx({ service, inputs: { email: 'dup@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const c = fakeCtx({ service, inputs: { email: 'dup@x.com', password: 'pw-secret-123' } });
    const res: any = await users.store(c.ctx);
    assert.equal(c.captured.status(), 409);
    assert.equal(res.error.code, 'email_taken');
  });

  test('reset-password envia (200) e 404 p/ inexistente', async ({ assert }) => {
    const users = new ApiUsersController();
    const created: any = await users.store(
      fakeCtx({ service, inputs: { email: 'r@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const ok: any = await users.resetPassword(fakeCtx({ service, params: { id: created.id } }).ctx);
    assert.isTrue(ok.sent);
    const nf = fakeCtx({ service, params: { id: 'nope' } });
    const res: any = await users.resetPassword(nf.ctx);
    assert.equal(nf.captured.status(), 404);
    assert.equal(res.error.code, 'not_found');
  });

  test('sessions list + revoke-sessions remove os grants', async ({ assert }) => {
    const users = new ApiUsersController();
    const created: any = await users.store(
      fakeCtx({ service, inputs: { email: 's@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const id = created.id;

    // seed sessão + grant + token via adapter
    const { DatabaseAdapter } = await import('../src/adapters/database_adapter.js');
    await new DatabaseAdapter('Session', db).upsert(
      `sess-${id}`,
      { accountId: id, loginTs: 1 } as any,
      3600,
    );
    await new DatabaseAdapter('Grant', db).upsert(
      `grant-${id}`,
      { accountId: id, clientId: 'c1' } as any,
      3600,
    );
    await new DatabaseAdapter('AccessToken', db).upsert(
      `at-${id}`,
      { accountId: id, clientId: 'c1', grantId: `grant-${id}` } as any,
      3600,
    );

    const list: any = await users.sessions(fakeCtx({ service, params: { id } }).ctx);
    assert.lengthOf(list.sessions, 1);
    assert.lengthOf(list.grants, 1);

    const rev: any = await users.revokeSessions(fakeCtx({ service, params: { id } }).ctx);
    assert.equal(rev.sessions, 1);
    assert.equal(rev.grants, 1);
    // grants foram embora
    const after: any = await users.sessions(fakeCtx({ service, params: { id } }).ctx);
    assert.lengthOf(after.grants, 0);
    assert.lengthOf(after.sessions, 0);
  });

  test('clients CRUD (+ secret mostrado uma vez) e regenerate', async ({ assert }) => {
    const clients = new ApiClientsController();
    // create confidential
    const c = fakeCtx({
      service,
      inputs: {
        redirectUris: ['http://localhost/cb'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
    });
    const created: any = await clients.store(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.isString(created.clientId);
    assert.isString(created.clientSecret); // secret presente UMA vez

    const cid = created.clientId;

    // get NÃO retorna secret
    const got: any = await clients.show(fakeCtx({ service, params: { id: cid } }).ctx);
    assert.equal(got.clientId, cid);
    assert.isUndefined(got.clientSecret);

    // regenerate retorna novo secret
    const reg: any = await clients.regenerateSecret(fakeCtx({ service, params: { id: cid } }).ctx);
    assert.isString(reg.clientSecret);
    assert.notEqual(reg.clientSecret, created.clientSecret);

    // list inclui o client
    const list: any = await clients.index(fakeCtx({ service }).ctx);
    assert.isTrue(list.canList);
    assert.isTrue(list.data.some((x: any) => x.clientId === cid));

    // delete
    const del: any = await clients.destroy(fakeCtx({ service, params: { id: cid } }).ctx);
    assert.isTrue(del.deleted);
    const nf = fakeCtx({ service, params: { id: cid } });
    await clients.show(nf.ctx);
    assert.equal(nf.captured.status(), 404);
  });

  test('audit list filtra por type', async ({ assert }) => {
    const users = new ApiUsersController();
    await users.store(
      fakeCtx({ service, inputs: { email: 'a1@x.com', password: 'pw-secret-123' } }).ctx,
    );
    await users.store(
      fakeCtx({ service, inputs: { email: 'a2@x.com', password: 'pw-secret-123' } }).ctx,
    );

    const misc = new ApiMiscController();
    const all: any = await misc.audit(fakeCtx({ service, inputs: {} }).ctx);
    assert.isAtLeast(all.total, 2);
    const filtered: any = await misc.audit(
      fakeCtx({ service, inputs: { type: 'user.created' } }).ctx,
    );
    assert.isTrue(filtered.data.every((e: any) => e.type === 'user.created'));
  });

  test('tokens/verify com PAT real → active', async ({ assert }) => {
    // cria conta e emite PAT
    const users = new ApiUsersController();
    const created: any = await users.store(
      fakeCtx({ service, inputs: { email: 'pat@x.com', password: 'pw-secret-123' } }).ctx,
    );
    const { token } = await service.config.patStore.issue({
      accountId: created.id,
      name: 'CI',
      scopes: ['read'],
    });

    const misc = new ApiMiscController();
    const res: any = await misc.verify(fakeCtx({ service, inputs: { token } }).ctx);
    assert.isTrue(res.active);
    assert.equal(res.tokenType, 'pat');
    assert.equal(res.sub, created.id);
    assert.equal(res.email, 'pat@x.com');
    assert.deepEqual(res.scopes, ['read']);

    // token desconhecido → inactive
    const bad: any = await misc.verify(fakeCtx({ service, inputs: { token: 'pat_unknown' } }).ctx);
    assert.isFalse(bad.active);

    // sem token → rejeitado pela validação (Vine, → 422 pelo handler do AdonisJS)
    const empty = fakeCtx({ service, inputs: {} });
    await assert.rejects(() => misc.verify(empty.ctx));
  });

  test('GET /stats → shape completo (totais + MAU + séries 30d)', async ({ assert }) => {
    const users = new ApiUsersController();
    // Cria 2 usuários para aumentar o total.
    await users.store(
      fakeCtx({ service, inputs: { email: 'st1@x.com', password: 'pw-secret-123' } }).ctx,
    );
    await users.store(
      fakeCtx({ service, inputs: { email: 'st2@x.com', password: 'pw-secret-123' } }).ctx,
    );

    const misc = new ApiMiscController();
    const stats: any = await misc.stats(fakeCtx({ service }).ctx);

    assert.isNumber(stats.totalUsers);
    assert.isAtLeast(stats.totalUsers, 2);
    // activeSessions: null (DatabaseAdapter lista, mas não há sessões seedadas) ou número.
    assert.oneOf(typeof stats.activeSessions, ['number', 'object']); // null é objeto
    assert.isNumber(stats.mau);
    assert.isNumber(stats.signInsTotal);
    assert.isNumber(stats.signUpsTotal);
    assert.isArray(stats.signInsPerDay);
    assert.isArray(stats.signUpsPerDay);
    assert.lengthOf(stats.signInsPerDay, 30);
    assert.lengthOf(stats.signUpsPerDay, 30);
    assert.isBoolean(stats.auditSupported);
    assert.equal(stats.windowDays, 30);
    // Cada ponto tem date (YYYY-MM-DD) + count.
    const pt = stats.signInsPerDay[0];
    assert.isString(pt.date);
    assert.match(pt.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.isNumber(pt.count);
  });

  test('GET /stats degrada quando audit não tem list', async ({ assert }) => {
    // Sobe um service SEM audit para simular write-only (sem audit configurado).
    const { service: svcNoAudit, server: srv } = await startService(port++, db, {
      // sem audit → undefined → degrada
      audit: undefined,
    });
    const cleanup = () => new Promise<void>((r) => srv.close(() => r()));
    try {
      const misc = new ApiMiscController();
      const stats: any = await misc.stats(fakeCtx({ service: svcNoAudit }).ctx);
      // Sem audit, auditSupported deve ser false e séries vazias (count=0).
      assert.isFalse(stats.auditSupported);
      assert.equal(stats.signInsTotal, 0);
      assert.isTrue(stats.signInsPerDay.every((p: any) => p.count === 0));
    } finally {
      await cleanup();
    }
  });
});
