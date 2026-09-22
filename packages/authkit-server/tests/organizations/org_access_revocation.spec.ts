/**
 * Remover um membro (ou apagar a org) derruba JÁ os grants que carregam aquela org.
 *
 * O `org_*` do token sai do `Grant.activeOrg` gravado no consent. A emissão passou a
 * conferir a membership no store (ver `org_claims_code_flow.spec.ts`), mas isso só
 * age no PRÓXIMO mint: o access token e o refresh token do grant antigo seguiam vivos
 * até o TTL, e um client cookie-based seguia com o id_token velho na sessão. Estes
 * testes provam que os cinco caminhos de remoção — form `/account/orgs`, espelho JSON
 * `/account/api/orgs`, `AdminOrgsService` (console + Admin API) e `deleteOrg` —
 * revogam os grants daquela org para aquela conta, e SÓ eles:
 *
 *  - grants da mesma conta em OUTRA org ficam;
 *  - grants SEM org ficam;
 *  - grants de OUTRA conta na mesma org ficam (exceto quando a org é apagada).
 *
 * O adapter OIDC é um fake em memória (a MESMA interface `OidcAdapter` que o
 * `AdminSessionsService` consome) e o app bootado é um fake que registra a linha de
 * `auth_session_revocations` — a propagação para clients cookie-based.
 */
import { test } from '@japa/runner';
import { setBootedApp } from '../../services/booted_app.js';
import type { AccountStore } from '../../src/accounts/account_store.js';
import AccountOrgsApiController from '../../src/host/account_api/account_orgs_api_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import { AdminOrgsService } from '../../src/host/admin_api/admin_orgs_service.js';
import { AdminSessionsService } from '../../src/host/admin_sessions_service.js';
import AccountOrgsController from '../../src/host/controllers/account_orgs_controller.js';
import { revokeOrgAccess } from '../../src/host/org_access_revocation.js';

// ─── Adapter OIDC em memória ─────────────────────────────────────────────────

type Rows = Map<string, Map<string, Record<string, unknown>>>; // model -> id -> payload

function memoryAdapterClass(rows: Rows) {
  const table = (model: string) => {
    if (!rows.has(model)) rows.set(model, new Map());
    return rows.get(model)!;
  };
  return class MemoryAdapter {
    constructor(private model: string) {}
    async upsert(id: string, payload: Record<string, unknown>) {
      table(this.model).set(id, payload);
    }
    async find(id: string) {
      return table(this.model).get(id);
    }
    async findByUserCode() {
      return undefined;
    }
    async findByUid() {
      return undefined;
    }
    async consume() {}
    async destroy(id: string) {
      table(this.model).delete(id);
    }
    async revokeByGrantId(grantId: string) {
      for (const t of rows.values()) {
        for (const [id, p] of t) if (p.grantId === grantId) t.delete(id);
      }
    }
    async list() {
      return [...table(this.model).entries()].map(([id, payload]) => ({ id, payload }));
    }
  };
}

/** Semeia um grant (+ 1 AT + 1 RT) com a org ativa do consent. */
function seedGrant(rows: Rows, grantId: string, accountId: string, orgId: string | null) {
  const put = (model: string, id: string, payload: Record<string, unknown>) => {
    if (!rows.has(model)) rows.set(model, new Map());
    rows.get(model)!.set(id, payload);
  };
  put('Grant', grantId, {
    accountId,
    clientId: 'app',
    ...(orgId ? { activeOrg: { orgId, orgSlug: `slug-${orgId}`, orgRole: 'member' } } : {}),
  });
  put('AccessToken', `at-${grantId}`, { accountId, grantId });
  put('RefreshToken', `rt-${grantId}`, { accountId, grantId });
}

const grantIds = (rows: Rows) => [...(rows.get('Grant')?.keys() ?? [])].sort();
const tokenIds = (rows: Rows, model: string) => [...(rows.get(model)?.keys() ?? [])].sort();

// ─── App bootado fake: captura a revogação por `sub` ─────────────────────────

function installBootedApp() {
  const revocations: Array<{ sub: string }> = [];
  const errors: unknown[] = [];
  const db = {
    connection: () => ({
      insertQuery: () => ({
        table: (name: string) => ({
          insert: async (row: any) => {
            if (name === 'auth_session_revocations') revocations.push(row);
          },
        }),
      }),
    }),
  };
  setBootedApp({
    container: {
      make: async (key: string) => {
        if (key === 'lucid.db') return db;
        if (key === 'logger') return { error: (...args: unknown[]) => errors.push(args) };
        throw new Error(`unknown: ${key}`);
      },
    },
  } as any);
  return { revocations, errors };
}

// ─── Store com orgs em memória ───────────────────────────────────────────────

function buildStore(): AccountStore & Record<string, any> {
  const orgs = new Map<string, { id: string; name: string; slug: string; createdAt: string }>();
  const members = new Map<string, Map<string, string>>(); // orgId -> accountId -> role
  const add = (id: string, entries: Array<[string, string]>) => {
    orgs.set(id, { id, name: id, slug: `slug-${id}`, createdAt: new Date(0).toISOString() });
    members.set(id, new Map(entries));
  };
  add('org-1', [
    ['owner-1', 'owner'],
    ['user-2', 'member'],
    ['user-3', 'member'],
  ]);
  add('org-2', [
    ['owner-1', 'owner'],
    ['user-2', 'member'],
  ]);

  return {
    findById: async (id: string) => ({ id, email: `${id}@x.test`, globalRoles: [] }),
    findByEmail: async () => null,
    verifyCredentials: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async () => ({ data: [], total: 0 }),
    setGlobalRoles: async () => {},
    createOrg: async () => {
      throw new Error('not used');
    },
    findOrgById: async (id: string) => orgs.get(id) ?? null,
    findOrgBySlug: async () => null,
    listOrgsForAccount: async () => [],
    deleteOrg: async (id: string) => {
      members.delete(id);
      return orgs.delete(id);
    },
    listOrgMembers: async () => [],
    getOrgMembership: async (orgId: string, accountId: string) => {
      const role = members.get(orgId)?.get(accountId);
      return role ? { role } : null;
    },
    removeOrgMember: async (orgId: string, accountId: string) => {
      const m = members.get(orgId);
      if (!m?.has(accountId)) return { ok: false, reason: 'not_found' as const };
      const owners = [...m.values()].filter((r) => r === 'owner').length;
      if (m.get(accountId) === 'owner' && owners <= 1) {
        return { ok: false, reason: 'last_owner' as const };
      }
      m.delete(accountId);
      return { ok: true };
    },
  } as any;
}

function buildCfg(store: AccountStore, rows: Rows) {
  return {
    accountStore: store,
    AdapterClass: memoryAdapterClass(rows),
    issuer: 'https://idp.test',
    messages: {},
    organizations: { roles: ['owner', 'admin', 'member'], allowSelfCreate: false },
    audit: { record: async () => {} },
    mail: {},
  } as any;
}

/** Mesmo shape de ctx dos specs de orgs member-facing (JSON e form). */
function fakeCtx(opts: { actorId: string; params: Record<string, string>; service: any }) {
  let status = 200;
  const err = (code: number) => (payload?: any) => {
    status = code;
    return payload;
  };
  const ctx: any = {
    request: {
      input: (_k: string, def?: unknown) => def,
      param: (k: string) => opts.params[k],
      cookie: () => undefined,
      ip: () => '203.0.113.7',
    },
    params: opts.params,
    response: {
      status: (s: number) => {
        status = s;
        return { send: (b: any) => b };
      },
      forbidden: err(403),
      notFound: err(404),
      unauthorized: err(401),
      redirect: () => null,
      cookie: () => {},
      clearCookie: () => {},
    },
    session: { get: (k: string) => (k === ACCOUNT_SESSION_KEY ? opts.actorId : undefined) },
    containerResolver: {
      make: async (name: string) => {
        if (name === 'authkit.server') return opts.service;
        throw new Error(`unknown binding: ${name}`);
      },
    },
  };
  return { ctx, status: () => status };
}

/**
 * Cenário padrão: user-2 tem grant com org-1, grant com org-2 e grant sem org;
 * user-3 tem grant com org-1.
 */
function scenario() {
  const rows: Rows = new Map();
  seedGrant(rows, 'g-u2-org1', 'user-2', 'org-1');
  seedGrant(rows, 'g-u2-org2', 'user-2', 'org-2');
  seedGrant(rows, 'g-u2-none', 'user-2', null);
  seedGrant(rows, 'g-u3-org1', 'user-3', 'org-1');
  const store = buildStore();
  const cfg = buildCfg(store, rows);
  return { rows, store, cfg, service: { config: cfg } };
}

test.group('revogação de grants por org — AdminSessionsService.revokeOrgGrants', (group) => {
  let booted: ReturnType<typeof installBootedApp>;
  group.each.setup(() => {
    booted = installBootedApp();
    return () => setBootedApp(undefined as any);
  });

  test('conta + org: derruba só o grant daquela org para aquela conta (e seus tokens)', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const result = await new AdminSessionsService(service as any).revokeOrgGrants(
      'org-1',
      'user-2',
    );

    assert.deepEqual(result, { sessions: 0, grants: 1, accessTokens: 1, refreshTokens: 1 });
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2', 'g-u3-org1']);
    assert.notInclude(tokenIds(rows, 'AccessToken'), 'at-g-u2-org1');
    assert.notInclude(tokenIds(rows, 'RefreshToken'), 'rt-g-u2-org1');
    assert.deepEqual(
      booted.revocations.map((r) => r.sub),
      ['user-2'],
      'cookie-based: a sessão do client cai já',
    );
  });

  test('só org (org apagada): derruba os grants daquela org de TODAS as contas', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const result = await new AdminSessionsService(service as any).revokeOrgGrants('org-1');

    assert.equal(result.grants, 2);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2']);
    assert.deepEqual(booted.revocations.map((r) => r.sub).sort(), ['user-2', 'user-3']);
  });

  test('nenhum grant com a org: não mexe em nada nem grava revogação por sub', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const result = await new AdminSessionsService(service as any).revokeOrgGrants('org-9');

    assert.deepEqual(result, { sessions: 0, grants: 0, accessTokens: 0, refreshTokens: 0 });
    assert.lengthOf(grantIds(rows), 4);
    assert.lengthOf(booted.revocations, 0, 'sem grant afetado, ninguém é deslogado');
  });

  test('revokeOrgAccess sem adapter OIDC no service: no-op, não lança', async ({ assert }) => {
    assert.isNull(await revokeOrgAccess({ config: {} } as any, 'org-1', 'user-2'));
    assert.isNull(await revokeOrgAccess(undefined, 'org-1'));
  });

  test('revokeOrgAccess engole a falha do adapter, mas LOGA em error', async ({ assert }) => {
    const { cfg } = scenario();
    cfg.AdapterClass = class {
      async list(): Promise<never> {
        throw new Error('adapter down');
      }
    };
    assert.isNull(await revokeOrgAccess({ config: cfg } as any, 'org-1', 'user-2'));
    assert.lengthOf(booted.errors, 1);
  });
});

test.group('revogação de grants por org — caminhos de remoção', (group) => {
  group.each.setup(() => {
    installBootedApp();
    return () => setBootedApp(undefined as any);
  });

  test('AdminOrgsService.removeMember (console + Admin API) revoga o grant da org', async ({
    assert,
  }) => {
    const { rows, cfg, service } = scenario();
    const r = await new AdminOrgsService(cfg, service).removeMember('org-1', 'user-2', {
      actorId: 'admin',
      ip: null,
    });
    assert.isTrue(r.ok);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2', 'g-u3-org1']);
  });

  test('AdminOrgsService.removeMember recusado (último owner): nada é revogado', async ({
    assert,
  }) => {
    const { rows, cfg, service } = scenario();
    seedGrant(rows, 'g-o1-org1', 'owner-1', 'org-1');
    const r = await new AdminOrgsService(cfg, service).removeMember('org-1', 'owner-1', {
      actorId: 'admin',
      ip: null,
    });
    assert.isFalse(r.ok);
    assert.include(grantIds(rows), 'g-o1-org1', 'quem continua membro não perde o grant');
  });

  test('AdminOrgsService.deleteOrg revoga os grants da org de todas as contas', async ({
    assert,
  }) => {
    const { rows, cfg, service } = scenario();
    const r = await new AdminOrgsService(cfg, service).deleteOrg('org-1', {
      actorId: 'admin',
      ip: null,
    });
    assert.isTrue(r.ok);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2']);
  });

  test('/account/api/orgs/:id/leave revoga o grant da org de quem saiu', async ({ assert }) => {
    const { rows, service } = scenario();
    const { ctx } = fakeCtx({ actorId: 'user-2', params: { id: 'org-1' }, service });
    await new AccountOrgsApiController().leaveOrg(ctx);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2', 'g-u3-org1']);
  });

  test('DELETE /account/api/orgs/:id/members/:accountId revoga o grant do removido', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const { ctx } = fakeCtx({
      actorId: 'owner-1',
      params: { id: 'org-1', accountId: 'user-3' },
      service,
    });
    await new AccountOrgsApiController().removeMember(ctx);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org1', 'g-u2-org2']);
  });

  test('/account/api: não-manager tentando remover NÃO revoga nada', async ({ assert }) => {
    const { rows, service } = scenario();
    const { ctx, status } = fakeCtx({
      actorId: 'user-2',
      params: { id: 'org-1', accountId: 'user-3' },
      service,
    });
    await new AccountOrgsApiController().removeMember(ctx);
    assert.equal(status(), 403);
    assert.lengthOf(grantIds(rows), 4);
  });

  test('POST /account/orgs/:id/leave (form) revoga o grant da org de quem saiu', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const { ctx } = fakeCtx({ actorId: 'user-2', params: { id: 'org-1' }, service });
    await new AccountOrgsController().leave(ctx);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org2', 'g-u3-org1']);
  });

  test('POST /account/orgs/:id/members/:accountId/remove (form) revoga o grant', async ({
    assert,
  }) => {
    const { rows, service } = scenario();
    const { ctx } = fakeCtx({
      actorId: 'owner-1',
      params: { id: 'org-1', accountId: 'user-3' },
      service,
    });
    await new AccountOrgsController().removeMember(ctx);
    assert.deepEqual(grantIds(rows), ['g-u2-none', 'g-u2-org1', 'g-u2-org2']);
  });
});
