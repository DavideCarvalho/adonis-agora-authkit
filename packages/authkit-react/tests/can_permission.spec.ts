/**
 * Testes do gating por permissão da Authz: `checkCan`, `useCan` e
 * `<CanPermission>`. Contrato fixo: `POST <canPath>` com
 * `{ permission, resource? }` → `{ allowed }`.
 *
 * As partes que dependem de efeito assíncrono do React são cobertas via
 * `checkCan` (a lógica real de fetch/cache/dedupe). A renderização síncrona
 * (cache quente + ramo de `loading`) é coberta via `react-dom/server`.
 */
import { test } from '@japa/runner';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanPermission } from '../src/components/can_permission.js';
import { AuthkitConfigContext, resolveConfig } from '../src/config.js';
import { canCache, checkCan, invalidateCanCache, useCan } from '../src/hooks/use_can.js';
import { AuthProvider } from '../src/provider.js';
import type { AuthUser } from '../src/types.js';
import { createElementWithChildren } from './helpers/create_element.js';

/** Instala um `fetch` fake global e devolve as chamadas + restaurador. */
function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return {
    calls,
    restore() {
      globalThis.fetch = prev;
    },
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test.group('useCan/CanPermission — exports', () => {
  test('useCan e CanPermission são funções', ({ assert }) => {
    assert.isFunction(useCan);
    assert.isFunction(CanPermission);
  });
});

test.group('checkCan — contrato e fetch', (group) => {
  group.each.setup(() => {
    canCache.clear();
  });

  test('faz POST no path com { permission, resource } e credenciais', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      const allowed = await checkCan('/authz/can', 'posts.update', 'post:1');
      assert.isTrue(allowed);
      assert.lengthOf(fetchMock.calls, 1);
      const call = fetchMock.calls[0];
      assert.equal(call.url, '/authz/can');
      assert.equal(call.init?.method, 'POST');
      assert.equal(call.init?.credentials, 'same-origin');
      assert.deepEqual(JSON.parse(String(call.init?.body)), {
        permission: 'posts.update',
        resource: 'post:1',
      });
    } finally {
      fetchMock.restore();
    }
  });

  test('allowed:false → deny', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: false }));
    try {
      assert.isFalse(await checkCan('/authz/can', 'posts.delete'));
    } finally {
      fetchMock.restore();
    }
  });

  test('omite resource quando ausente', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      await checkCan('/authz/can', 'posts.read');
      assert.deepEqual(JSON.parse(String(fetchMock.calls[0].init?.body)), {
        permission: 'posts.read',
      });
    } finally {
      fetchMock.restore();
    }
  });

  test('memoiza o resultado por (path, permission, resource)', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      await checkCan('/authz/can', 'posts.update', 'post:1');
      await checkCan('/authz/can', 'posts.update', 'post:1');
      assert.lengthOf(fetchMock.calls, 1);
    } finally {
      fetchMock.restore();
    }
  });

  test('deduplica requests concorrentes', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      const [a, b] = await Promise.all([checkCan('/authz/can', 'x'), checkCan('/authz/can', 'x')]);
      assert.isTrue(a);
      assert.isTrue(b);
      assert.lengthOf(fetchMock.calls, 1);
    } finally {
      fetchMock.restore();
    }
  });

  test('chaves diferentes não colidem', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      await checkCan('/authz/can', 'a');
      await checkCan('/authz/can', 'b');
      await checkCan('/authz/can', 'a', 'r');
      assert.lengthOf(fetchMock.calls, 3);
    } finally {
      fetchMock.restore();
    }
  });
});

test.group('checkCan — discriminação por principal', (group) => {
  group.each.setup(() => {
    canCache.clear();
  });

  test('mudança de principal não serve a resposta do anterior', async ({ assert }) => {
    // Usuário A → permitido.
    const okFetch = installFetch(() => jsonResponse({ allowed: true }));
    try {
      assert.isTrue(await checkCan('/authz/can', 'posts.update', undefined, undefined, 'userA'));
      assert.lengthOf(okFetch.calls, 1);
      // Repetir como A serve do cache (sem novo fetch).
      assert.isTrue(await checkCan('/authz/can', 'posts.update', undefined, undefined, 'userA'));
      assert.lengthOf(okFetch.calls, 1);
    } finally {
      okFetch.restore();
    }

    // Troca para usuário B → mesma permissão é RE-buscada (não serve cache de A).
    const denyFetch = installFetch(() => jsonResponse({ allowed: false }));
    try {
      assert.isFalse(await checkCan('/authz/can', 'posts.update', undefined, undefined, 'userB'));
      assert.lengthOf(denyFetch.calls, 1);
    } finally {
      denyFetch.restore();
    }
  });

  test('logout (anon) não herda a decisão do usuário logado', async ({ assert }) => {
    const okFetch = installFetch(() => jsonResponse({ allowed: true }));
    try {
      assert.isTrue(await checkCan('/authz/can', 'x', undefined, undefined, 'userA'));
    } finally {
      okFetch.restore();
    }
    const denyFetch = installFetch(() => jsonResponse({ allowed: false }));
    try {
      // Sem principal explícito → sentinela 'anon': re-busca.
      assert.isFalse(await checkCan('/authz/can', 'x'));
      assert.lengthOf(denyFetch.calls, 1);
    } finally {
      denyFetch.restore();
    }
  });

  test('invalidateCanCache força refetch', async ({ assert }) => {
    const fetchMock = installFetch(() => jsonResponse({ allowed: true }));
    try {
      await checkCan('/authz/can', 'x', undefined, undefined, 'userA');
      assert.lengthOf(fetchMock.calls, 1);
      invalidateCanCache();
      await checkCan('/authz/can', 'x', undefined, undefined, 'userA');
      assert.lengthOf(fetchMock.calls, 2);
    } finally {
      fetchMock.restore();
    }
  });
});

test.group('useCan — render (cache quente / loading)', (group) => {
  group.each.setup(() => {
    canCache.clear();
  });

  function renderCanPermission(permission: string, opts: { resource?: string } = {}) {
    const config = resolveConfig();
    return renderToStaticMarkup(
      createElement(
        AuthkitConfigContext.Provider,
        { value: config },
        createElementWithChildren(
          CanPermission,
          {
            permission,
            resource: opts.resource,
            fallback: 'NO',
            loadingFallback: 'LOAD',
          },
          'YES',
        ),
      ),
    );
  }

  test('cache quente allowed → renderiza children (sem loading)', ({ assert }) => {
    canCache.resolved.set('anon|/authz/can|posts.update|', true);
    assert.equal(renderCanPermission('posts.update'), 'YES');
  });

  test('cache quente denied → renderiza fallback', ({ assert }) => {
    canCache.resolved.set('anon|/authz/can|posts.delete|', false);
    assert.equal(renderCanPermission('posts.delete'), 'NO');
  });

  test('sem cache → estado inicial loading (renderiza loadingFallback)', ({ assert }) => {
    assert.equal(renderCanPermission('posts.read'), 'LOAD');
  });

  function renderForUser(userId: string | null, permission: string) {
    const config = resolveConfig();
    const user: AuthUser | null =
      userId === null ? null : { id: userId, email: `${userId}@example.com`, globalRoles: [] };
    return renderToStaticMarkup(
      createElementWithChildren(
        AuthProvider,
        { value: { user, globalRoles: [] } },
        createElement(
          AuthkitConfigContext.Provider,
          { value: config },
          createElementWithChildren(
            CanPermission,
            { permission, fallback: 'NO', loadingFallback: 'LOAD' },
            'YES',
          ),
        ),
      ),
    );
  }

  test('cache do usuário A não vaza para o usuário B (re-checa → loading)', ({ assert }) => {
    // Resposta resolvida para o usuário A.
    canCache.resolved.set('userA|/authz/can|posts.update|', true);
    // A vê o cache quente.
    assert.equal(renderForUser('userA', 'posts.update'), 'YES');
    // B não herda a decisão de A → cai em loading (re-fetch).
    assert.equal(renderForUser('userB', 'posts.update'), 'LOAD');
    // Anônimo (logout) também não herda.
    assert.equal(renderForUser(null, 'posts.update'), 'LOAD');
  });
});
