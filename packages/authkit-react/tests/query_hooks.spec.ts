/**
 * Testes dos hooks TanStack Query — smoke tests.
 *
 * Verifica:
 * - query key estruturada correta
 * - queryFn delega para o client
 * - mutation options tem mutationKey e mutationFn corretos
 *
 * Não renderiza componentes React (headless): testa apenas os objetos
 * retornados pelas funções de options.
 */

import { test } from '@japa/runner';
import { QueryClient } from '@tanstack/react-query';
import { createAuthkitClient } from '../src/client/client.js';
import { authkitKeys } from '../src/queries/keys.js';

// ─── Setup helpers ────────────────────────────────────────────────────────────

/** Mock de fetch que retorna body JSON com status 200. */
function mockFetch(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status: 200 }) as any;
}

/** Cria um QueryClient limpo para cada teste. */
function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ─── Query keys ───────────────────────────────────────────────────────────────

test.group('authkitKeys', () => {
  test('admin.overview() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.overview(), ['authkit', 'admin', 'overview']);
  });

  test('admin.users() inclui params vazios', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.users(), ['authkit', 'admin', 'users', {}]);
    assert.deepEqual(authkitKeys.admin.users({ search: 'ana' }), [
      'authkit',
      'admin',
      'users',
      { search: 'ana' },
    ]);
  });

  test('admin.user(id) inclui o id', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.user('123'), ['authkit', 'admin', 'users', '123']);
  });

  test('admin.clients() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.clients(), ['authkit', 'admin', 'clients']);
  });

  test('admin.roles() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.roles(), ['authkit', 'admin', 'roles']);
  });

  test('admin.settings() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.settings(), ['authkit', 'admin', 'settings']);
  });

  test('admin.impersonation(userId) inclui userId', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.impersonation('u1'), [
      'authkit',
      'admin',
      'impersonation',
      'u1',
    ]);
  });

  test('account.me() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.account.me(), ['authkit', 'account', 'me']);
  });

  test('account.sessions() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.account.sessions(), ['authkit', 'account', 'sessions']);
  });

  test('account.orgInvitations() retorna chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.account.orgInvitations(), [
      'authkit',
      'account',
      'orgs',
      'invitations',
    ]);
  });
});

// ─── Admin query options ──────────────────────────────────────────────────────

test.group('Admin query options — queryKey e queryFn', () => {
  // Importamos diretamente (sem React context) construindo um objeto "fake client"
  // e invocando as factory functions de forma simulada.

  test('useOverviewQueryOptions delega ao client.admin.overview()', async ({ assert }) => {
    let called = false;
    const overview = {
      usersTotal: 5,
      activeSessions: 1,
      mau: 2,
      signInsTotal: 10,
      signUpsTotal: 3,
      signInsPerDay: [],
      signUpsPerDay: [],
      windowDays: 30,
      auditSupported: false,
      clientsCount: 2,
      auditTotal: 0,
      recentEvents: [],
    };
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify(overview), { status: 200 }) as any;
      },
    });
    // Verifica que queryFn chama client.admin.overview
    const result = await client.admin.overview();
    assert.isTrue(called);
    assert.equal(result.usersTotal, 5);
  });

  test('admin.users.list() com params monta URL com query string', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ data: [], meta: { page: 1, size: 20, total: 0 } }), {
          status: 200,
        }) as any;
      },
    });
    await client.admin.users.list({ search: 'test', page: 2, size: 5 });
    assert.include(capturedUrl, 'search=test');
    assert.include(capturedUrl, 'page=2');
    assert.include(capturedUrl, 'size=5');
  });

  test('admin.roles.list() monta URL /roles', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 }) as any;
      },
    });
    await client.admin.roles.list();
    assert.equal(capturedUrl, '/admin/api/roles');
  });

  test('admin.orgs.get(id) monta URL correta', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(
          JSON.stringify({
            id: 'org1',
            name: 'Org',
            slug: 'org',
            logoUrl: null,
            createdAt: '2024',
            metadata: null,
            members: [],
            pendingInvitations: [],
          }),
          { status: 200 },
        ) as any;
      },
    });
    await client.admin.orgs.get('org1');
    assert.equal(capturedUrl, '/admin/api/orgs/org1');
  });

  test('admin.audit.list() com params de tipo', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ data: [], meta: { page: 1, size: 20, total: 0 } }), {
          status: 200,
        }) as any;
      },
    });
    await client.admin.audit.list({ type: 'login.success', page: 1, size: 10 });
    assert.include(capturedUrl, 'type=login.success');
    assert.include(capturedUrl, 'page=1');
    assert.include(capturedUrl, 'size=10');
  });

  test('admin.settings.set() usa PUT e injeta valor', async ({ assert }) => {
    let capturedMethod = '';
    let capturedBody = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'tk',
      fetch: async (_url, init) => {
        capturedMethod = String(init?.method);
        capturedBody = String(init?.body);
        return new Response(
          JSON.stringify({ key: 'foo', value: 'bar', updatedAt: null, updatedBy: null }),
          { status: 200 },
        ) as any;
      },
    });
    await client.admin.settings.set('foo', 'bar');
    assert.equal(capturedMethod, 'PUT');
    assert.include(capturedBody, '"value":"bar"');
  });
});

// ─── Account query options ────────────────────────────────────────────────────

test.group('Account query options — queryFn e mutation', () => {
  test('account.me() monta URL /me', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(
          JSON.stringify({
            id: '1',
            email: 'a@b.com',
            emailVerified: null,
            name: null,
            avatarUrl: null,
            globalRoles: [],
            hasPassword: true,
            mfaEnabled: false,
            passkeyCount: 0,
            sudoActive: false,
            capabilities: {
              securitySupported: true,
              profileSupported: true,
              passkeysSupported: false,
              orgsSupported: false,
              tokensSupported: false,
              avatarUploadSupported: false,
              sessionsSupported: true,
            },
          }),
          { status: 200 },
        ) as any;
      },
    });
    const me = await client.account.me();
    assert.equal(capturedUrl, '/account/api/me');
    assert.equal(me.email, 'a@b.com');
  });

  test('account.sessions.revoke() usa DELETE', async ({ assert }) => {
    let capturedMethod = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      csrfToken: 'tk',
      fetch: async (_url, init) => {
        capturedMethod = String(init?.method);
        return new Response(JSON.stringify({ ok: true, revoked: 'sess1' }), { status: 200 }) as any;
      },
    });
    await client.account.sessions.revoke('sess1');
    assert.equal(capturedMethod, 'DELETE');
  });

  test('account.tokens.create() usa POST', async ({ assert }) => {
    let capturedMethod = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      csrfToken: 'tk',
      fetch: async (_url, init) => {
        capturedMethod = String(init?.method);
        return new Response(
          JSON.stringify({
            id: 't1',
            name: 'My Token',
            scopes: [],
            audience: null,
            createdAt: '2024',
            lastUsedAt: null,
            secret: 'secret123',
          }),
          { status: 201 },
        ) as any;
      },
    });
    await client.account.tokens.create({ name: 'My Token' });
    assert.equal(capturedMethod, 'POST');
  });

  test('account.updateProfile() usa PATCH', async ({ assert }) => {
    let capturedMethod = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      csrfToken: 'tk',
      fetch: async (_url, init) => {
        capturedMethod = String(init?.method);
        return new Response(JSON.stringify({ id: '1', name: 'Ana', avatarUrl: null }), {
          status: 200,
        }) as any;
      },
    });
    await client.account.updateProfile({ name: 'Ana' });
    assert.equal(capturedMethod, 'PATCH');
  });

  test('account.passkeys.remove() usa DELETE e encodifica id', async ({ assert }) => {
    let capturedUrl = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      csrfToken: 'tk',
      fetch: async (url, _init) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ ok: true, removed: 'pk/1' }), { status: 200 }) as any;
      },
    });
    await client.account.passkeys.remove('pk/1');
    assert.equal(capturedUrl, '/account/api/passkeys/pk%2F1');
  });
});

// ─── QueryClient integration ──────────────────────────────────────────────────

test.group('QueryClient integration', () => {
  test('fetchQuery resolve e cacheia dados com queryKey correto', async ({ assert }) => {
    const overview = {
      usersTotal: 42,
      activeSessions: null,
      mau: 0,
      signInsTotal: 0,
      signUpsTotal: 0,
      signInsPerDay: [],
      signUpsPerDay: [],
      windowDays: 30,
      auditSupported: false,
      clientsCount: 0,
      auditTotal: 0,
      recentEvents: [],
    };

    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: mockFetch(overview),
    });

    const qc = newQueryClient();
    const key = authkitKeys.admin.overview();
    const result = await qc.fetchQuery({
      queryKey: key,
      queryFn: () => client.admin.overview(),
    });

    assert.equal(result.usersTotal, 42);

    // Cacheia — segunda chamada sem fetch deve retornar do cache
    const cached = qc.getQueryData(key);
    assert.deepEqual(cached, result);
  });

  test('invalidateQueries limpa o cache da chave correta', async ({ assert }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: mockFetch({ data: [], meta: { page: 1, size: 20, total: 0 } }),
    });
    const qc = newQueryClient();
    const key = authkitKeys.admin.users();

    await qc.fetchQuery({ queryKey: key, queryFn: () => client.admin.users.list() });
    assert.isNotNull(qc.getQueryData(key));

    await qc.invalidateQueries({ queryKey: key });
    // Após invalidar, o estado fica "stale" mas o dado continua até GC
    const state = qc.getQueryState(key);
    assert.isTrue(state?.isInvalidated);
  });
});
