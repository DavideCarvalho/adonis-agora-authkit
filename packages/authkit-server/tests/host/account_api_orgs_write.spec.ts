/**
 * Account Self-Service JSON API — ESCRITA de organizações
 * (`AccountOrgsApiController`, rotas `POST|PATCH|DELETE /account/api/orgs*`).
 *
 * O que estes testes protegem, além do caminho feliz: que o espelho JSON não
 * seja MAIS FROUXO que o formulário que ele espelha. Cada regra do
 * `AccountOrgsController` tem aqui o seu caso negativo —
 *
 *   - sem sessão → 401 (nunca "assume" a conta do corpo);
 *   - store sem orgs → 404 `not_supported` (capability-probed);
 *   - `allowSelfCreate` desligado → 403, e a política EFETIVA (setting) manda;
 *   - convidar/revogar/remover/promover sem ser owner|admin da org do path → 403;
 *   - IDOR cross-org: owner da org A não revoga convite da org B;
 *   - escalonamento: admin não concede `owner`;
 *   - role fora do catálogo → 422;
 *   - convite expirado → 410, e-mail trocado → 403.
 *
 * Mesmo estilo do `tests/organizations/account_orgs_member_facing.spec.ts`:
 * store em memória + fake HttpContext, sem roteador real. `make('lucid.db')`
 * rejeita por default → a política efetiva cai no config estático; o grupo de
 * settings injeta um db fake para provar a camada de runtime.
 */

import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import AccountOrgsApiController from '../../src/host/account_api/account_orgs_api_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';

// ─── Store em memória (orgs completo) ────────────────────────────────────────

function buildMemoryStore(): AccountStore & Record<string, any> {
  const accounts = new Map<string, any>();
  const orgs = new Map<string, any>();
  const members = new Map<string, Map<string, any>>();
  const invitations = new Map<string, any>();
  const slugs = new Set<string>();
  let counter = 0;
  const newId = () => `id-${++counter}`;

  const store: any = {
    findById: async (id: string) => accounts.get(id) ?? null,
    findByEmail: async (email: string) =>
      [...accounts.values()].find((a) => a.email === email) ?? null,
    verifyCredentials: async () => null,
    create: async (input: any) => {
      const acc = { id: input.id ?? newId(), email: input.email, name: null, globalRoles: [] };
      accounts.set(acc.id, acc);
      return acc;
    },
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async () => ({ data: [...accounts.values()], total: accounts.size }),
    setGlobalRoles: async () => {},

    createOrg: async (input: any) => {
      // Slug único: é o que dá ao endpoint o 409 `slug_taken`.
      if (slugs.has(input.slug)) throw new Error('duplicate slug');
      slugs.add(input.slug);
      const org = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        logoUrl: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      orgs.set(org.id, org);
      members.set(org.id, new Map([[input.ownerAccountId, { role: 'owner' }]]));
      return org;
    },
    findOrgById: async (orgId: string) => orgs.get(orgId) ?? null,
    findOrgBySlug: async () => null,
    listOrgsForAccount: async () => [],
    updateOrg: async () => null,
    deleteOrg: async () => false,
    listOrgMembers: async (orgId: string) =>
      [...(members.get(orgId) ?? new Map()).entries()].map(([accountId, v]: any) => ({
        accountId,
        email: null,
        role: v.role,
        joinedAt: '',
      })),
    addOrgMember: async (orgId: string, accountId: string, role: string) => {
      if (!members.has(orgId)) members.set(orgId, new Map());
      members.get(orgId)?.set(accountId, { role });
    },
    removeOrgMember: async (orgId: string, accountId: string) => {
      const m = members.get(orgId);
      if (!m?.has(accountId)) return { ok: false, reason: 'not_found' as const };
      const owners = [...m.values()].filter((v: any) => v.role === 'owner').length;
      if (m.get(accountId)?.role === 'owner' && owners <= 1) {
        return { ok: false, reason: 'last_owner' as const };
      }
      m.delete(accountId);
      return { ok: true };
    },
    updateOrgMemberRole: async (orgId: string, accountId: string, newRole: string) => {
      const m = members.get(orgId);
      if (!m?.has(accountId)) return { ok: false, reason: 'not_found' as const };
      const owners = [...m.values()].filter((v: any) => v.role === 'owner').length;
      if (m.get(accountId)?.role === 'owner' && newRole !== 'owner' && owners <= 1) {
        return { ok: false, reason: 'last_owner' as const };
      }
      m.set(accountId, { role: newRole });
      return { ok: true };
    },
    getOrgMembership: async (orgId: string, accountId: string) => {
      const v = members.get(orgId)?.get(accountId);
      return v ? { role: v.role } : null;
    },
    createOrgInvitation: async (input: any) => {
      const id = newId();
      const inv = {
        id,
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        invitedBy: input.invitedBy,
        tokenHash: `hash-${id}`,
        ttlHours: input.ttlHours,
        expiresAt: new Date(Date.now() + input.ttlHours * 3600000).toISOString(),
        acceptedAt: null,
        createdAt: new Date().toISOString(),
      };
      invitations.set(id, inv);
      return { invitation: inv, token: `tok-${id}` };
    },
    findInvitationByTokenHash: async (hash: string) =>
      [...invitations.values()].find((i) => i.tokenHash === hash) ?? null,
    listPendingInvitationsForOrg: async (orgId: string) =>
      [...invitations.values()].filter((i) => i.organizationId === orgId && !i.acceptedAt),
    listPendingInvitationsForEmail: async () => [],
    acceptInvitation: async () => ({ ok: true }),
    revokeInvitation: async (organizationId: string, invitationId: string) => {
      const inv = invitations.get(invitationId);
      if (!inv || inv.organizationId !== organizationId) return false;
      invitations.delete(invitationId);
      return true;
    },
    removeAccountFromAllOrgs: async () => ({ memberships: 0, invitations: 0 }),

    _invitations: invitations,
    _members: members,
  };
  return store;
}

/** Store SEM a capacidade de organizações (o `createOrg` é o probe). */
function buildStoreWithoutOrgs(): AccountStore {
  return {
    findById: async () => null,
    findByEmail: async () => null,
    verifyCredentials: async () => null,
    create: async () => ({ id: 'x', email: 'x@x.com', globalRoles: [] }) as any,
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async () => ({ data: [], total: 0 }),
    setGlobalRoles: async () => {},
  } as any;
}

// ─── Config + fake ctx ───────────────────────────────────────────────────────

function buildCfg(store: AccountStore, orgOverrides: Record<string, unknown> = {}) {
  const events: any[] = [];
  return {
    accountStore: store,
    issuer: 'https://idp.test',
    messages: {},
    organizations: {
      roles: ['owner', 'admin', 'member'],
      allowSelfCreate: true,
      invitationTtlHours: 72,
      ...orgOverrides,
    },
    audit: { events, record: async (e: any) => events.push(e) },
    // Hook do host: captura o convite sem tocar em mailer nenhum.
    mail: { sentInvitations: [] as any[], onOrgInvitation: async () => {} },
  } as any;
}

function fakeCtx(opts: {
  actorId?: string;
  params?: Record<string, string>;
  inputs?: Record<string, unknown>;
  cfg: any;
  /** db fake para o RuntimeSettings; ausente → `make('lucid.db')` rejeita. */
  db?: any;
}) {
  let status = 200;
  let body: any;
  const cookies: Record<string, string | null> = {};

  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const err = (code: number) => (payload?: any) => {
    status = code;
    return setBody(payload);
  };

  const ctx: any = {
    request: {
      input: (k: string, def?: unknown) => opts.inputs?.[k] ?? def,
      param: (k: string) => opts.params?.[k],
      body: () => opts.inputs ?? {},
      ip: () => '203.0.113.7',
      protocol: () => 'https',
      host: () => 'idp.test',
      secure: () => true,
      cookie: () => undefined,
    },
    params: opts.params ?? {},
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      forbidden: err(403),
      notFound: err(404),
      unauthorized: err(401),
      badRequest: err(400),
      conflict: err(409),
      unprocessableEntity: err(422),
      cookie: (name: string, value: string) => {
        cookies[name] = value;
      },
      clearCookie: (name: string) => {
        cookies[name] = null;
      },
      redirect: () => {
        throw new Error('o caminho JSON NUNCA deve redirecionar');
      },
    },
    session: {
      get: (k: string) => (k === ACCOUNT_SESSION_KEY ? opts.actorId : undefined),
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    containerResolver: {
      make: async (name: string) => {
        if (name === 'lucid.db') {
          if (opts.db) return opts.db;
          throw new Error('no db in test');
        }
        if (name === 'authkit.server') return { config: opts.cfg };
        throw new Error(`unknown binding: ${name}`);
      },
    },
  };

  return { ctx, captured: { status: () => status, body: () => body, cookies: () => cookies } };
}

/**
 * `lucid.db` fake com as linhas de `auth_settings` — mesma forma do helper de
 * `tests/organizations/account_orgs_member_facing.spec.ts` (o `value` chega ao
 * `RuntimeSettings` como TEXTO JSON, que é como a coluna guarda). Rows com
 * `organization_id` respondem só à consulta escopada naquela org.
 */
function fakeSettingsDb(
  rows: Array<{ key: string; organizationId?: string | null; value: unknown }>,
) {
  const chain = (filters: Record<string, string | null>) => ({
    where: (col: string, val: string) => chain({ ...filters, [col]: val }),
    whereNull: (col: string) => chain({ ...filters, [col]: null }),
    first: async () => {
      const row = rows.find(
        (r) =>
          r.key === filters.key && (r.organizationId ?? null) === (filters.organization_id ?? null),
      );
      return row
        ? {
            key: row.key,
            organization_id: row.organizationId ?? null,
            value: JSON.stringify(row.value),
            updated_at: null,
          }
        : null;
    },
  });
  const table = () => ({
    select: () => ({ limit: async () => [] }),
    where: (col: string, val: string) => chain({ [col]: val }),
    whereNull: (col: string) => chain({ [col]: null }),
  });
  return { from: table, table };
}

// ─── POST /account/api/orgs ──────────────────────────────────────────────────

test.group('AccountOrgsApiController — POST /account/api/orgs', () => {
  test('cria a org e devolve 201 com o papel de owner', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const actor = await (store as any).create({ email: 'o@x.com' });

    const { ctx, captured } = fakeCtx({
      actorId: actor.id,
      inputs: { name: 'Acme', slug: 'acme' },
      cfg,
    });
    const result: any = await new AccountOrgsApiController().createOrg(ctx);

    assert.equal(captured.status(), 201);
    assert.equal(result.slug, 'acme');
    assert.equal(result.role, 'owner');
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'organization.created'));
  });

  test('sem sessão → 401 (não aceita conta vinda do corpo)', async ({ assert }) => {
    const store = buildMemoryStore();
    const { ctx, captured } = fakeCtx({
      inputs: { name: 'Acme', slug: 'acme', accountId: 'someone-else' },
      cfg: buildCfg(store),
    });
    await new AccountOrgsApiController().createOrg(ctx);
    assert.equal(captured.status(), 401);
  });

  test('store sem capacidade de orgs → 404 not_supported', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({
      actorId: 'a1',
      inputs: { name: 'Acme', slug: 'acme' },
      cfg: buildCfg(buildStoreWithoutOrgs()),
    });
    await new AccountOrgsApiController().createOrg(ctx);
    assert.equal(captured.status(), 404);
    assert.equal(captured.body().error.code, 'not_supported');
  });

  test('allowSelfCreate desligado → 403 e nada é criado', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store, { allowSelfCreate: false });
    const actor = await (store as any).create({ email: 'o@x.com' });

    const { ctx, captured } = fakeCtx({
      actorId: actor.id,
      inputs: { name: 'Acme', slug: 'acme' },
      cfg,
    });
    await new AccountOrgsApiController().createOrg(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'self_create_disabled');
    assert.isFalse(cfg.audit.events.some((e: any) => e.type === 'organization.created'));
  });

  test('a setting organizations_policy manda sobre o config (política efetiva)', async ({
    assert,
  }) => {
    const store = buildMemoryStore();
    // Config diz NÃO; a setting global diz SIM. Vence a setting — é a mesma
    // ordem (org → global → config → default) do caminho HTML.
    const cfg = buildCfg(store, { allowSelfCreate: false });
    const actor = await (store as any).create({ email: 'o@x.com' });

    const { ctx, captured } = fakeCtx({
      actorId: actor.id,
      inputs: { name: 'Acme', slug: 'acme' },
      cfg,
      db: fakeSettingsDb([{ key: 'organizations_policy', value: { allowSelfCreate: true } }]),
    });
    await new AccountOrgsApiController().createOrg(ctx);

    assert.equal(captured.status(), 201);
  });

  test('name/slug ausentes → 400 invalid_input', async ({ assert }) => {
    const store = buildMemoryStore();
    const actor = await (store as any).create({ email: 'o@x.com' });
    const { ctx, captured } = fakeCtx({
      actorId: actor.id,
      inputs: { name: '  ' },
      cfg: buildCfg(store),
    });
    await new AccountOrgsApiController().createOrg(ctx);
    assert.equal(captured.status(), 400);
    assert.equal(captured.body().error.code, 'invalid_input');
  });

  test('slug duplicado → 409 slug_taken (o form só redirecionava em silêncio)', async ({
    assert,
  }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const actor = await (store as any).create({ email: 'o@x.com' });
    await (store as any).createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: actor.id });

    const { ctx, captured } = fakeCtx({
      actorId: actor.id,
      inputs: { name: 'Outra', slug: 'acme' },
      cfg,
    });
    await new AccountOrgsApiController().createOrg(ctx);

    assert.equal(captured.status(), 409);
    assert.equal(captured.body().error.code, 'slug_taken');
  });
});

// ─── activate / deactivate ───────────────────────────────────────────────────

test.group('AccountOrgsApiController — activate/deactivate', () => {
  test('membro ativa a org → cookie gravado', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({ actorId: owner.id, params: { id: org.id }, cfg });
    const result: any = await new AccountOrgsApiController().activateOrg(ctx);

    assert.equal(captured.status(), 200);
    assert.equal(result.activeOrgId, org.id);
    assert.isString(captured.cookies().authkit_active_org);
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'organization.switched'));
  });

  test('não-membro ativando org alheia → 404 (não revela que a org existe)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const stranger = await (store as any).create({ email: 's@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({ actorId: stranger.id, params: { id: org.id }, cfg });
    await new AccountOrgsApiController().activateOrg(ctx);

    assert.equal(captured.status(), 404);
    assert.isUndefined(captured.cookies().authkit_active_org);
  });

  test('deactivate limpa o cookie', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const actor = await (store as any).create({ email: 'o@x.com' });

    const { ctx, captured } = fakeCtx({ actorId: actor.id, cfg });
    const result: any = await new AccountOrgsApiController().deactivateOrg(ctx);

    assert.isNull(result.activeOrgId);
    assert.isNull(captured.cookies().authkit_active_org);
  });
});

// ─── leave ───────────────────────────────────────────────────────────────────

test.group('AccountOrgsApiController — leave', () => {
  test('membro comum sai → ok', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({ actorId: member.id, params: { id: org.id }, cfg });
    await new AccountOrgsApiController().leaveOrg(ctx);

    assert.equal(captured.status(), 200);
    assert.isNull(await (store as any).getOrgMembership(org.id, member.id));
  });

  test('último owner não sai → 409 last_owner', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({ actorId: owner.id, params: { id: org.id }, cfg });
    await new AccountOrgsApiController().leaveOrg(ctx);

    assert.equal(captured.status(), 409);
    assert.equal(captured.body().error.code, 'last_owner');
  });
});

// ─── invite ──────────────────────────────────────────────────────────────────

test.group('AccountOrgsApiController — invite', () => {
  test('owner convida member → 201 e o token NÃO volta no corpo', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id },
      inputs: { email: 'new@x.com', role: 'member' },
      cfg,
    });
    const result: any = await new AccountOrgsApiController().inviteMember(ctx);

    assert.equal(captured.status(), 201);
    assert.equal(result.email, 'new@x.com');
    assert.isUndefined(result.token);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(org.id), 1);
  });

  test('membro comum convidando → 403 (precisa de owner|admin)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: member.id,
      params: { id: org.id },
      inputs: { email: 'new@x.com', role: 'member' },
      cfg,
    });
    await new AccountOrgsApiController().inviteMember(ctx);

    assert.equal(captured.status(), 403);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(org.id), 0);
  });

  test('conta de OUTRA org convidando → 403 (cross-org)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const ownerA = await (store as any).create({ email: 'a@x.com' });
    const ownerB = await (store as any).create({ email: 'b@x.com' });
    const orgA = await (store as any).createOrg({
      name: 'A',
      slug: 'a',
      ownerAccountId: ownerA.id,
    });
    const orgB = await (store as any).createOrg({
      name: 'B',
      slug: 'b',
      ownerAccountId: ownerB.id,
    });
    void orgA;

    const { ctx, captured } = fakeCtx({
      actorId: ownerA.id,
      params: { id: orgB.id },
      inputs: { email: 'new@x.com', role: 'member' },
      cfg,
    });
    await new AccountOrgsApiController().inviteMember(ctx);

    assert.equal(captured.status(), 403);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(orgB.id), 0);
  });

  test('admin convidando como owner → 403 (escalonamento)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const adminUser = await (store as any).create({ email: 'ad@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, adminUser.id, 'admin');

    const { ctx, captured } = fakeCtx({
      actorId: adminUser.id,
      params: { id: org.id },
      inputs: { email: 'x@x.com', role: 'owner' },
      cfg,
    });
    await new AccountOrgsApiController().inviteMember(ctx);

    assert.equal(captured.status(), 403);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(org.id), 0);
  });

  test('role fora do catálogo → 422 invalid_role', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id },
      inputs: { email: 'x@x.com', role: 'superadmin' },
      cfg,
    });
    await new AccountOrgsApiController().inviteMember(ctx);

    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'invalid_role');
  });

  test('o TTL do convite vem da política efetiva (config, aqui 72h)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store, { invitationTtlHours: 72 });
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id },
      inputs: { email: 'x@x.com', role: 'member' },
      cfg,
    });
    await new AccountOrgsApiController().inviteMember(ctx);

    const [inv]: any[] = await (store as any).listPendingInvitationsForOrg(org.id);
    assert.equal(inv.ttlHours, 72);
  });
});

// ─── revokeInvitation ────────────────────────────────────────────────────────

test.group('AccountOrgsApiController — revokeInvitation', () => {
  test('owner da org A NÃO revoga convite da org B (IDOR) → 404 e convite intacto', async ({
    assert,
  }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const ownerA = await (store as any).create({ email: 'a@x.com' });
    const ownerB = await (store as any).create({ email: 'b@x.com' });
    const orgA = await (store as any).createOrg({
      name: 'A',
      slug: 'a',
      ownerAccountId: ownerA.id,
    });
    const orgB = await (store as any).createOrg({
      name: 'B',
      slug: 'b',
      ownerAccountId: ownerB.id,
    });
    const { invitation: invB } = await (store as any).createOrgInvitation({
      organizationId: orgB.id,
      email: 'v@x.com',
      role: 'member',
      invitedBy: ownerB.id,
      ttlHours: 24,
    });

    const { ctx, captured } = fakeCtx({
      actorId: ownerA.id,
      params: { id: orgA.id, invId: invB.id },
      cfg,
    });
    await new AccountOrgsApiController().revokeInvitation(ctx);

    assert.equal(captured.status(), 404);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(orgB.id), 1);
  });

  test('owner revoga convite da própria org → ok', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    const { invitation } = await (store as any).createOrgInvitation({
      organizationId: org.id,
      email: 'v@x.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id, invId: invitation.id },
      cfg,
    });
    await new AccountOrgsApiController().revokeInvitation(ctx);

    assert.equal(captured.status(), 200);
    assert.lengthOf(await (store as any).listPendingInvitationsForOrg(org.id), 0);
  });
});

// ─── members: remove + updateRole ────────────────────────────────────────────

test.group('AccountOrgsApiController — membros', () => {
  test('admin remove member → ok', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const adminUser = await (store as any).create({ email: 'ad@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, adminUser.id, 'admin');
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: adminUser.id,
      params: { id: org.id, accountId: member.id },
      cfg,
    });
    await new AccountOrgsApiController().removeMember(ctx);

    assert.equal(captured.status(), 200);
    assert.isNull(await (store as any).getOrgMembership(org.id, member.id));
  });

  test('membro comum removendo outro → 403 e nada muda', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const m1 = await (store as any).create({ email: 'm1@x.com' });
    const m2 = await (store as any).create({ email: 'm2@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, m1.id, 'member');
    await (store as any).addOrgMember(org.id, m2.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: m1.id,
      params: { id: org.id, accountId: m2.id },
      cfg,
    });
    await new AccountOrgsApiController().removeMember(ctx);

    assert.equal(captured.status(), 403);
    assert.isNotNull(await (store as any).getOrgMembership(org.id, m2.id));
  });

  test('owner promove member → admin', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id, accountId: member.id },
      inputs: { role: 'admin' },
      cfg,
    });
    await new AccountOrgsApiController().updateMemberRole(ctx);

    assert.equal(captured.status(), 200);
    assert.deepEqual(await (store as any).getOrgMembership(org.id, member.id), { role: 'admin' });
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'organization.member_role_updated'));
  });

  test('admin promovendo alguém a owner → 403 (escalonamento)', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const adminUser = await (store as any).create({ email: 'ad@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, adminUser.id, 'admin');
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: adminUser.id,
      params: { id: org.id, accountId: member.id },
      inputs: { role: 'owner' },
      cfg,
    });
    await new AccountOrgsApiController().updateMemberRole(ctx);

    assert.equal(captured.status(), 403);
    assert.deepEqual(await (store as any).getOrgMembership(org.id, member.id), { role: 'member' });
  });

  test('role fora do catálogo → 422', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const member = await (store as any).create({ email: 'm@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    await (store as any).addOrgMember(org.id, member.id, 'member');

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id, accountId: member.id },
      inputs: { role: 'root' },
      cfg,
    });
    await new AccountOrgsApiController().updateMemberRole(ctx);

    assert.equal(captured.status(), 422);
    assert.deepEqual(await (store as any).getOrgMembership(org.id, member.id), { role: 'member' });
  });

  test('rebaixar o último owner → 409 last_owner', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      params: { id: org.id, accountId: owner.id },
      inputs: { role: 'member' },
      cfg,
    });
    await new AccountOrgsApiController().updateMemberRole(ctx);

    assert.equal(captured.status(), 409);
    assert.equal(captured.body().error.code, 'last_owner');
  });
});

// ─── acceptInvitation ────────────────────────────────────────────────────────

test.group('AccountOrgsApiController — acceptInvitation', () => {
  test('token válido → ok e evento de auditoria', async ({ assert }) => {
    const store = buildMemoryStore();
    const cfg = buildCfg(store);
    const owner = await (store as any).create({ email: 'o@x.com' });
    const invitee = await (store as any).create({ email: 'i@x.com' });
    const org = await (store as any).createOrg({ name: 'A', slug: 'a', ownerAccountId: owner.id });
    const { invitation } = await (store as any).createOrgInvitation({
      organizationId: org.id,
      email: 'i@x.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    // O controller procura pelo sha256 do token; o store fake guarda `hash-<id>`.
    (store as any).findInvitationByTokenHash = async () => invitation;

    const { ctx, captured } = fakeCtx({
      actorId: invitee.id,
      params: { token: 'tok-whatever' },
      cfg,
    });
    const result: any = await new AccountOrgsApiController().acceptInvitation(ctx);

    assert.equal(captured.status(), 200);
    assert.equal(result.organizationId, org.id);
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'organization.invitation_accepted'));
  });

  test('token desconhecido → 404', async ({ assert }) => {
    const store = buildMemoryStore();
    const invitee = await (store as any).create({ email: 'i@x.com' });
    const { ctx, captured } = fakeCtx({
      actorId: invitee.id,
      params: { token: 'nope' },
      cfg: buildCfg(store),
    });
    await new AccountOrgsApiController().acceptInvitation(ctx);
    assert.equal(captured.status(), 404);
  });

  test('convite EXPIRADO → 410 expired', async ({ assert }) => {
    const store = buildMemoryStore();
    const invitee = await (store as any).create({ email: 'i@x.com' });
    (store as any).findInvitationByTokenHash = async () => ({
      id: 'inv-1',
      organizationId: 'org-1',
      email: 'i@x.com',
      role: 'member',
    });
    (store as any).acceptInvitation = async () => ({ ok: false, reason: 'expired' });

    const { ctx, captured } = fakeCtx({
      actorId: invitee.id,
      params: { token: 'tok' },
      cfg: buildCfg(store),
    });
    await new AccountOrgsApiController().acceptInvitation(ctx);

    assert.equal(captured.status(), 410);
    assert.equal(captured.body().error.code, 'expired');
  });

  test('convite de OUTRO e-mail → 403 email_mismatch', async ({ assert }) => {
    const store = buildMemoryStore();
    const invitee = await (store as any).create({ email: 'i@x.com' });
    (store as any).findInvitationByTokenHash = async () => ({
      id: 'inv-1',
      organizationId: 'org-1',
      email: 'outro@x.com',
      role: 'member',
    });
    (store as any).acceptInvitation = async () => ({ ok: false, reason: 'email_mismatch' });

    const { ctx, captured } = fakeCtx({
      actorId: invitee.id,
      params: { token: 'tok' },
      cfg: buildCfg(store),
    });
    await new AccountOrgsApiController().acceptInvitation(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'email_mismatch');
  });

  test('sem sessão → 401', async ({ assert }) => {
    const store = buildMemoryStore();
    const { ctx, captured } = fakeCtx({ params: { token: 'tok' }, cfg: buildCfg(store) });
    await new AccountOrgsApiController().acceptInvitation(ctx);
    assert.equal(captured.status(), 401);
  });
});
