/**
 * Testes do ConsoleOrgsController — JSON API do console admin React.
 *
 * Verifica cada novo endpoint (create/update/delete/members/invitations),
 * o 404 de capability_unsupported e que rotas write não são sombreadas
 * pelo catch-all do shell (verificação de ordem, não de roteador real).
 */
import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import { AdminOrgsService } from '../../src/host/admin_api/admin_orgs_service.js';
import ConsoleOrgsController from '../../src/host/admin_console/console_orgs_controller.js';

// ─── Store em memória com capability de Organizations ─────────────────────────

function buildMemoryStore(): AccountStore {
  const accounts = new Map<string, any>();
  accounts.set('owner-1', {
    id: 'owner-1',
    email: 'owner@acme.com',
    name: 'Owner',
    globalRoles: [],
  });
  accounts.set('user-2', { id: 'user-2', email: 'user@acme.com', name: 'User', globalRoles: [] });

  const orgs = new Map<string, any>();
  const members = new Map<string, Map<string, any>>();
  const invitations = new Map<string, any>();

  let counter = 0;
  const newId = () => `id-${++counter}`;

  return {
    findById: async (id) => accounts.get(id) ?? null,
    findByEmail: async (email) => [...accounts.values()].find((a) => a.email === email) ?? null,
    verifyCredentials: async () => null,
    create: async (input) => {
      const acc = {
        id: newId(),
        email: input.email,
        name: input.fullName ?? null,
        globalRoles: [],
      };
      accounts.set(acc.id, acc);
      return acc;
    },
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async ({ page = 1, limit = 20 }) => {
      const data = [...accounts.values()];
      return { data: data.slice((page - 1) * limit, page * limit), total: data.length };
    },
    setGlobalRoles: async () => {},

    createOrg: async (input) => {
      if ([...orgs.values()].some((o) => o.slug === input.slug)) throw new Error('slug_taken');
      const org = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        logoUrl: input.logoUrl ?? null,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      orgs.set(org.id, org);
      const orgMembers = new Map<string, any>();
      orgMembers.set(input.ownerAccountId, { role: 'owner', createdAt: new Date().toISOString() });
      members.set(org.id, orgMembers);
      return org;
    },
    findOrgById: async (orgId) => orgs.get(orgId) ?? null,
    findOrgBySlug: async (slug) => [...orgs.values()].find((o) => o.slug === slug) ?? null,
    listOrgsForAccount: async (accountId) => {
      const result: any[] = [];
      for (const [orgId, orgMembers] of members) {
        const m = orgMembers.get(accountId);
        if (m) {
          const org = orgs.get(orgId);
          if (org) result.push({ ...org, role: m.role });
        }
      }
      return result;
    },
    updateOrg: async (orgId, patch) => {
      const org = orgs.get(orgId);
      if (!org) return null;
      if (patch.name !== undefined) org.name = patch.name;
      if (patch.logoUrl !== undefined) org.logoUrl = patch.logoUrl;
      return org;
    },
    deleteOrg: async (orgId) => {
      if (!orgs.has(orgId)) return false;
      orgs.delete(orgId);
      members.delete(orgId);
      for (const [id, inv] of invitations) {
        if (inv.organizationId === orgId) invitations.delete(id);
      }
      return true;
    },
    listOrgMembers: async (orgId) => {
      const orgMembers = members.get(orgId);
      if (!orgMembers) return [];
      return [...orgMembers.entries()].map(([accountId, m]) => ({
        accountId,
        email: accounts.get(accountId)?.email ?? null,
        role: m.role,
        joinedAt: m.createdAt,
      }));
    },
    addOrgMember: async (orgId, accountId, role) => {
      if (!members.has(orgId)) members.set(orgId, new Map());
      members.get(orgId)!.set(accountId, { role, createdAt: new Date().toISOString() });
    },
    removeOrgMember: async (orgId, accountId) => {
      const orgMembers = members.get(orgId);
      if (!orgMembers?.has(accountId)) return { ok: false, reason: 'not_found' as const };
      const m = orgMembers.get(accountId);
      if (m.role === 'owner') {
        const ownerCount = [...orgMembers.values()].filter((x) => x.role === 'owner').length;
        if (ownerCount <= 1) return { ok: false, reason: 'last_owner' as const };
      }
      orgMembers.delete(accountId);
      return { ok: true };
    },
    updateOrgMemberRole: async (orgId, accountId, newRole) => {
      const orgMembers = members.get(orgId);
      const m = orgMembers?.get(accountId);
      if (!m) return { ok: false, reason: 'not_found' as const };
      if (m.role === 'owner' && newRole !== 'owner') {
        const ownerCount = [...orgMembers!.values()].filter((x) => x.role === 'owner').length;
        if (ownerCount <= 1) return { ok: false, reason: 'last_owner' as const };
      }
      m.role = newRole;
      return { ok: true };
    },
    getOrgMembership: async (orgId, accountId) => {
      const m = members.get(orgId)?.get(accountId);
      return m ? { role: m.role } : null;
    },
    createOrgInvitation: async (input) => {
      const id = newId();
      const inv = {
        id,
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        invitedBy: input.invitedBy,
        tokenHash: `hash-${id}`,
        expiresAt: new Date(Date.now() + input.ttlHours * 3600000).toISOString(),
        acceptedAt: null,
        createdAt: new Date().toISOString(),
      };
      invitations.set(id, inv);
      return { invitation: inv, token: `tok-${id}` };
    },
    findInvitationByTokenHash: async (hash) =>
      [...invitations.values()].find((i) => i.tokenHash === hash) ?? null,
    listPendingInvitationsForOrg: async (orgId) =>
      [...invitations.values()].filter((i) => i.organizationId === orgId && !i.acceptedAt),
    listPendingInvitationsForEmail: async (email) =>
      [...invitations.values()].filter((i) => i.email === email && !i.acceptedAt),
    acceptInvitation: async (invitationId) => {
      const inv = invitations.get(invitationId);
      if (!inv) return { ok: false, reason: 'not_found' as const };
      inv.acceptedAt = new Date().toISOString();
      return { ok: true };
    },
    revokeInvitation: async (organizationId, invitationId) => {
      const inv = invitations.get(invitationId);
      if (!inv || inv.organizationId !== organizationId) return false;
      invitations.delete(invitationId);
      return true;
    },
    removeAccountFromAllOrgs: async (accountId) => {
      let memberships = 0;
      for (const orgMembers of members.values()) {
        if (orgMembers.has(accountId)) {
          orgMembers.delete(accountId);
          memberships++;
        }
      }
      return { memberships, invitations: 0 };
    },
  };
}

function buildCfg() {
  return {
    // Origem dos links emailados (convite de org) — plan 004: vem do issuer, não
    // de `request.host()`.
    issuer: 'http://localhost',
    accountStore: buildMemoryStore(),
    organizations: {
      roles: ['owner', 'admin', 'member'],
      allowSelfCreate: true,
      invitationTtlHours: 72,
    },
    audit: {
      events: [] as any[],
      record: async (e: any) => {
        cfg.audit.events.push(e);
      },
    },
    mail: {
      onOrgInvitation: async (data: any) => {
        mailCalls.push(data);
      },
    },
  } as any;
}

let cfg: any;
let mailCalls: any[];

// ─── Fake HttpContext ─────────────────────────────────────────────────────────

function fakeCtx(
  opts: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  } = {},
) {
  let status = 200;
  let responseBody: any;
  const captured = { status: () => status, body: () => responseBody };
  const setBody = (b: any) => {
    responseBody = b;
    return b;
  };
  const err = (code: number) => (payload?: any) => {
    status = code;
    return setBody(payload);
  };

  const ctx = {
    request: {
      body: () => opts.body ?? {},
      input: (k: string, def?: unknown) => opts.body?.[k] ?? def,
      param: (k: string) => opts.params?.[k],
      ip: () => '127.0.0.1',
      protocol: () => 'https',
      host: () => 'localhost:3333',
      // Vine compiled validators expõem `.validate(data)`; valida o body.
      validateUsing: async (validator: {
        validate: (data: unknown, options: { meta: object }) => Promise<unknown>;
      }) => validator.validate(opts.body ?? {}, { meta: {} }),
    },
    response: {
      created: (b: any) => {
        status = 201;
        return setBody(b);
      },
      notFound: err(404),
      badRequest: err(400),
      unprocessableEntity: err(422),
      conflict: err(409),
    },
    containerResolver: { make: async () => ({ config: cfg }) },
    session: { get: () => 'console-actor' },
  } as any;

  return { ctx, captured };
}

// ─── Seed helper ─────────────────────────────────────────────────────────────

async function seedOrg() {
  const svc = new AdminOrgsService(cfg);
  const actor = { actorId: null, ip: null, source: 'admin' as const };
  return svc.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' }, actor) as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.group('ConsoleOrgsController', (group) => {
  group.each.setup(() => {
    cfg = buildCfg();
    mailCalls = [];
  });

  // ── GET index ──────────────────────────────────────────────────────────────

  test('GET /api/orgs lista orgs com contagem de membros', async ({ assert }) => {
    await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.index(fakeCtx().ctx);
    assert.isArray(res.data);
    assert.lengthOf(res.data, 1);
    assert.equal(res.data[0].name, 'Acme');
    assert.equal(res.data[0].slug, 'acme');
  });

  test('GET /api/orgs retorna 404 capability_unsupported quando store não suporta', async ({
    assert,
  }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx();
    await ctrl.index(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── POST store ─────────────────────────────────────────────────────────────

  test('POST /api/orgs cria org (201) com name+slug+ownerAccountId', async ({ assert }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ body: { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' } });
    const res: any = await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.equal(res.name, 'Acme');
    assert.equal(res.slug, 'acme');
  });

  test('POST /api/orgs sem fields obrigatórios → rejeitado pela validação (Vine, 422)', async ({
    assert,
  }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ body: { name: 'No Slug' } });
    // slug/ownerAccountId ausentes → Vine lança (→ 422 pelo handler do AdonisJS).
    await assert.rejects(() => ctrl.store(c.ctx));
  });

  test('POST /api/orgs slug duplicado → 422 slug_taken', async ({ assert }) => {
    await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ body: { name: 'Acme2', slug: 'acme', ownerAccountId: 'owner-1' } });
    await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 422);
    assert.equal(c.captured.body()?.error?.code, 'slug_taken');
  });

  test('POST /api/orgs 404 capability_unsupported sem store', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ body: { name: 'X', slug: 'x', ownerAccountId: 'o' } });
    await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── GET show ───────────────────────────────────────────────────────────────

  test('GET /api/orgs/:id retorna detalhe com membros e convites', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.show(fakeCtx({ params: { id: org.id } }).ctx);
    assert.equal(res.name, 'Acme');
    assert.isArray(res.members);
    assert.isArray(res.pendingInvitations);
    assert.isTrue(res.members.some((m: any) => m.accountId === 'owner-1'));
  });

  test('GET /api/orgs/:id inexistente → 404 not_found', async ({ assert }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'nope' } });
    await ctrl.show(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'not_found');
  });

  // ── PATCH update ───────────────────────────────────────────────────────────

  test('PATCH /api/orgs/:id atualiza nome', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.update(
      fakeCtx({ params: { id: org.id }, body: { name: 'New Name' } }).ctx,
    );
    assert.equal(res.name, 'New Name');
  });

  test('PATCH /api/orgs/:id inexistente → 404', async ({ assert }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'ghost' }, body: { name: 'X' } });
    await ctrl.update(c.ctx);
    assert.equal(c.captured.status(), 404);
  });

  // ── DELETE destroy ─────────────────────────────────────────────────────────

  test('DELETE /api/orgs/:id deleta org', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.destroy(fakeCtx({ params: { id: org.id } }).ctx);
    assert.isTrue(res.deleted);
  });

  test('DELETE /api/orgs/:id inexistente → 404', async ({ assert }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'ghost' } });
    await ctrl.destroy(c.ctx);
    assert.equal(c.captured.status(), 404);
  });

  // ── POST addMember ─────────────────────────────────────────────────────────

  test('POST /api/orgs/:id/members adiciona membro', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.addMember(
      fakeCtx({ params: { id: org.id }, body: { accountId: 'user-2', role: 'member' } }).ctx,
    );
    assert.isTrue(res.ok);
  });

  test('POST /api/orgs/:id/members sem accountId → rejeitado pela validação (Vine, 422)', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id }, body: { role: 'member' } });
    await assert.rejects(() => ctrl.addMember(c.ctx));
  });

  test('POST /api/orgs/:id/members conta inexistente → 404 account_not_found', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({
      params: { id: org.id },
      body: { accountId: 'no-account', role: 'member' },
    });
    await ctrl.addMember(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'account_not_found');
  });

  test('POST /api/orgs/:id/members 404 capability_unsupported', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'x' }, body: { accountId: 'user-2', role: 'member' } });
    await ctrl.addMember(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── DELETE removeMember ────────────────────────────────────────────────────

  test('DELETE /api/orgs/:id/members/:accountId remove membro', async ({ assert }) => {
    const org = await seedOrg();
    const svc = new AdminOrgsService(cfg);
    await svc.addMember(
      org.id,
      { accountId: 'user-2', role: 'member' },
      { actorId: null, ip: null },
    );
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.removeMember(
      fakeCtx({ params: { id: org.id, accountId: 'user-2' } }).ctx,
    );
    assert.isTrue(res.ok);
  });

  test('DELETE /api/orgs/:id/members/:accountId último owner → 422 last_owner', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id, accountId: 'owner-1' } });
    await ctrl.removeMember(c.ctx);
    assert.equal(c.captured.status(), 422);
    assert.equal(c.captured.body()?.error?.code, 'last_owner');
  });

  test('DELETE /api/orgs/:id/members/:accountId 404 capability_unsupported', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'x', accountId: 'user-2' } });
    await ctrl.removeMember(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── PATCH updateMemberRole ─────────────────────────────────────────────────

  test('PATCH /api/orgs/:id/members/:accountId troca role', async ({ assert }) => {
    const org = await seedOrg();
    const svc = new AdminOrgsService(cfg);
    await svc.addMember(
      org.id,
      { accountId: 'user-2', role: 'member' },
      { actorId: null, ip: null },
    );
    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.updateMemberRole(
      fakeCtx({ params: { id: org.id, accountId: 'user-2' }, body: { role: 'admin' } }).ctx,
    );
    assert.isTrue(res.ok);
  });

  test('PATCH /api/orgs/:id/members/:accountId sem role → rejeitado pela validação (Vine, 422)', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id, accountId: 'owner-1' }, body: {} });
    await assert.rejects(() => ctrl.updateMemberRole(c.ctx));
  });

  test('PATCH /api/orgs/:id/members/:accountId 404 capability_unsupported', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'x', accountId: 'user-2' }, body: { role: 'admin' } });
    await ctrl.updateMemberRole(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── POST createInvitation ──────────────────────────────────────────────────

  test('POST /api/orgs/:id/invitations cria convite (201)', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id }, body: { email: 'invited@x.com', role: 'member' } });
    const res: any = await ctrl.createInvitation(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.isTrue(res.ok);
    assert.equal(res.invitation.email, 'invited@x.com');
  });

  test('POST /api/orgs/:id/invitations sem email → rejeitado pela validação (Vine, 422)', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id }, body: { role: 'member' } });
    await assert.rejects(() => ctrl.createInvitation(c.ctx));
  });

  test('POST /api/orgs/:id/invitations org inexistente → 404', async ({ assert }) => {
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'ghost' }, body: { email: 'x@x.com', role: 'member' } });
    await ctrl.createInvitation(c.ctx);
    assert.equal(c.captured.status(), 404);
  });

  test('POST /api/orgs/:id/invitations 404 capability_unsupported', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'x' }, body: { email: 'x@x.com', role: 'member' } });
    await ctrl.createInvitation(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── DELETE revokeInvitation ────────────────────────────────────────────────

  test('DELETE /api/orgs/:id/invitations/:invitationId revoga convite', async ({ assert }) => {
    const org = await seedOrg();
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null };
    const inv = (await svc.createInvitation(
      org.id,
      { email: 'x@x.com', role: 'member' },
      actor,
      'http://localhost',
    )) as any;

    const ctrl = new ConsoleOrgsController();
    const res: any = await ctrl.revokeInvitation(
      fakeCtx({ params: { id: org.id, invitationId: inv.invitation.id } }).ctx,
    );
    assert.isTrue(res.ok);
  });

  test('DELETE /api/orgs/:id/invitations/:invitationId convite inexistente → 404', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: org.id, invitationId: 'ghost-inv' } });
    await ctrl.revokeInvitation(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'invitation_not_found');
  });

  test('DELETE /api/orgs/:id/invitations/:invitationId 404 capability_unsupported', async ({
    assert,
  }) => {
    cfg = {
      ...cfg,
      accountStore: { ...cfg.accountStore, createOrg: undefined, findOrgById: undefined },
    };
    const ctrl = new ConsoleOrgsController();
    const c = fakeCtx({ params: { id: 'x', invitationId: 'y' } });
    await ctrl.revokeInvitation(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(c.captured.body()?.error?.code, 'capability_unsupported');
  });

  // ── Anti-shadowing: rotas write ANTES do catch-all ─────────────────────────
  // Verifica que as constantes de rota no register_auth_host são registradas
  // antes do `${ap}/*` (shell HTML), para que POST/PATCH/DELETE não sejam
  // engolidos pelo catch-all.

  test('anti-shadowing: rotas /api/orgs/* são registradas antes do catch-all', async ({
    assert,
  }) => {
    // Lê o arquivo de registro como texto e verifica a ordem de declaração.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '../../src/host/register_auth_host.ts'), 'utf8');

    const idxStore = src.indexOf("consoleOrgs, 'store'");
    // Regex (não indexOf) porque o formatter pode quebrar essa call em
    // múltiplas linhas quando o argumento não cabe no lineWidth — o
    // `consoleOrgs,` e o `'revokeInvitation'` deixam de ser contíguos.
    const invitationsMatch = src.match(/consoleOrgs,\s*\n?\s*'revokeInvitation'/);
    const idxInvitations = invitationsMatch?.index ?? -1;
    const idxCatchAll = src.indexOf('authkit_console_shell');

    // Todos os endpoints de orgs existem no arquivo.
    assert.isAbove(idxStore, 0, "rota 'store' não encontrada");
    assert.isAbove(idxInvitations, 0, "rota 'revokeInvitation' não encontrada");
    assert.isAbove(idxCatchAll, 0, 'catch-all authkit_console_shell não encontrado');

    // As rotas de orgs aparecem ANTES do catch-all.
    assert.isBelow(idxStore, idxCatchAll, "rota 'store' deve estar antes do catch-all");
    assert.isBelow(
      idxInvitations,
      idxCatchAll,
      "rota 'revokeInvitation' deve estar antes do catch-all",
    );
  });
});
