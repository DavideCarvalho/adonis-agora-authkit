/**
 * Default mailer fallback for organization invitations.
 *
 * `mail.onOrgInvitation` used to be the only mail hook with NO default-mailer
 * fallback: without the hook the invitation row was created and no email was
 * ever sent. These tests pin the restored behaviour on BOTH call sites (the
 * account-facing controller and the admin service): host hook when present,
 * library default otherwise, always best-effort.
 */
import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import { AdminOrgsService } from '../../src/host/admin_api/admin_orgs_service.js';
import AccountOrgsController from '../../src/host/controllers/account_orgs_controller.js';
import { __setMailLoaderForTests } from '../../src/host/default_mailer.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';

// ─── in-memory store with the Organizations capability ──────────────────────
function buildStore(): AccountStore & Record<string, any> {
  const accounts = new Map<string, any>();
  const orgs = new Map<string, any>();
  const members = new Map<string, Map<string, any>>();
  const invitations = new Map<string, any>();
  let counter = 0;
  const newId = () => `id-${++counter}`;

  const store: any = {
    findById: async (id: string) => accounts.get(id) ?? null,
    findByEmail: async (email: string) =>
      [...accounts.values()].find((a) => a.email === email) ?? null,
    verifyCredentials: async () => null,
    create: async (input: any) => {
      const acc = { id: newId(), email: input.email, name: null, globalRoles: [] };
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
      const org = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        logoUrl: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      orgs.set(org.id, org);
      const m = new Map<string, any>();
      m.set(input.ownerAccountId, { role: 'owner', createdAt: new Date().toISOString() });
      members.set(org.id, m);
      return org;
    },
    findOrgById: async (orgId: string) => orgs.get(orgId) ?? null,
    findOrgBySlug: async () => null,
    listOrgsForAccount: async () => [],
    updateOrg: async () => null,
    deleteOrg: async () => false,
    listOrgMembers: async (orgId: string) => {
      const m = members.get(orgId);
      if (!m) return [];
      return [...m.entries()].map(([accountId, v]) => ({
        accountId,
        email: null,
        role: v.role,
        joinedAt: '',
      }));
    },
    addOrgMember: async (orgId: string, accountId: string, role: string) => {
      if (!members.has(orgId)) members.set(orgId, new Map());
      members.get(orgId)!.set(accountId, { role });
    },
    removeOrgMember: async () => ({ ok: true }),
    updateOrgMemberRole: async () => ({ ok: true }),
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
    revokeInvitation: async () => false,
    removeAccountFromAllOrgs: async () => ({ memberships: 0, invitations: 0 }),
  };
  return store;
}

function buildCfg(store: AccountStore, mail: any = {}) {
  return {
    issuer: 'https://auth.example.com',
    accountStore: store,
    organizations: {
      roles: ['owner', 'admin', 'member'],
      allowSelfCreate: true,
      invitationTtlHours: 72,
    },
    audit: { record: async () => {} },
    mail,
  } as any;
}

/** Captures every message handed to `@adonisjs/mail`. */
function captureMailStub(sent: any[]) {
  return {
    send: async (cb: any) => {
      const message: any = {
        from(v: any) {
          this._from = v;
          return this;
        },
        to(v: any) {
          this._to = v;
          return this;
        },
        subject(v: any) {
          this._subject = v;
          return this;
        },
        html(v: any) {
          this._html = v;
          return this;
        },
        text(v: any) {
          this._text = v;
          return this;
        },
      };
      cb(message);
      sent.push(message);
    },
  };
}

/** Mailer that always blows up (SMTP down). */
const explodingMailStub = {
  send: async () => {
    throw new Error('smtp down');
  },
};

function fakeCtx(opts: {
  actorId: string;
  cfg: any;
  params?: Record<string, string>;
  inputs?: Record<string, string>;
}) {
  let status = 200;
  let redirected: string | null = null;
  const captured = { status: () => status, redirected: () => redirected };
  const err = (code: number) => () => {
    status = code;
    return null;
  };
  const ctx: any = {
    logger: { info: () => {}, error: () => {} },
    request: {
      input: (k: string, def?: string) => opts.inputs?.[k] ?? def,
      param: (k: string) => opts.params?.[k],
      ip: () => '127.0.0.1',
      protocol: () => 'https',
      host: () => 'localhost',
    },
    params: opts.params ?? {},
    response: {
      forbidden: err(403),
      notFound: err(404),
      unprocessableEntity: err(422),
      redirect: (url: string) => {
        redirected = url;
        return null;
      },
    },
    session: { get: (k: string) => (k === ACCOUNT_SESSION_KEY ? opts.actorId : undefined) },
    containerResolver: {
      // make('lucid.db') rejects → runtime settings fall back to the config catalog.
      make: async (name: string) => {
        if (name === 'authkit.server') return { config: opts.cfg };
        throw new Error(`unknown binding: ${name}`);
      },
      app: { config: { get: () => undefined } },
    },
  };
  return { ctx, captured };
}

const ADMIN_ACTOR = { actorId: 'admin-1', ip: '127.0.0.1', source: 'admin-api' as const };

test.group('org invitation email — default mailer fallback', (group) => {
  group.each.teardown(() => {
    __setMailLoaderForTests(undefined);
  });

  // ── account-facing controller (POST /account/orgs/:id/invite) ─────────────

  test('controller: com hook do host, o hook é chamado e o mailer default NÃO é usado', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    const hookCalls: any[] = [];
    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store, {
      onOrgInvitation: async (data: any) => {
        hookCalls.push(data);
      },
    });
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      cfg,
      params: { id: org.id },
      inputs: { email: 'invited@x.com', role: 'member' },
    });
    await new AccountOrgsController().invite(ctx);

    assert.equal(captured.redirected(), '/account/orgs');
    assert.lengthOf(hookCalls, 1);
    assert.equal(hookCalls[0].email, 'invited@x.com');
    assert.lengthOf(sent, 0);
  });

  test('controller: sem hook, o mailer default envia com org, role e accept URL', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store);
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      cfg,
      params: { id: org.id },
      inputs: { email: 'invited@x.com', role: 'admin' },
    });
    await new AccountOrgsController().invite(ctx);

    assert.equal(captured.redirected(), '/account/orgs');
    assert.lengthOf(sent, 1);
    const pending = await store.listPendingInvitationsForOrg(org.id);
    const acceptUrl = `https://auth.example.com/account/orgs/invitations/tok-${pending[0].id}/accept`;
    assert.equal(sent[0]._to, 'invited@x.com');
    assert.include(sent[0]._subject, 'Acme');
    assert.include(sent[0]._text, 'Acme');
    assert.include(sent[0]._text, 'admin');
    assert.include(sent[0]._text, acceptUrl);
    assert.include(sent[0]._html, acceptUrl);
  });

  test('controller: mailer default estourando não quebra a criação do convite', async ({
    assert,
  }) => {
    __setMailLoaderForTests(() => Promise.resolve(explodingMailStub));

    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store);
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });

    const { ctx, captured } = fakeCtx({
      actorId: owner.id,
      cfg,
      params: { id: org.id },
      inputs: { email: 'invited@x.com', role: 'member' },
    });
    await new AccountOrgsController().invite(ctx);

    assert.equal(captured.redirected(), '/account/orgs');
    const pending = await store.listPendingInvitationsForOrg(org.id);
    assert.lengthOf(pending, 1);
    assert.equal(pending[0].email, 'invited@x.com');
  });

  // ── admin service (AdminOrgsService.createInvitation) ─────────────────────

  test('admin service: com hook do host, o hook é chamado e o mailer default NÃO é usado', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    const hookCalls: any[] = [];
    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store, {
      onOrgInvitation: async (data: any) => {
        hookCalls.push(data);
      },
    });
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });
    const { ctx } = fakeCtx({ actorId: owner.id, cfg });

    const result = await new AdminOrgsService(cfg).createInvitation(
      org.id,
      { email: 'invited@x.com', role: 'member' },
      ADMIN_ACTOR,
      'https://auth.example.com',
      null,
      ctx,
    );

    assert.isTrue((result as any).ok);
    assert.lengthOf(hookCalls, 1);
    assert.lengthOf(sent, 0);
  });

  test('admin service: sem hook, o mailer default envia com org, role e accept URL', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store);
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });
    const { ctx } = fakeCtx({ actorId: owner.id, cfg });

    const result: any = await new AdminOrgsService(cfg).createInvitation(
      org.id,
      { email: 'invited@x.com', role: 'admin' },
      ADMIN_ACTOR,
      'https://auth.example.com',
      null,
      ctx,
    );

    assert.isTrue(result.ok);
    assert.lengthOf(sent, 1);
    const acceptUrl = `https://auth.example.com/account/orgs/invitations/${result.token}/accept`;
    assert.equal(sent[0]._to, 'invited@x.com');
    assert.include(sent[0]._subject, 'Acme');
    assert.include(sent[0]._text, 'Acme');
    assert.include(sent[0]._text, 'admin');
    assert.include(sent[0]._text, acceptUrl);
    assert.include(sent[0]._html, acceptUrl);
  });

  test('admin service: mailer default estourando não quebra a criação do convite', async ({
    assert,
  }) => {
    __setMailLoaderForTests(() => Promise.resolve(explodingMailStub));

    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store);
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });
    const { ctx } = fakeCtx({ actorId: owner.id, cfg });

    const result: any = await new AdminOrgsService(cfg).createInvitation(
      org.id,
      { email: 'invited@x.com', role: 'member' },
      ADMIN_ACTOR,
      'https://auth.example.com',
      null,
      ctx,
    );

    assert.isTrue(result.ok);
    const pending = await store.listPendingInvitationsForOrg(org.id);
    assert.lengthOf(pending, 1);
    assert.equal(pending[0].email, 'invited@x.com');
  });
  // ── the out-of-band context the SDK's embedded driver builds ──────────────
  //
  // The embedded driver has no request, so it hands the service a hand-built
  // context carrying only `containerResolver.app` and a logger. That is exactly
  // what the default mailer reads (host config for sender/branding/locale). If
  // the fallback quietly needed more than that, an SDK-created invitation would
  // land in the database and in no inbox — the same silent failure on a
  // different door.
  test('admin service: um ctx mínimo out-of-band (SDK embedded) ainda envia o e-mail', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    // `any`: the Organizations capability is optional on `AccountStore`.
    const store: any = buildStore();
    const cfg = buildCfg(store);
    const owner = await store.create({ email: 'owner@x.com' });
    const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });

    // No `request`, no `session`, no `response` — only what fakeCtx() in
    // packages/authkit-sdk/src/embedded_driver.ts actually provides.
    const outOfBandCtx: any = {
      containerResolver: { app: { config: { get: () => cfg } } },
      logger: { info: () => {}, error: () => {} },
    };

    const result: any = await new AdminOrgsService(cfg).createInvitation(
      org.id,
      { email: 'invited@x.com', role: 'admin' },
      ADMIN_ACTOR,
      'https://auth.example.com',
      null,
      outOfBandCtx,
    );

    assert.isTrue(result.ok);
    assert.lengthOf(sent, 1, 'an SDK-created invitation must still reach an inbox');
    assert.equal(sent[0]._to, 'invited@x.com');
    assert.include(sent[0]._text, 'Acme');
    assert.include(sent[0]._text, 'admin');
  });
});
