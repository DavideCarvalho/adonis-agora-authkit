/**
 * Testes do AdminOrgsService + ApiOrgsController (surface admin das orgs).
 * Usa store em memória para isolar das tabelas Lucid.
 */
import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import { AdminOrgsService } from '../../src/host/admin_api/admin_orgs_service.js';
import ApiOrgsController from '../../src/host/admin_api/api_orgs_controller.js';
import { apiError } from '../../src/host/admin_api/dto.js';

// ─── Store em memória com capability de Organizations ─────────────────────
function buildMemoryStoreWithOrgs(): AccountStore {
  const accounts = new Map<string, any>();
  accounts.set('owner-1', {
    id: 'owner-1',
    email: 'owner@acme.com',
    name: 'Owner',
    globalRoles: [],
  });
  accounts.set('user-2', { id: 'user-2', email: 'user@acme.com', name: 'User', globalRoles: [] });

  const orgs = new Map<string, any>();
  const members = new Map<string, Map<string, any>>(); // orgId → accountId → {role, createdAt}
  const invitations = new Map<string, any>();

  let idCounter = 0;
  const newId = () => `id-${++idCounter}`;

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

    // OrganizationsCapability
    createOrg: async (input) => {
      const org = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        logoUrl: input.logoUrl ?? null,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      if ([...orgs.values()].some((o) => o.slug === input.slug)) throw new Error('slug_taken');
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
    acceptInvitation: async (invitationId, accountId) => {
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

function buildCfg(extra: Partial<any> = {}) {
  const mailInvitations: any[] = [];
  return {
    cfg: {
      // Origem dos links emailados (convite de org) — plan 004: vem do issuer, não
      // de `request.host()`.
      issuer: 'http://localhost',
      accountStore: buildMemoryStoreWithOrgs(),
      organizations: {
        roles: ['owner', 'admin', 'member'],
        allowSelfCreate: true,
        invitationTtlHours: 72,
      },
      audit: {
        events: [] as any[],
        record: async (e: any) => {
          (cfg as any).audit.events.push(e);
        },
      },
      mail: {
        onOrgInvitation: async (data: any) => {
          mailInvitations.push(data);
        },
      },
      ...extra,
    } as any,
    mailInvitations,
  };
}

let cfg: any;
let mailInvitations: any[];

// ─── fake HttpContext ─────────────────────────────────────────────────────
function fakeCtx(opts: { inputs?: Record<string, unknown>; params?: Record<string, string> } = {}) {
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
      unprocessableEntity: err(422),
    },
    containerResolver: { make: async () => ({ config: cfg }) },
    session: { get: () => 'admin-actor' },
  } as any;
  return { ctx, captured };
}

test.group('AdminOrgsService', (group) => {
  group.each.setup(() => {
    const built = buildCfg();
    cfg = built.cfg;
    mailInvitations = built.mailInvitations;
  });

  test('listOrgs retorna lista vazia quando sem orgs', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const result = await svc.listOrgs();
    assert.isArray(result);
    assert.deepEqual(result, []);
  });

  test('createOrg + listOrgs retorna a org criada', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: 'admin-1', ip: '127.0.0.1', source: 'admin-api' as const };
    const result = await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    );
    assert.notProperty(result, 'ok');
    const org = result as any;
    assert.equal(org.name, 'Acme');
    assert.equal(org.slug, 'acme');

    const list = await svc.listOrgs();
    assert.isArray(list);
    assert.lengthOf(list as any[], 1);
    assert.equal((list as any[])[0].memberCount, 1);
  });

  test('createOrg audita organization.created', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    await svc.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' }, actor);
    const ev = cfg.audit.events.find((e: any) => e.type === 'organization.created');
    assert.isNotNull(ev);
  });

  test('createOrg retorna slug_taken quando slug duplicado', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    await svc.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' }, actor);
    const result = await svc.createOrg(
      { name: 'Acme2', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    );
    assert.deepEqual(result as any, { ok: false, reason: 'slug_taken' });
  });

  test('getOrg retorna detalhe com membros e convites', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const created = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const detail = (await svc.getOrg(created.id)) as any;
    assert.equal(detail.name, 'Acme');
    assert.isArray(detail.members);
    assert.isArray(detail.pendingInvitations);
    assert.isTrue(detail.members.some((m: any) => m.accountId === 'owner-1'));
  });

  test('getOrg retorna not_found para id inexistente', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const result = await svc.getOrg('nope');
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  test('addMember + removeMember funcionam', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;

    const addResult = await svc.addMember(org.id, { accountId: 'user-2', role: 'member' }, actor);
    assert.deepEqual(addResult, { ok: true });

    const detail = (await svc.getOrg(org.id)) as any;
    assert.isTrue(detail.members.some((m: any) => m.accountId === 'user-2'));

    const removeResult = await svc.removeMember(org.id, 'user-2', actor);
    assert.deepEqual(removeResult, { ok: true });
  });

  test('addMember rejeita role fora do catálogo (invalid_role) — H4', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;

    const result = await svc.addMember(org.id, { accountId: 'user-2', role: 'superadmin' }, actor);
    assert.deepEqual(result, { ok: false, reason: 'invalid_role' });

    // Conta não virou membro.
    const detail = (await svc.getOrg(org.id)) as any;
    assert.isFalse(detail.members.some((m: any) => m.accountId === 'user-2'));
  });

  test('addMember aceita role do catálogo (member) — H4', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const result = await svc.addMember(org.id, { accountId: 'user-2', role: 'member' }, actor);
    assert.deepEqual(result, { ok: true });
  });

  test('updateMemberRole rejeita role fora do catálogo (invalid_role) — H4', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    await svc.addMember(org.id, { accountId: 'user-2', role: 'member' }, actor);
    const result = await svc.updateMemberRole(org.id, 'user-2', 'hacker', actor);
    assert.deepEqual(result, { ok: false, reason: 'invalid_role' });
  });

  test('updateMemberRole permite promover a owner no Admin API global (super-admin) — H4', async ({
    assert,
  }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    await svc.addMember(org.id, { accountId: 'user-2', role: 'member' }, actor);
    // owner está no catálogo → Admin API global pode promover a owner.
    const result = await svc.updateMemberRole(org.id, 'user-2', 'owner', actor);
    assert.deepEqual(result, { ok: true });
  });

  test('createInvitation rejeita role fora do catálogo (invalid_role) — H4', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const result = await svc.createInvitation(
      org.id,
      { email: 'x@x.com', role: 'root' },
      actor,
      'http://localhost',
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_role' });
  });

  test('removeMember bloqueia remoção do último owner', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;

    const result = await svc.removeMember(org.id, 'owner-1', actor);
    assert.deepEqual(result, { ok: false, reason: 'last_owner' });
  });

  test('createInvitation dispara mail hook', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;

    const result = await svc.createInvitation(
      org.id,
      { email: 'invited@x.com', role: 'member' },
      actor,
      'http://localhost',
    );
    assert.isTrue((result as any).ok);
    assert.isString((result as any).token);

    assert.lengthOf(mailInvitations, 1);
    assert.equal(mailInvitations[0].email, 'invited@x.com');
    assert.equal(mailInvitations[0].orgName, 'Acme');
  });

  test('revokeInvitation remove o convite', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const inv = (await svc.createInvitation(
      org.id,
      { email: 'x@x.com', role: 'member' },
      actor,
      'http://localhost',
    )) as any;

    const revoke = await svc.revokeInvitation(org.id, inv.invitation.id, actor);
    assert.deepEqual(revoke, { ok: true });

    const detail = (await svc.getOrg(org.id)) as any;
    assert.lengthOf(detail.pendingInvitations, 0);
  });

  test('revokeInvitation é escopado por org: convite de outra org → invitation_not_found (IDOR)', async ({
    assert,
  }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const orgA = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const orgB = (await svc.createOrg(
      { name: 'Beta', slug: 'beta', ownerAccountId: 'owner-1' },
      actor,
    )) as any;
    const invB = (await svc.createInvitation(
      orgB.id,
      { email: 'v@x.com', role: 'member' },
      actor,
      'http://localhost',
    )) as any;

    // Tenta revogar o convite da org B passando o orgId da org A.
    const revoke = await svc.revokeInvitation(orgA.id, invB.invitation.id, actor);
    assert.deepEqual(revoke, { ok: false, reason: 'invitation_not_found' });

    // Convite da org B continua pendente.
    const detailB = (await svc.getOrg(orgB.id)) as any;
    assert.lengthOf(detailB.pendingInvitations, 1);
  });

  test('deleteOrg remove org + audita', async ({ assert }) => {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    const org = (await svc.createOrg(
      { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' },
      actor,
    )) as any;

    const result = await svc.deleteOrg(org.id, actor);
    assert.deepEqual(result, { ok: true });

    const check = await svc.getOrg(org.id);
    assert.deepEqual(check, { ok: false, reason: 'not_found' });

    const ev = cfg.audit.events.find((e: any) => e.type === 'organization.deleted');
    assert.isNotNull(ev);
  });

  test('not_supported quando store não tem createOrg', async ({ assert }) => {
    const minimalCfg = {
      ...cfg,
      accountStore: {
        findById: async () => null,
        findByEmail: async () => null,
        verifyCredentials: async () => null,
        create: async () => ({ id: 'x', email: 'x@x.com', globalRoles: [] }),
        issuePasswordResetToken: async () => null,
        consumePasswordResetToken: async () => false,
        issueEmailVerificationToken: async () => null,
        consumeEmailVerificationToken: async () => false,
        listAccounts: async () => ({ data: [], total: 0 }),
        setGlobalRoles: async () => {},
      },
    };
    const svc = new AdminOrgsService(minimalCfg);
    assert.isFalse(svc.supported);
    const result = await svc.listOrgs();
    assert.deepEqual(result, { ok: false, reason: 'not_supported' });
  });
});

test.group('ApiOrgsController', (group) => {
  group.each.setup(() => {
    const built = buildCfg();
    cfg = built.cfg;
    mailInvitations = built.mailInvitations;
  });

  async function seedOrg() {
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null, source: 'admin-api' as const };
    return svc.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' }, actor) as any;
  }

  test('GET /organizations lista orgs', async ({ assert }) => {
    await seedOrg();
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.index(fakeCtx().ctx);
    assert.isArray(res.data);
    assert.lengthOf(res.data, 1);
    assert.equal(res.data[0].name, 'Acme');
  });

  test('POST /organizations cria org (201)', async ({ assert }) => {
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ inputs: { name: 'Acme', slug: 'acme', ownerAccountId: 'owner-1' } });
    const res: any = await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.equal(res.name, 'Acme');
    assert.equal(res.slug, 'acme');
  });

  test('POST /organizations slug duplicado → 409', async ({ assert }) => {
    await seedOrg();
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ inputs: { name: 'Acme2', slug: 'acme', ownerAccountId: 'owner-1' } });
    const res: any = await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 409);
    assert.equal(res.error.code, 'slug_taken');
  });

  test('GET /organizations/:id retorna detalhe com membros', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.show(fakeCtx({ params: { id: org.id } }).ctx);
    assert.equal(res.name, 'Acme');
    assert.isArray(res.members);
    assert.isArray(res.pendingInvitations);
  });

  test('GET /organizations/:id inexistente → 404', async ({ assert }) => {
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ params: { id: 'nope' } });
    const res: any = await ctrl.show(c.ctx);
    assert.equal(c.captured.status(), 404);
  });

  test('PATCH /organizations/:id atualiza nome', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.update(
      fakeCtx({ params: { id: org.id }, inputs: { name: 'New Name' } }).ctx,
    );
    assert.equal(res.name, 'New Name');
  });

  test('DELETE /organizations/:id deleta org', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.destroy(fakeCtx({ params: { id: org.id } }).ctx);
    assert.isTrue(res.deleted);
  });

  test('POST /organizations/:id/members adiciona membro (201)', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ params: { id: org.id }, inputs: { accountId: 'user-2', role: 'member' } });
    const res: any = await ctrl.addMember(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.isTrue(res.added);
  });

  test('DELETE /organizations/:id/members/:accountId remove membro', async ({ assert }) => {
    const org = await seedOrg();
    await new AdminOrgsService(cfg).addMember(
      org.id,
      { accountId: 'user-2', role: 'member' },
      { actorId: null, ip: null },
    );
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.removeMember(
      fakeCtx({ params: { id: org.id, accountId: 'user-2' } }).ctx,
    );
    assert.isTrue(res.removed);
  });

  test('DELETE /organizations/:id/members/:accountId último owner → 409', async ({ assert }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ params: { id: org.id, accountId: 'owner-1' } });
    const res: any = await ctrl.removeMember(c.ctx);
    assert.equal(c.captured.status(), 409);
    assert.equal(res.error.code, 'last_owner');
  });

  test('PATCH /organizations/:id/members/:accountId troca role', async ({ assert }) => {
    const org = await seedOrg();
    await new AdminOrgsService(cfg).addMember(
      org.id,
      { accountId: 'user-2', role: 'member' },
      { actorId: null, ip: null },
    );
    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.updateMemberRole(
      fakeCtx({ params: { id: org.id, accountId: 'user-2' }, inputs: { role: 'admin' } }).ctx,
    );
    assert.equal(res.role, 'admin');
  });

  test('POST /organizations/:id/invitations cria convite (201) + dispara mail', async ({
    assert,
  }) => {
    const org = await seedOrg();
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({
      params: { id: org.id },
      inputs: { email: 'invited@x.com', role: 'member' },
    });
    const res: any = await ctrl.createInvitation(c.ctx);
    assert.equal(c.captured.status(), 201);
    assert.equal(res.email, 'invited@x.com');
    assert.lengthOf(mailInvitations, 1);
  });

  test('DELETE /organizations/:id/invitations/:invitationId revoga convite', async ({ assert }) => {
    const org = await seedOrg();
    const svc = new AdminOrgsService(cfg);
    const actor = { actorId: null, ip: null };
    const inv = (await svc.createInvitation(
      org.id,
      { email: 'x@x.com', role: 'member' },
      actor,
      'http://localhost',
    )) as any;

    const ctrl = new ApiOrgsController();
    const res: any = await ctrl.revokeInvitation(
      fakeCtx({ params: { id: org.id, invitationId: inv.invitation.id } }).ctx,
    );
    assert.isTrue(res.revoked);
  });

  test('404 quando organizations não suportado', async ({ assert }) => {
    cfg = {
      ...cfg,
      accountStore: {
        ...cfg.accountStore,
        createOrg: undefined,
        findOrgById: undefined,
        listOrgMembers: undefined,
      },
    };
    const ctrl = new ApiOrgsController();
    const c = fakeCtx({ inputs: { name: 'X', slug: 'x', ownerAccountId: 'o' } });
    const res: any = await ctrl.store(c.ctx);
    assert.equal(c.captured.status(), 404);
    assert.equal(res.error.code, 'capability_unsupported');
  });
});
