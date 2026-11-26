/**
 * Quem pode remover/trocar o papel de quem numa org (superfícies member-facing).
 * Antes, um `admin` rebaixava ou removia um `owner` sempre que havia mais de um:
 * só conceder `owner` era privativo de owner, e o store só barrava o ÚLTIMO owner.
 */
import { test } from '@japa/runner';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import AccountOrgsController from '../../src/host/controllers/account_orgs_controller.js';
import { checkOrgMemberAction, orgRoleRank } from '../../src/host/org_member_rules.js';

test.group('checkOrgMemberAction', () => {
  const ok = (actor: string, target: string, self = false) =>
    checkOrgMemberAction(
      { accountId: 'actor', role: actor },
      { accountId: self ? 'actor' : 'target', role: target },
    ).ok;

  test('hierarquia: owner > admin > qualquer outro papel', ({ assert }) => {
    assert.equal(orgRoleRank('owner'), 3);
    assert.equal(orgRoleRank('admin'), 2);
    assert.equal(orgRoleRank('member'), 1);
    assert.equal(orgRoleRank('billing'), 1);
  });

  test('owner age sobre todos, inclusive outro owner', ({ assert }) => {
    assert.isTrue(ok('owner', 'owner'));
    assert.isTrue(ok('owner', 'admin'));
    assert.isTrue(ok('owner', 'member'));
  });

  test('admin só age sobre quem está abaixo', ({ assert }) => {
    assert.isFalse(ok('admin', 'owner'));
    assert.isFalse(ok('admin', 'admin'));
    assert.isTrue(ok('admin', 'member'));
    assert.isTrue(ok('admin', 'billing'));
  });

  test('sobre si mesmo passa (só consegue descer)', ({ assert }) => {
    assert.isTrue(ok('admin', 'admin', true));
  });

  test('a mensagem diz o que fazer', ({ assert }) => {
    const owner = checkOrgMemberAction(
      { accountId: 'a', role: 'admin' },
      { accountId: 'b', role: 'owner' },
    );
    assert.deepEqual(owner, {
      ok: false,
      message: 'Only an owner can remove or change the role of an owner.',
    });
    const peer = checkOrgMemberAction(
      { accountId: 'a', role: 'admin' },
      { accountId: 'b', role: 'admin' },
    );
    assert.isFalse(peer.ok);
    assert.match((peer as { message: string }).message, /same or higher.*Ask an owner/);
  });
});

function scenario() {
  const members = new Map<string, string>([
    ['owner-1', 'owner'],
    ['owner-2', 'owner'],
    ['admin-1', 'admin'],
    ['admin-2', 'admin'],
    ['user-1', 'member'],
  ]);
  const events: any[] = [];
  const store = {
    // `supportsOrganizations` reconhece a capacidade por este método.
    createOrg: async () => {
      throw new Error('not used');
    },
    findOrgById: async (id: string) => ({ id, name: id, slug: id }),
    listOrgsForAccount: async () => [],
    getOrgMembership: async (_orgId: string, accountId: string) => {
      const role = members.get(accountId);
      return role ? { role } : null;
    },
    removeOrgMember: async (_orgId: string, accountId: string) => {
      if (!members.has(accountId)) return { ok: false, reason: 'not_found' as const };
      members.delete(accountId);
      return { ok: true };
    },
  };
  const service = {
    config: {
      accountStore: store,
      organizations: { roles: ['owner', 'admin', 'member'] },
      audit: { record: async (e: any) => events.push(e) },
    },
  };
  return { members, events, service };
}

function fakeCtx(actorId: string, targetId: string, service: any) {
  let status = 200;
  let body: unknown;
  const ctx: any = {
    params: { id: 'org-1', accountId: targetId },
    request: { param: (k: string) => ctx.params[k], input: (_k: string, d?: unknown) => d },
    response: {
      forbidden: (b?: unknown) => {
        status = 403;
        body = b;
        return b;
      },
      redirect: () => {
        status = 302;
        return null;
      },
    },
    session: { get: (k: string) => (k === ACCOUNT_SESSION_KEY ? actorId : undefined) },
    containerResolver: {
      make: async (name: string) => {
        if (name === 'authkit.server') return service;
        throw new Error(`unknown binding: ${name}`);
      },
    },
  };
  return { ctx, status: () => status, body: () => body };
}

test.group('POST /account/orgs/:id/members/:accountId/remove (form) — papel do alvo', () => {
  test('admin removendo owner → 403 com a mensagem e nada muda', async ({ assert }) => {
    const { members, events, service } = scenario();
    const c = fakeCtx('admin-1', 'owner-2', service);
    await new AccountOrgsController().removeMember(c.ctx);
    assert.equal(c.status(), 403);
    assert.match(String(c.body()), /Only an owner/);
    assert.equal(members.get('owner-2'), 'owner');
    assert.lengthOf(events, 0);
  });

  test('admin removendo outro admin → 403', async ({ assert }) => {
    const { members, service } = scenario();
    const c = fakeCtx('admin-1', 'admin-2', service);
    await new AccountOrgsController().removeMember(c.ctx);
    assert.equal(c.status(), 403);
    assert.equal(members.get('admin-2'), 'admin');
  });

  test('admin removendo member → ok', async ({ assert }) => {
    const { members, service } = scenario();
    const c = fakeCtx('admin-1', 'user-1', service);
    await new AccountOrgsController().removeMember(c.ctx);
    assert.equal(c.status(), 302);
    assert.isFalse(members.has('user-1'));
  });

  test('owner removendo outro owner → ok', async ({ assert }) => {
    const { members, service } = scenario();
    const c = fakeCtx('owner-1', 'owner-2', service);
    await new AccountOrgsController().removeMember(c.ctx);
    assert.equal(c.status(), 302);
    assert.isFalse(members.has('owner-2'));
  });
});
