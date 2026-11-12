import { test } from '@japa/runner';
import { authorizeByToken } from '../src/console_authorize.js';
import { DEV_TOOLS_BINDING, type DevTool, type DevToolCall } from '../src/dev_tools/contract.js';
import { authkitDevToolsAuthorize } from '../src/dev_tools/gate.js';
import { registerAuthkitDevTools } from '../src/dev_tools/register.js';
import { authkitDevTools } from '../src/dev_tools/tools.js';

// ─── fakes ───────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  email: string;
  name?: string;
  globalRoles?: string[];
}

function makeStore(accounts: Account[], options: { status?: boolean } = {}) {
  const disabled = new Set<string>();
  const store: Record<string, any> = {
    async findById(id: string) {
      return accounts.find((a) => a.id === id) ?? null;
    },
    async listAccounts({ search = '', page = 1, size = 20 }: any) {
      const all = accounts.filter((a) => a.email.includes(search));
      return { data: all.slice((page - 1) * size, page * size), total: all.length };
    },
    async getMfaState(id: string) {
      return { enabled: id === 'u1', totp: id === 'u1', enabledAt: 1 };
    },
    async findByProviderIdentity() {
      return null;
    },
    async listProviderIdentities(id: string) {
      return id === 'u1' ? [{ provider: 'google', providerUserId: 'g-1', email: 'a@x.io' }] : [];
    },
    async createOrg() {},
    async findOrgById(id: string) {
      return id === 'o1' ? { id: 'o1', name: 'Acme', slug: 'acme', createdAt: 'now' } : null;
    },
    async listOrgMembers() {
      return [{ accountId: 'u1', role: 'owner', joinedAt: 'now' }];
    },
    async listPendingInvitationsForOrg() {
      return [];
    },
    async listAllOrgsWithMemberCount() {
      return [{ id: 'o1', name: 'Acme', slug: 'acme', role: 'owner', memberCount: 1 }];
    },
  };
  if (options.status !== false) {
    store.disableAccount = async (id: string) => void disabled.add(id);
    store.enableAccount = async (id: string) => void disabled.delete(id);
    store.isDisabled = async (id: string) => disabled.has(id);
  }
  return { store, disabled };
}

function makeAudit() {
  const events: any[] = [];
  return {
    events,
    async record(event: any) {
      events.unshift({ id: `e${events.length + 1}`, createdAt: new Date(0), ...event });
    },
    async list({ page = 1, size = 20, type, subject }: any) {
      const all = events.filter(
        (e) => (!type || e.type === type) && (!subject || e.accountId === subject),
      );
      return { data: all.slice((page - 1) * size, page * size), total: all.length };
    },
  };
}

const SESSION = {
  id: 'sess-secret-id',
  accountId: 'u1',
  email: 'a@x.io',
  loginTs: 1,
  amr: ['pwd'],
  userAgent: 'UA',
  browser: 'Firefox',
  os: 'Linux',
  ip: '10.0.0.1',
  location: 'Lisbon',
};

function makeWorld(options: { admin?: any; status?: boolean; accounts?: Account[] } = {}) {
  const accounts = options.accounts ?? [
    { id: 'u1', email: 'a@x.io', name: 'Ana', globalRoles: ['ADMIN'] },
    { id: 'u2', email: 'b@x.io', globalRoles: [] },
    { id: 'u3', email: 'c@x.io', globalRoles: [] },
  ];
  const { store, disabled } = makeStore(accounts, { status: options.status });
  const audit = makeAudit();
  const revoked: string[] = [];
  const service = {
    config: {
      accountStore: store,
      audit,
      admin: options.admin ?? { enabled: true, roles: ['ADMIN'] },
      organizations: {},
    },
  };
  const deps = {
    service: async () => service,
    sessions: () => ({
      canList: true,
      countActiveSessions: async () => 1,
      listSessions: async (id: string) => (id === 'u1' ? [SESSION] : []),
      listGrants: async (id: string) =>
        id === 'u1'
          ? [
              {
                id: 'grant-id',
                accountId: 'u1',
                clientId: 'web',
                accessTokens: 2,
                refreshTokens: 1,
              },
            ]
          : [],
      revokeAll: async (id: string) => {
        revoked.push(id);
        return { sessions: 1, grants: 1, accessTokens: 2, refreshTokens: 1 };
      },
    }),
    clients: () => ({
      canList: true,
      list: async () => [
        {
          clientId: 'web',
          clientName: 'Web',
          confidential: true,
          grantTypes: ['authorization_code'],
          redirectUris: ['https://app/cb'],
          postLogoutRedirectUris: [],
          tokenEndpointAuthMethod: 'client_secret_basic',
          applicationType: 'web',
          clientSecret: 'shh',
          disabled: false,
          serviceTenant: null,
        },
      ],
      find: async () => undefined,
    }),
  };
  const tools = authkitDevTools(deps as any);
  const ctx: any = {
    containerResolver: { make: async () => service },
    request: { ip: () => '127.0.0.1', header: () => undefined },
  };
  const call: DevToolCall = {
    ctx,
    caller: { id: 'token:abc123', via: 'token' },
    limits: { maxRows: 100, maxBytes: 48 * 1024 },
  };
  const tool = (name: string) => tools.find((t) => t.name === name) as DevTool;
  return { service, tools, tool, call, ctx, audit, disabled, revoked };
}

// ─── catalogue ───────────────────────────────────────────────────────────────

test.group('authkit dev tools — catalogue', () => {
  test('the 11 tools, prefixed, reads and two destructive actions', ({ assert }) => {
    const { tools } = makeWorld();
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'authkit_get_overview',
        'authkit_list_users',
        'authkit_get_user',
        'authkit_list_user_sessions',
        'authkit_list_user_grants',
        'authkit_list_orgs',
        'authkit_get_org',
        'authkit_list_clients',
        'authkit_list_audit',
        'authkit_revoke_user_sessions',
        'authkit_disable_user',
      ],
    );
    for (const t of tools) {
      assert.match(t.name, /^authkit_[a-z]+(_[a-z]+)+$/);
      assert.equal(t.input.type, 'object');
      for (const prop of Object.values(t.input.properties)) {
        assert.include(['string', 'number', 'integer', 'boolean', 'array'], prop.type);
      }
    }
    const actions = tools.filter((t) => t.kind === 'action');
    assert.deepEqual(
      actions.map((t) => [t.name, t.destructive]),
      [
        ['authkit_revoke_user_sessions', true],
        ['authkit_disable_user', true],
      ],
    );
  });
});

// ─── reads ───────────────────────────────────────────────────────────────────

test.group('authkit dev tools — reads', () => {
  test('get_overview: counts, clients and recent audit', async ({ assert }) => {
    const { tool, call, audit } = makeWorld();
    await audit.record({ type: 'login.success', accountId: 'u1' });
    const out: any = await tool('authkit_get_overview').run({}, call);
    assert.equal(out.usersTotal, 3);
    assert.equal(out.activeSessions, 1);
    assert.equal(out.clientsCount, 1);
    assert.equal(out.auditTotal, 1);
    assert.equal(out.recentEvents[0].type, 'login.success');
  });

  test('list_users: default limit 20, max 100, pages with next', async ({ assert }) => {
    const accounts = Array.from({ length: 130 }, (_, i) => ({ id: `a${i}`, email: `u${i}@x.io` }));
    const { tool, call } = makeWorld({ accounts });
    const first: any = await tool('authkit_list_users').run({}, call);
    assert.lengthOf(first.items, 20);
    assert.equal(first.total, 130);
    assert.equal(first.next, 2);
    const big: any = await tool('authkit_list_users').run({ limit: 500 }, call);
    assert.lengthOf(big.items, 100);
    assert.equal(big.next, 2);
    const last: any = await tool('authkit_list_users').run({ limit: 100, page: 2 }, call);
    assert.lengthOf(last.items, 30);
    assert.isNull(last.next);
    const search: any = await tool('authkit_list_users').run({ search: 'u12' }, call);
    assert.isTrue(search.items.every((u: any) => u.email.includes('u12')));
    assert.properties(first.items[0], ['id', 'email', 'roles', 'disabled']);
  });

  test('get_user: MFA, identities and counts, never session ids', async ({ assert }) => {
    const { tool, call } = makeWorld();
    const out: any = await tool('authkit_get_user').run({ id: 'u1' }, call);
    assert.equal(out.email, 'a@x.io');
    assert.deepEqual(out.roles, ['ADMIN']);
    assert.deepEqual(out.mfa, { enabled: true, totp: true });
    assert.deepEqual(out.identities, [
      { provider: 'google', providerUserId: 'g-1', email: 'a@x.io' },
    ]);
    assert.equal(out.sessionCount, 1);
    assert.equal(out.grantCount, 1);
    assert.notInclude(JSON.stringify(out), 'sess-secret-id');
    await assert.rejects(() => tool('authkit_get_user').run({ id: 'nope' }, call), /No account/);
  });

  test('list_user_sessions: what the console shows, without the session id', async ({ assert }) => {
    const { tool, call } = makeWorld();
    const out: any = await tool('authkit_list_user_sessions').run({ accountId: 'u1' }, call);
    assert.isTrue(out.supported);
    assert.lengthOf(out.items, 1);
    assert.equal(out.items[0].ip, '10.0.0.1');
    assert.equal(out.items[0].browser, 'Firefox');
    assert.notProperty(out.items[0], 'id');
    assert.notInclude(JSON.stringify(out), 'sess-secret-id');
    assert.isNull(out.next);
  });

  test('list_user_grants: client and token counts, no grant id', async ({ assert }) => {
    const { tool, call } = makeWorld();
    const out: any = await tool('authkit_list_user_grants').run({ accountId: 'u1' }, call);
    assert.deepEqual(out.items, [
      { accountId: 'u1', clientId: 'web', accessTokens: 2, refreshTokens: 1 },
    ]);
  });

  test('list_orgs and get_org', async ({ assert }) => {
    const { tool, call } = makeWorld();
    const list: any = await tool('authkit_list_orgs').run({}, call);
    assert.isTrue(list.supported);
    assert.equal(list.items[0].slug, 'acme');
    assert.equal(list.items[0].memberCount, 1);
    const org: any = await tool('authkit_get_org').run({ id: 'o1' }, call);
    assert.equal(org.members[0].email, 'a@x.io');
    await assert.rejects(() => tool('authkit_get_org').run({ id: 'x' }, call), /No organization/);
  });

  test('list_clients: never the secret', async ({ assert }) => {
    const { tool, call } = makeWorld();
    const out: any = await tool('authkit_list_clients').run({}, call);
    assert.equal(out.items[0].clientId, 'web');
    assert.equal(out.items[0].authMethod, 'client_secret_basic');
    assert.notInclude(JSON.stringify(out), 'shh');
  });

  test('list_audit: filters and pages', async ({ assert }) => {
    const { tool, call, audit } = makeWorld();
    for (let i = 0; i < 25; i++) await audit.record({ type: 'login.failure', accountId: 'u2' });
    await audit.record({ type: 'login.success', accountId: 'u1' });
    const out: any = await tool('authkit_list_audit').run({ type: 'login.failure' }, call);
    assert.lengthOf(out.items, 20);
    assert.equal(out.total, 25);
    assert.equal(out.next, 2);
    const bySubject: any = await tool('authkit_list_audit').run({ subject: 'u1' }, call);
    assert.equal(bySubject.total, 1);
  });
});

// ─── actions ─────────────────────────────────────────────────────────────────

test.group('authkit dev tools — actions', () => {
  test('revoke_user_sessions revokes and audits with the mcp actor', async ({ assert }) => {
    const { tool, call, audit, revoked } = makeWorld();
    const out: any = await tool('authkit_revoke_user_sessions').run({ accountId: 'u2' }, call);
    assert.deepEqual(revoked, ['u2']);
    assert.equal(out.sessions, 1);
    const event = audit.events[0];
    assert.equal(event.type, 'session.revoked_all');
    assert.equal(event.accountId, 'u2');
    assert.equal(event.actorId, 'mcp:token:abc123');
    assert.equal(event.metadata.source, 'mcp');
    assert.equal(event.metadata.actor, 'mcp');
    await assert.rejects(
      () => tool('authkit_revoke_user_sessions').run({ accountId: 'nope' }, call),
      /No account/,
    );
  });

  test('disable_user disables and audits with the mcp actor', async ({ assert }) => {
    const { tool, call, audit, disabled } = makeWorld();
    await tool('authkit_disable_user').run({ accountId: 'u2' }, call);
    assert.isTrue(disabled.has('u2'));
    assert.equal(audit.events[0].type, 'user.disabled');
    assert.equal(audit.events[0].actorId, 'mcp:token:abc123');
    assert.deepEqual(audit.events[0].metadata, { actor: 'mcp' });
  });

  test('disable_user is unavailable when the store cannot disable accounts', async ({ assert }) => {
    const world = makeWorld({ status: false });
    const tools = authkitDevTools({
      service: async () => world.service,
      resolve: async () => world.service,
    });
    const disable = tools.find((t) => t.name === 'authkit_disable_user')!;
    assert.isFalse(await disable.available!());
    const able = makeWorld();
    const ok = authkitDevTools({ resolve: async () => able.service }).find(
      (t) => t.name === 'authkit_disable_user',
    )!;
    assert.isTrue(await ok.available!());
  });
});

// ─── gate ────────────────────────────────────────────────────────────────────

function gateCtx(service: any, opts: { bearer?: string; identity?: string | null } = {}) {
  const ctx: any = {
    containerResolver: { make: async () => service },
    request: {
      header: (name: string) =>
        name === 'authorization' && opts.bearer ? `Bearer ${opts.bearer}` : undefined,
    },
  };
  if (opts.identity !== undefined) {
    ctx.authkit = {
      getIdentity: async () => (opts.identity === null ? null : { userId: opts.identity }),
    };
  }
  return ctx;
}

test.group('authkit dev tools — gate', () => {
  test('admin.authorize allows → roles are skipped', async ({ assert }) => {
    const { service } = makeWorld({
      admin: { enabled: true, roles: ['ADMIN'], authorize: authorizeByToken({ token: 't0k' }) },
    });
    const gate = authkitDevToolsAuthorize({ inProduction: () => true });
    // A bearer with no account at all: roles would fail, authorize decides.
    assert.deepEqual(await gate(gateCtx(service, { bearer: 't0k' })), { allowed: true });
    assert.deepEqual(await gate(gateCtx(service, { bearer: 'bad' })), {
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  test('admin.authorize redirect / deny / throw', async ({ assert }) => {
    const gate = authkitDevToolsAuthorize({ inProduction: () => false });
    const redirect = makeWorld({
      admin: { enabled: true, roles: ['ADMIN'], authorize: () => ({ redirectTo: '/login' }) },
    });
    assert.deepEqual(await gate(gateCtx(redirect.service)), {
      allowed: false,
      reason: 'unauthenticated',
      redirectTo: '/login',
    });
    const deny = makeWorld({ admin: { enabled: true, roles: ['ADMIN'], authorize: () => false } });
    assert.deepEqual(await gate(gateCtx(deny.service, { identity: 'u1' })), {
      allowed: false,
      reason: 'forbidden',
    });
    const boom = makeWorld({
      admin: {
        enabled: true,
        roles: ['ADMIN'],
        authorize: () => {
          throw new Error('boom');
        },
      },
    });
    const decision = await gate(gateCtx(boom.service));
    assert.isFalse(decision.allowed);
  });

  test('authorize omitted: production denies even an admin', async ({ assert }) => {
    const { service } = makeWorld();
    const gate = authkitDevToolsAuthorize({ inProduction: () => true });
    assert.deepEqual(await gate(gateCtx(service, { identity: 'u1' })), {
      allowed: false,
      reason: 'forbidden',
    });
  });

  test('authorize omitted outside production: a signed-in admin only', async ({ assert }) => {
    const { service, disabled } = makeWorld();
    const gate = authkitDevToolsAuthorize({ inProduction: () => false });
    assert.deepEqual(await gate(gateCtx(service, { identity: 'u1' })), { allowed: true });
    assert.deepEqual(await gate(gateCtx(service, { identity: 'u2' })), {
      allowed: false,
      reason: 'forbidden',
    });
    assert.deepEqual(await gate(gateCtx(service)), {
      allowed: false,
      reason: 'unauthenticated',
    });
    assert.deepEqual(await gate(gateCtx(service, { identity: null })), {
      allowed: false,
      reason: 'unauthenticated',
    });
    assert.deepEqual(await gate(gateCtx(service, { identity: 'ghost' })), {
      allowed: false,
      reason: 'unauthenticated',
    });
    disabled.add('u1');
    assert.deepEqual(await gate(gateCtx(service, { identity: 'u1' })), {
      allowed: false,
      reason: 'forbidden',
    });
  });

  test('admin console off → forbidden', async ({ assert }) => {
    const { service } = makeWorld({ admin: { enabled: false, roles: ['ADMIN'] } });
    const gate = authkitDevToolsAuthorize({ inProduction: () => false });
    assert.deepEqual(await gate(gateCtx(service, { identity: 'u1' })), {
      allowed: false,
      reason: 'forbidden',
    });
  });

  test('resolving authkit.server fails → forbidden, never throws', async ({ assert }) => {
    const gate = authkitDevToolsAuthorize({ inProduction: () => false });
    const ctx: any = {
      containerResolver: {
        make: async () => {
          throw new Error('no');
        },
      },
    };
    const decision = await gate(ctx);
    assert.isFalse(decision.allowed);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

function fakeApp(hub?: unknown) {
  return {
    container: {
      hasBinding: (name: string) => name === DEV_TOOLS_BINDING && hub !== undefined,
      make: async (name: string) => (name === DEV_TOOLS_BINDING ? hub : { config: {} }),
    },
  } as any;
}

test.group('authkit dev tools — registration', () => {
  test('registers into a v1 hub', async ({ assert }) => {
    const registered: any[] = [];
    const hub = { version: 1, register: (lib: any) => registered.push(lib) };
    assert.isTrue(await registerAuthkitDevTools(fakeApp(hub), { admin: { enabled: true } }));
    assert.lengthOf(registered, 1);
    assert.equal(registered[0].lib, 'authkit');
    assert.lengthOf(registered[0].tools, 11);
    assert.isFunction(registered[0].authorize);
  });

  test('skipped without the binding, with another version, or with the admin console off', async ({
    assert,
  }) => {
    const registered: any[] = [];
    const hub = { version: 1, register: (lib: any) => registered.push(lib) };
    assert.isFalse(await registerAuthkitDevTools(fakeApp(), { admin: { enabled: true } }));
    assert.isFalse(
      await registerAuthkitDevTools(fakeApp({ version: 2, register: () => {} }), {
        admin: { enabled: true },
      }),
    );
    assert.isFalse(await registerAuthkitDevTools(fakeApp(hub), { admin: { enabled: false } }));
    assert.isFalse(await registerAuthkitDevTools(fakeApp(hub), {}));
    assert.lengthOf(registered, 0);
  });
});
