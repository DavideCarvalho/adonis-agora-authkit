/**
 * Testes do AuthkitClient tipado.
 *
 * Cobre:
 * - monta URL correta (base + path)
 * - injeta CSRF apenas em métodos mutating
 * - parseia erro corretamente (com e sem envelope)
 * - SSR-guard: lança quando não há window nem opts.baseUrl
 * - 204/body vazio retorna null sem lançar
 */

import { test } from '@japa/runner';
import { AuthkitClientError, createAuthkitClient } from '../src/client/client.js';

// ─── Mock de fetch ────────────────────────────────────────────────────────────

function makeFetch(status: number, body: unknown, headers?: Record<string, string>): typeof fetch {
  return async (_input, _init) => {
    const bodyText = body === null ? '' : JSON.stringify(body);
    return new Response(bodyText || null, {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    }) as any;
  };
}

function captureFetch(): { calls: { url: string; init: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 }) as any;
  };
  return { calls, fetch: mockFetch };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

test.group('AuthkitClient — URL construction', () => {
  test('monta URL correta para admin.overview()', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.overview();
    assert.equal(calls[0].url, '/admin/api/overview');
  });

  test('monta URL com id encodado para admin.users.get()', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.users.get('user/with/slashes');
    assert.equal(calls[0].url, '/admin/api/users/user%2Fwith%2Fslashes');
  });

  test('monta URL de account.me() com accountBaseUrl customizado', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/custom/account',
      fetch: mockFetch,
    });
    await client.account.me();
    assert.equal(calls[0].url, '/custom/account/me');
  });

  test('monta query string em users.list()', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.users.list({ search: 'ana', page: 2, size: 10 });
    const url = calls[0].url;
    assert.include(url, 'search=ana');
    assert.include(url, 'page=2');
    assert.include(url, 'size=10');
  });

  test('omite params undefined da query string', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.users.list({ search: undefined, page: 1 });
    assert.notInclude(calls[0].url, 'search');
    assert.include(calls[0].url, 'page=1');
  });
});

test.group('AuthkitClient — CSRF injection', () => {
  test('injeta X-CSRF-TOKEN em POST', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'my-token',
      fetch: mockFetch,
    });
    await client.admin.users.create({ email: 'a@b.com' });
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-CSRF-TOKEN'], 'my-token');
  });

  test('injeta X-CSRF-TOKEN em PATCH', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'my-token',
      fetch: mockFetch,
    });
    await client.admin.users.update('123', { name: 'Ana' });
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-CSRF-TOKEN'], 'my-token');
  });

  test('injeta X-CSRF-TOKEN em DELETE', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'my-token',
      fetch: mockFetch,
    });
    await client.admin.users.remove('123');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-CSRF-TOKEN'], 'my-token');
  });

  test('NÃO injeta X-CSRF-TOKEN em GET', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'my-token',
      fetch: mockFetch,
    });
    await client.admin.overview();
    const headers = calls[0].init.headers as Record<string, string>;
    assert.isUndefined(headers['X-CSRF-TOKEN']);
  });

  test('não inclui CSRF quando token não configurado', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.users.create({ email: 'a@b.com' });
    const headers = calls[0].init.headers as Record<string, string>;
    assert.isUndefined(headers['X-CSRF-TOKEN']);
  });
});

test.group('AuthkitClient — error parsing', () => {
  test('lança AuthkitClientError com status e code do envelope', async ({ assert }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: makeFetch(404, { error: { code: 'not_found', message: 'Usuário não encontrado.' } }),
    });
    try {
      await client.admin.users.get('999');
      assert.fail('should have thrown');
    } catch (err) {
      assert.instanceOf(err, AuthkitClientError);
      const e = err as AuthkitClientError;
      assert.equal(e.status, 404);
      assert.equal(e.code, 'not_found');
      assert.equal(e.message, 'Usuário não encontrado.');
    }
  });

  test('lança AuthkitClientError 401 com isUnauthorized=true', async ({ assert }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: makeFetch(401, { error: { code: 'unauthorized', message: 'Not authenticated.' } }),
    });
    try {
      await client.account.me();
      assert.fail('should have thrown');
    } catch (err) {
      assert.instanceOf(err, AuthkitClientError);
      const e = err as AuthkitClientError;
      assert.equal(e.status, 401);
      assert.isTrue(e.isUnauthorized);
    }
  });

  test('lança AuthkitClientError sem envelope (corpo vazio/não-JSON)', async ({ assert }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async () => new Response('Internal Server Error', { status: 500 }) as any,
    });
    try {
      await client.admin.overview();
      assert.fail('should have thrown');
    } catch (err) {
      assert.instanceOf(err, AuthkitClientError);
      const e = err as AuthkitClientError;
      assert.equal(e.status, 500);
      assert.include(e.message, '500');
    }
  });

  test('retorna null para 204 sem corpo', async ({ assert }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async () => new Response(null, { status: 204 }) as any,
    });
    // admin.settings.remove retorna 204-style (objeto JSON vazio normalmente)
    const result = await client.admin.settings.remove('some_key');
    assert.isNull(result);
  });
});

test.group('AuthkitClient — SSR guard', () => {
  test('construtor NÃO lança em SSR sem baseUrl (montagem do tree é safe)', ({ assert }) => {
    // Regressão: o construtor lançava em SSR e derrubava o render das telas
    // self-service (que só usam account.*). Agora é lazy.
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = undefined;
    try {
      assert.doesNotThrow(() => createAuthkitClient({ accountBaseUrl: '/account/api' }));
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  test('lança ao chamar admin.* sem baseUrl resolvido', async ({ assert }) => {
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = undefined;
    try {
      const client = createAuthkitClient({ accountBaseUrl: '/account/api' });
      await assert.rejects(() => client.admin.overview(), /admin base URL ausente/);
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  test('não lança quando baseUrl é fornecido (SSR explícito)', ({ assert }) => {
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = undefined;
    try {
      assert.doesNotThrow(() =>
        createAuthkitClient({
          baseUrl: '/admin/api',
          fetch: async () => new Response('{}', { status: 200 }) as any,
        }),
      );
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as any).window = originalWindow;
      }
    }
  });
});

test.group('AuthkitClient — credentials', () => {
  test('inclui credentials:include em toda request', async ({ assert }) => {
    const { calls, fetch: mockFetch } = captureFetch();
    const client = createAuthkitClient({ baseUrl: '/admin/api', fetch: mockFetch });
    await client.admin.overview();
    assert.equal(calls[0].init.credentials, 'include');
  });
});

test.group('AuthkitClient — fetch binding', () => {
  test('default fetch é bindado ao globalThis (sem Illegal invocation)', async ({ assert }) => {
    // Regressão: globalThis.fetch exige `this === Window`. Guardado desbindado e
    // chamado via this._fetch(...) lança "Illegal invocation" no browser.
    const original = globalThis.fetch;
    try {
      globalThis.fetch = function (this: unknown) {
        if (this !== globalThis && this !== undefined) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        }
        return Promise.resolve(new Response('{}', { status: 200 })) as any;
      } as typeof fetch;
      const client = createAuthkitClient({ baseUrl: '/admin/api' });
      await assert.doesNotReject(() => client.admin.overview());
    } finally {
      globalThis.fetch = original;
    }
  });
});
