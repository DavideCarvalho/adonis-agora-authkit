import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { test } from '@japa/runner';
import type { Authkit } from '../index.js';
import { AuthkitApiError, createAuthkit } from '../index.js';

interface Captured {
  method: string;
  url: string;
  authorization?: string;
  body?: any;
}

/** Spins a fake Admin API: records the request and replays a canned response. */
function fakeApi(handler: (req: Captured) => { status: number; body: unknown } | undefined) {
  let last: Captured | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const captured: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      };
      last = captured;
      const out = handler(captured) ?? { status: 200, body: {} };
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
  });
  return {
    server,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve(`http://127.0.0.1:${port}`);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get last() {
      return last;
    },
  };
}

async function withApi(
  handler: Parameters<typeof fakeApi>[0],
  run: (sdk: Authkit, api: ReturnType<typeof fakeApi>) => Promise<void>,
) {
  const api = fakeApi(handler);
  const baseUrl = await api.listen();
  try {
    const sdk = await createAuthkit({ mode: 'remote', baseUrl, apiKey: 'key-123' });
    await run(sdk, api);
  } finally {
    await api.close();
  }
}

test.group('remote driver — users', () => {
  test('list hits GET /users with query + Bearer key', async ({ assert }) => {
    await withApi(
      () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'u1',
              email: 'a@b.com',
              name: null,
              avatarUrl: null,
              globalRoles: [],
              disabled: false,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
      async (sdk, api) => {
        const res = await sdk.users.list({ search: 'ana', page: 2 });
        assert.equal(res.total, 1);
        assert.equal(res.data[0].id, 'u1');
        assert.equal(api.last!.method, 'GET');
        assert.match(api.last!.url, /^\/api\/authkit\/v1\/users\?/);
        assert.match(api.last!.url, /search=ana/);
        assert.match(api.last!.url, /page=2/);
        assert.equal(api.last!.authorization, 'Bearer key-123');
      },
    );
  });

  test('create POSTs body and returns invited flag', async ({ assert }) => {
    await withApi(
      () => ({
        status: 201,
        body: {
          id: 'u2',
          email: 'new@b.com',
          name: 'New',
          avatarUrl: null,
          globalRoles: [],
          disabled: false,
          invited: true,
        },
      }),
      async (sdk, api) => {
        const res = await sdk.users.create({ email: 'new@b.com', name: 'New', invite: true });
        assert.equal(res.id, 'u2');
        assert.isTrue(res.invited);
        assert.equal(api.last!.method, 'POST');
        assert.equal(api.last!.url, '/api/authkit/v1/users');
        assert.deepEqual(api.last!.body, { email: 'new@b.com', name: 'New', invite: true });
      },
    );
  });

  test('delete uses DELETE verb and returns cascade counts', async ({ assert }) => {
    await withApi(
      () => ({
        status: 200,
        body: {
          id: 'u1',
          deleted: true,
          sessions: 1,
          grants: 2,
          accessTokens: 3,
          refreshTokens: 1,
          pats: 1,
          passkeys: 1,
          providerIdentities: 1,
          auditAnonymized: 5,
          avatarDeleted: true,
        },
      }),
      async (sdk, api) => {
        const res = await sdk.users.delete('u1');
        assert.isTrue(res.deleted);
        assert.equal(res.passkeys, 1);
        assert.equal(res.auditAnonymized, 5);
        assert.equal(api.last!.method, 'DELETE');
        assert.equal(api.last!.url, '/api/authkit/v1/users/u1');
      },
    );
  });
});

test.group('remote driver — error mapping', () => {
  test('401 maps to AuthkitApiError', async ({ assert }) => {
    await withApi(
      () => ({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'API key inválida.' } },
      }),
      async (sdk) => {
        await assert.rejects(async () => {
          try {
            await sdk.users.list();
          } catch (e) {
            assert.instanceOf(e, AuthkitApiError);
            assert.equal((e as AuthkitApiError).status, 401);
            assert.equal((e as AuthkitApiError).code, 'unauthorized');
            throw e;
          }
        });
      },
    );
  });

  test('404 maps to not_found', async ({ assert }) => {
    await withApi(
      () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'Usuário não encontrado.' } },
      }),
      async (sdk) => {
        try {
          await sdk.users.get('missing');
          assert.fail('should have thrown');
        } catch (e) {
          assert.instanceOf(e, AuthkitApiError);
          assert.equal((e as AuthkitApiError).status, 404);
          assert.equal((e as AuthkitApiError).code, 'not_found');
        }
      },
    );
  });

  test('409 maps to conflict code', async ({ assert }) => {
    await withApi(
      () => ({ status: 409, body: { error: { code: 'email_taken', message: 'Já existe.' } } }),
      async (sdk) => {
        try {
          await sdk.users.create({ email: 'dup@b.com' });
          assert.fail('should have thrown');
        } catch (e) {
          assert.equal((e as AuthkitApiError).status, 409);
          assert.equal((e as AuthkitApiError).code, 'email_taken');
        }
      },
    );
  });

  test('network error wraps with network_error code', async ({ assert }) => {
    const sdk = await createAuthkit({ mode: 'remote', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
    try {
      await sdk.users.list();
      assert.fail('should have thrown');
    } catch (e) {
      assert.instanceOf(e, AuthkitApiError);
      assert.equal((e as AuthkitApiError).code, 'network_error');
    }
  });
});

test.group('remote driver — stats', () => {
  test('stats() hits GET /stats and returns the shape', async ({ assert }) => {
    const statsPayload = {
      totalUsers: 100,
      activeSessions: 5,
      mau: 42,
      signInsTotal: 200,
      signUpsTotal: 15,
      signInsPerDay: [{ date: '2024-01-01', count: 7 }],
      signUpsPerDay: [{ date: '2024-01-01', count: 2 }],
      auditSupported: true,
      windowDays: 30,
    };
    await withApi(
      () => ({ status: 200, body: statsPayload }),
      async (sdk, api) => {
        const res = await sdk.stats();
        assert.equal(res.totalUsers, 100);
        assert.equal(res.mau, 42);
        assert.equal(res.signInsTotal, 200);
        assert.equal(res.windowDays, 30);
        assert.isArray(res.signInsPerDay);
        assert.equal(api.last!.method, 'GET');
        assert.equal(api.last!.url, '/api/authkit/v1/stats');
        assert.equal(api.last!.authorization, 'Bearer key-123');
      },
    );
  });
});

test.group('remote driver — clients + tokens', () => {
  test('create returns secret once', async ({ assert }) => {
    await withApi(
      () => ({ status: 201, body: { clientId: 'c1', clientSecret: 'sek' } }),
      async (sdk, api) => {
        const res = await sdk.clients.create({ redirectUris: ['https://x/cb'] });
        assert.equal(res.clientId, 'c1');
        assert.equal(res.clientSecret, 'sek');
        assert.equal(api.last!.url, '/api/authkit/v1/clients');
      },
    );
  });

  test('regenerateSecret hits the right path', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { clientId: 'c1', clientSecret: 'sek2' } }),
      async (sdk, api) => {
        const res = await sdk.clients.regenerateSecret('c1');
        assert.equal(res.clientSecret, 'sek2');
        assert.equal(api.last!.url, '/api/authkit/v1/clients/c1/regenerate-secret');
        assert.equal(api.last!.method, 'POST');
      },
    );
  });

  test('delete uses DELETE verb', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { clientId: 'c1', deleted: true } }),
      async (sdk, api) => {
        const res = await sdk.clients.delete('c1');
        assert.isTrue(res.deleted);
        assert.equal(api.last!.method, 'DELETE');
        assert.equal(api.last!.url, '/api/authkit/v1/clients/c1');
      },
    );
  });

  test('tokens.verify posts token and returns introspection', async ({ assert }) => {
    await withApi(
      () => ({
        status: 200,
        body: { active: true, tokenType: 'pat', sub: 'u1', scopes: ['read'] },
      }),
      async (sdk, api) => {
        const res = await sdk.tokens.verify('pat_abc');
        assert.isTrue(res.active);
        if (res.active) assert.equal(res.tokenType, 'pat');
        assert.equal(api.last!.url, '/api/authkit/v1/tokens/verify');
        assert.deepEqual(api.last!.body, { token: 'pat_abc' });
      },
    );
  });
});

test.group('remote driver — organizations', () => {
  const fakeOrg = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    logoUrl: null,
    metadata: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    memberCount: 2,
  };
  const fakeMember = {
    accountId: 'u1',
    email: 'a@b.com',
    role: 'owner',
    joinedAt: '2024-01-01T00:00:00.000Z',
  };
  const fakeInv = {
    id: 'inv-1',
    organizationId: 'org-1',
    email: 'inv@b.com',
    role: 'member',
    invitedBy: 'u1',
    expiresAt: '2024-12-31T00:00:00.000Z',
    acceptedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  test('organizations.list hits GET /organizations', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { data: [fakeOrg] } }),
      async (sdk, api) => {
        const res = await sdk.organizations.list();
        assert.lengthOf(res.data, 1);
        assert.equal(res.data[0].slug, 'acme');
        assert.equal(api.last!.url, '/api/authkit/v1/organizations');
        assert.equal(api.last!.method, 'GET');
      },
    );
  });

  test('organizations.create posts to /organizations (201)', async ({ assert }) => {
    await withApi(
      () => ({ status: 201, body: fakeOrg }),
      async (sdk, api) => {
        const res = await sdk.organizations.create({
          name: 'Acme',
          slug: 'acme',
          ownerAccountId: 'u1',
        });
        assert.equal(res.name, 'Acme');
        assert.equal(api.last!.method, 'POST');
        assert.equal(api.last!.url, '/api/authkit/v1/organizations');
      },
    );
  });

  test('organizations.get hits GET /organizations/:id', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { ...fakeOrg, members: [fakeMember], pendingInvitations: [] } }),
      async (sdk, api) => {
        const res = await sdk.organizations.get('org-1');
        assert.equal(res.id, 'org-1');
        assert.isArray(res.members);
        assert.equal(api.last!.url, '/api/authkit/v1/organizations/org-1');
      },
    );
  });

  test('organizations.update patches /organizations/:id', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { ...fakeOrg, name: 'Acme Updated' } }),
      async (sdk, api) => {
        const res = await sdk.organizations.update('org-1', { name: 'Acme Updated' });
        assert.equal(res.name, 'Acme Updated');
        assert.equal(api.last!.method, 'PATCH');
      },
    );
  });

  test('organizations.delete uses DELETE', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { id: 'org-1', deleted: true } }),
      async (sdk, api) => {
        const res = await sdk.organizations.delete('org-1');
        assert.isTrue(res.deleted);
        assert.equal(api.last!.method, 'DELETE');
      },
    );
  });

  test('organizations.members.add posts to /members (201)', async ({ assert }) => {
    await withApi(
      () => ({
        status: 201,
        body: { orgId: 'org-1', accountId: 'u2', role: 'member', added: true },
      }),
      async (sdk, api) => {
        const res = await sdk.organizations.members.add('org-1', {
          accountId: 'u2',
          role: 'member',
        });
        assert.isTrue(res.added);
        assert.equal(api.last!.url, '/api/authkit/v1/organizations/org-1/members');
      },
    );
  });

  test('organizations.members.remove uses DELETE', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { orgId: 'org-1', accountId: 'u2', removed: true } }),
      async (sdk, api) => {
        const res = await sdk.organizations.members.remove('org-1', 'u2');
        assert.isTrue(res.removed);
        assert.equal(api.last!.method, 'DELETE');
        assert.equal(api.last!.url, '/api/authkit/v1/organizations/org-1/members/u2');
      },
    );
  });

  test('organizations.members.updateRole patches /members/:accountId', async ({ assert }) => {
    await withApi(
      () => ({
        status: 200,
        body: { orgId: 'org-1', accountId: 'u2', role: 'admin', updated: true },
      }),
      async (sdk, api) => {
        const res = await sdk.organizations.members.updateRole('org-1', 'u2', 'admin');
        assert.equal(res.role, 'admin');
        assert.equal(api.last!.method, 'PATCH');
      },
    );
  });

  test('organizations.invitations.create posts to /invitations', async ({ assert }) => {
    await withApi(
      () => ({ status: 201, body: fakeInv }),
      async (sdk, api) => {
        const res = await sdk.organizations.invitations.create('org-1', {
          email: 'inv@b.com',
          role: 'member',
        });
        assert.equal(res.email, 'inv@b.com');
        assert.equal(api.last!.url, '/api/authkit/v1/organizations/org-1/invitations');
      },
    );
  });

  test('organizations.invitations.revoke uses DELETE', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: { orgId: 'org-1', invitationId: 'inv-1', revoked: true } }),
      async (sdk, api) => {
        const res = await sdk.organizations.invitations.revoke('org-1', 'inv-1');
        assert.isTrue(res.revoked);
        assert.equal(api.last!.method, 'DELETE');
        assert.equal(api.last!.url, '/api/authkit/v1/organizations/org-1/invitations/inv-1');
      },
    );
  });
});

test.group('remote driver — apiPrefix option', () => {
  async function withCustomPrefixApi(
    apiPrefix: string,
    handler: Parameters<typeof fakeApi>[0],
    run: (sdk: Authkit, api: ReturnType<typeof fakeApi>) => Promise<void>,
  ) {
    const api = fakeApi(handler);
    const baseUrl = await api.listen();
    try {
      const sdk = await createAuthkit({ mode: 'remote', baseUrl, apiKey: 'key-123', apiPrefix });
      await run(sdk, api);
    } finally {
      await api.close();
    }
  }

  test('custom apiPrefix: hits correct path for users.list', async ({ assert }) => {
    await withCustomPrefixApi(
      '/authkit/api',
      () => ({
        status: 200,
        body: { data: [], total: 0, page: 1, limit: 20 },
      }),
      async (sdk, api) => {
        await sdk.users.list();
        assert.match(api.last!.url, /^\/authkit\/api\/users/);
      },
    );
  });

  test('custom apiPrefix: hits correct path for clients.list', async ({ assert }) => {
    await withCustomPrefixApi(
      '/authkit/api',
      () => ({ status: 200, body: { canList: true, data: [] } }),
      async (sdk, api) => {
        await sdk.clients.list();
        assert.equal(api.last!.url, '/authkit/api/clients');
      },
    );
  });

  test('custom apiPrefix: hits correct path for stats', async ({ assert }) => {
    const statsPayload = {
      totalUsers: 0,
      activeSessions: 0,
      mau: 0,
      signInsTotal: 0,
      signUpsTotal: 0,
      signInsPerDay: [],
      signUpsPerDay: [],
      auditSupported: false,
      windowDays: 30,
    };
    await withCustomPrefixApi(
      '/my/api/v2',
      () => ({ status: 200, body: statsPayload }),
      async (sdk, api) => {
        await sdk.stats();
        assert.equal(api.last!.url, '/my/api/v2/stats');
      },
    );
  });

  test('custom apiPrefix normalizes: trailing slash stripped, leading slash added', async ({
    assert,
  }) => {
    await withCustomPrefixApi(
      'authkit/api/',
      () => ({ status: 200, body: { data: [], total: 0, page: 1, limit: 20 } }),
      async (sdk, api) => {
        await sdk.users.list();
        assert.match(api.last!.url, /^\/authkit\/api\/users/);
      },
    );
  });

  test('default (no apiPrefix): still uses /api/authkit/v1 (back-compat)', async ({ assert }) => {
    const api = fakeApi(() => ({ status: 200, body: { data: [], total: 0, page: 1, limit: 20 } }));
    const baseUrl = await api.listen();
    try {
      // No apiPrefix passed — back-compat
      const sdk = await createAuthkit({ mode: 'remote', baseUrl, apiKey: 'key-123' });
      await sdk.users.list();
      assert.match(api.last!.url, /^\/api\/authkit\/v1\/users/);
    } finally {
      await api.close();
    }
  });

  test('custom apiPrefix: token verify uses new prefix', async ({ assert }) => {
    await withCustomPrefixApi(
      '/authkit/api',
      () => ({ status: 200, body: { active: false } }),
      async (sdk, api) => {
        await sdk.tokens.verify('some-token');
        assert.equal(api.last!.url, '/authkit/api/tokens/verify');
      },
    );
  });
});

test.group('remote driver — keys', () => {
  const fakeStatus = {
    ageDays: 10,
    policy: { enabled: true, maxAgeDays: 90, keep: 2 },
    nextRotationInDays: 80,
  };
  const fakeRotateResult = {
    rotated: true,
    newKid: 'kid-new',
    retiredKids: ['kid-old'],
    keptKids: ['kid-kept'],
  };

  test('keys.status() hits GET /keys with Bearer header and parses response', async ({
    assert,
  }) => {
    await withApi(
      () => ({ status: 200, body: fakeStatus }),
      async (sdk, api) => {
        const res = await sdk.keys.status();
        assert.equal(res.ageDays, 10);
        assert.deepEqual(res.policy, { enabled: true, maxAgeDays: 90, keep: 2 });
        assert.equal(res.nextRotationInDays, 80);
        assert.equal(api.last!.method, 'GET');
        assert.equal(api.last!.url, '/api/authkit/v1/keys');
        assert.equal(api.last!.authorization, 'Bearer key-123');
      },
    );
  });

  test('keys.rotate() without input hits POST /keys/rotate with empty body', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: fakeRotateResult }),
      async (sdk, api) => {
        const res = await sdk.keys.rotate();
        assert.isTrue(res.rotated);
        assert.equal(res.newKid, 'kid-new');
        assert.deepEqual(res.retiredKids, ['kid-old']);
        assert.deepEqual(res.keptKids, ['kid-kept']);
        assert.equal(api.last!.method, 'POST');
        assert.equal(api.last!.url, '/api/authkit/v1/keys/rotate');
        assert.equal(api.last!.authorization, 'Bearer key-123');
        assert.deepEqual(api.last!.body, {});
      },
    );
  });

  test('keys.rotate({ retire: true }) sends retire flag in body', async ({ assert }) => {
    await withApi(
      () => ({
        status: 200,
        body: { ...fakeRotateResult, retiredKids: ['kid-old-1', 'kid-old-2'] },
      }),
      async (sdk, api) => {
        const res = await sdk.keys.rotate({ retire: true });
        assert.isTrue(res.rotated);
        assert.deepEqual(api.last!.body, { retire: true });
        assert.equal(api.last!.url, '/api/authkit/v1/keys/rotate');
      },
    );
  });

  test('keys.rotate({ keep: 3 }) sends keep in body', async ({ assert }) => {
    await withApi(
      () => ({ status: 200, body: fakeRotateResult }),
      async (sdk, api) => {
        await sdk.keys.rotate({ keep: 3 });
        assert.deepEqual(api.last!.body, { keep: 3 });
      },
    );
  });

  test('keys.status() 501 maps to AuthkitApiError with not_implemented code', async ({
    assert,
  }) => {
    await withApi(
      () => ({
        status: 501,
        body: { error: { code: 'not_implemented', message: 'jwks não é managed+store.' } },
      }),
      async (sdk) => {
        try {
          await sdk.keys.status();
          assert.fail('should have thrown');
        } catch (e) {
          assert.instanceOf(e, AuthkitApiError);
          assert.equal((e as AuthkitApiError).status, 501);
          assert.equal((e as AuthkitApiError).code, 'not_implemented');
        }
      },
    );
  });
});
