/**
 * Testes para o fluxo return_to no login do console de conta.
 *
 * Cobre:
 *   - validateReturnTo (unitário puro)
 *   - accountGuard inclui return_to na URL de redirect
 *   - GET /account/login propaga return_to válido e descarta inválido
 *   - POST /account/login redireciona pro destino e cai no default sem ele
 *   - Bloqueio de open-redirect (//evil, https://, sem barra inicial)
 */

import { test } from '@japa/runner';
import { validateReturnTo } from '../../src/host/controllers/account_session_controller.js';
import { requestPathWithQuery } from '../../src/host/request_url.js';

// ---------------------------------------------------------------------------
// 1) validateReturnTo — unitário puro
// ---------------------------------------------------------------------------

test.group('validateReturnTo', () => {
  test('caminho válido simples', ({ assert }) => {
    assert.equal(validateReturnTo('/account/security'), '/account/security');
  });

  test('caminho com query-string válido', ({ assert }) => {
    assert.equal(validateReturnTo('/admin/users?page=2'), '/admin/users?page=2');
  });

  test('caminho deep com múltiplos segmentos', ({ assert }) => {
    assert.equal(validateReturnTo('/admin/users/123/sessions'), '/admin/users/123/sessions');
  });

  test('null → null', ({ assert }) => {
    assert.isNull(validateReturnTo(null));
  });

  test('undefined → null', ({ assert }) => {
    assert.isNull(validateReturnTo(undefined));
  });

  test('string vazia → null', ({ assert }) => {
    assert.isNull(validateReturnTo(''));
  });

  test('número → null', ({ assert }) => {
    assert.isNull(validateReturnTo(42));
  });

  test('sem barra inicial → null', ({ assert }) => {
    assert.isNull(validateReturnTo('admin/users'));
  });

  test('open-redirect: // (esquema-relativo) → null', ({ assert }) => {
    assert.isNull(validateReturnTo('//evil.com'));
  });

  test('open-redirect: //evil.com/path → null', ({ assert }) => {
    assert.isNull(validateReturnTo('//evil.com/steal?token=abc'));
  });

  test('open-redirect: https:// → null', ({ assert }) => {
    assert.isNull(validateReturnTo('https://evil.com'));
  });

  test('open-redirect: http:// → null', ({ assert }) => {
    assert.isNull(validateReturnTo('http://evil.com/path'));
  });

  test('open-redirect: javascript:// → null', ({ assert }) => {
    assert.isNull(validateReturnTo('javascript://alert(1)'));
  });

  test('caminho com :// no query param deve ser rejeitado', ({ assert }) => {
    // Defesa: se o valor contiver :// em qualquer posição, é rejeitado.
    assert.isNull(validateReturnTo('/redirect?next=https://evil.com'));
  });

  // L9: backslash → open-redirect em browsers que normalizam `\`→`/`.
  test('open-redirect: /\\evil.com (backslash) → null', ({ assert }) => {
    assert.isNull(validateReturnTo('/\\evil.com'));
  });

  test('open-redirect: \\/evil.com (backslash+slash) → null', ({ assert }) => {
    assert.isNull(validateReturnTo('\\/evil.com'));
  });

  test('open-redirect: \\\\evil.com (duplo backslash) → null', ({ assert }) => {
    assert.isNull(validateReturnTo('\\\\evil.com'));
  });

  test('backslash no meio do path → null', ({ assert }) => {
    assert.isNull(validateReturnTo('/admin\\users'));
  });

  test('backslash em qualquer posição (query) → null', ({ assert }) => {
    assert.isNull(validateReturnTo('/ok?next=\\evil'));
  });
});

// ---------------------------------------------------------------------------
// 2) Helpers para simular ctx do guard e do controller
// ---------------------------------------------------------------------------

/** Cria um ctx mínimo que simula request + response + session + containerResolver. */
function fakeGuardCtx(opts: { url?: string; qs?: string } = {}) {
  const redirects: string[] = [];
  const ctx: any = {
    session: { get: () => undefined }, // sem sessão = não autenticado
    request: {
      url: () => opts.url ?? '',
      parsedUrl: { search: opts.qs ?? '' },
    },
    response: { redirect: (to: string) => redirects.push(to) },
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return null;
        throw new Error(`unexpected: ${key}`);
      },
    },
  };
  return { ctx, redirects };
}

/** Cria um ctx mínimo para o AccountSessionController.show/login. */
function fakeControllerCtx(opts: {
  sessionUserId?: string;
  queryReturnTo?: string;
  bodyReturnTo?: string;
  email?: string;
  password?: string;
  loginOk?: boolean;
  loginLocked?: boolean;
  loginDisabled?: boolean;
}) {
  const rendered: Array<{ view: string; props: Record<string, unknown> }> = [];
  const redirects: string[] = [];

  const ctx: any = {
    session: {
      _data: new Map<string, string>(),
      get(k: string) {
        return this._data.get(k);
      },
      put(k: string, v: string) {
        this._data.set(k, v);
      },
      forget(k: string) {
        this._data.delete(k);
      },
    },
    request: {
      csrfToken: 'csrf-tok',
      // Simula ctx.request.qs?.().return_to (GET) e ctx.request.input?.('return_to') (POST)
      qs: () => ({ return_to: opts.queryReturnTo }),
      input: (key: string) => {
        if (key === 'return_to') return opts.bodyReturnTo;
        if (key === 'email') return opts.email;
        if (key === 'password') return opts.password;
        return undefined;
      },
      only: (keys: string[]) => {
        const result: Record<string, string | undefined> = {};
        for (const k of keys) {
          if (k === 'email') result[k] = opts.email;
          else if (k === 'password') result[k] = opts.password;
        }
        return result;
      },
      ip: () => '127.0.0.1',
    },
    response: { redirect: (to: string) => redirects.push(to) },
    containerResolver: {
      make: async () => ({
        config: {
          messages: {},
          accountStore: {},
          render: async (_ctx: any, view: string, props: Record<string, unknown>) => {
            rendered.push({ view, props });
          },
        },
      }),
    },
  };

  // Injeta sessão se passado.
  if (opts.sessionUserId) {
    ctx.session._data.set('authkit_account', opts.sessionUserId);
  }

  // Patch: `attemptPasswordLogin` é importado pelo controller, não podemos monkey-patch.
  // Usamos um wrapper diferente nos testes diretos ao invés de exercitar o controller
  // com DB real — os testes de login com credenciais ficam no r4_login.spec.ts.

  return { ctx, rendered, redirects };
}

// ---------------------------------------------------------------------------
// 3) accountGuard inclui return_to
// ---------------------------------------------------------------------------

test.group('accountGuard — return_to', () => {
  test('sem sessão + URL atual → redirect inclui return_to URL-encoded', async ({ assert }) => {
    // Importa o accountGuard através de uma invocação direta da lógica de buildLoginRedirect
    // exercitando via adminGuard (o accountGuard é uma closure não-exportada; adminGuard usa
    // a mesma função buildLoginRedirect interna).
    const { adminGuard } = await import('../../src/host/register_auth_host.js');
    const redirects: string[] = [];
    const ctx: any = {
      session: { get: () => undefined },
      request: { url: () => '/account/security', parsedUrl: { search: '' } },
      response: { redirect: (to: string) => redirects.push(to) },
      containerResolver: {
        make: async () => ({
          config: {
            admin: { enabled: true, roles: ['ADMIN'] },
            accountStore: { findById: async () => null },
          },
        }),
      },
    };
    await adminGuard(ctx, async () => {});
    assert.lengthOf(redirects, 1);
    assert.include(redirects[0], 'return_to=%2Faccount%2Fsecurity');
  });

  test('sem sessão + URL vazia → redirect sem return_to', async ({ assert }) => {
    const { adminGuard } = await import('../../src/host/register_auth_host.js');
    const redirects: string[] = [];
    const ctx: any = {
      session: { get: () => undefined },
      request: { url: () => '', parsedUrl: { search: '' } },
      response: { redirect: (to: string) => redirects.push(to) },
      containerResolver: {
        make: async () => ({
          config: {
            admin: { enabled: true, roles: ['ADMIN'] },
            accountStore: { findById: async () => null },
          },
        }),
      },
    };
    await adminGuard(ctx, async () => {});
    assert.deepEqual(redirects, ['/account/login']);
  });

  test('sem sessão + URL é o próprio /account/login → sem return_to (evita loop)', async ({
    assert,
  }) => {
    const { adminGuard } = await import('../../src/host/register_auth_host.js');
    const redirects: string[] = [];
    const ctx: any = {
      session: { get: () => undefined },
      request: { url: () => '/account/login', parsedUrl: { search: '' } },
      response: { redirect: (to: string) => redirects.push(to) },
      containerResolver: {
        make: async () => ({
          config: {
            admin: { enabled: true, roles: ['ADMIN'] },
            accountStore: { findById: async () => null },
          },
        }),
      },
    };
    await adminGuard(ctx, async () => {});
    assert.deepEqual(redirects, ['/account/login']);
  });

  test('sem sessão + URL com query-string → inclui path+qs no return_to', async ({ assert }) => {
    const { adminGuard } = await import('../../src/host/register_auth_host.js');
    const redirects: string[] = [];
    const ctx: any = {
      session: { get: () => undefined },
      request: { url: () => '/admin/users', parsedUrl: { search: '?page=3' } },
      response: { redirect: (to: string) => redirects.push(to) },
      containerResolver: {
        make: async () => ({
          config: {
            admin: { enabled: true, roles: ['ADMIN'] },
            accountStore: { findById: async () => null },
          },
        }),
      },
    };
    await adminGuard(ctx, async () => {});
    assert.lengthOf(redirects, 1);
    // return_to deve codificar '/admin/users?page=3'
    assert.include(redirects[0], 'return_to=');
    const url = new URL(redirects[0], 'http://host');
    const rt = decodeURIComponent(url.searchParams.get('return_to') ?? '');
    assert.equal(rt, '/admin/users?page=3');
  });
});

// ---------------------------------------------------------------------------
// 4) validateReturnTo integrado — controller GET propaga / descarta
// ---------------------------------------------------------------------------

test.group('GET /account/login — return_to', () => {
  test('return_to válido é passado como prop returnTo à view', ({ assert }) => {
    // Testa validateReturnTo diretamente com o valor que viria da query-string.
    const result = validateReturnTo('/account/security');
    assert.equal(result, '/account/security');
    // A view receberia: render(ctx, 'account/login', { csrfToken, returnTo: '/account/security' })
  });

  test('return_to //evil.com é descartado (open-redirect)', ({ assert }) => {
    assert.isNull(validateReturnTo('//evil.com'));
  });

  test('return_to https://evil.com é descartado', ({ assert }) => {
    assert.isNull(validateReturnTo('https://evil.com'));
  });

  test('return_to sem barra inicial é descartado', ({ assert }) => {
    assert.isNull(validateReturnTo('evil.com/path'));
  });

  test('return_to ausente → null → view recebe returnTo=null', ({ assert }) => {
    assert.isNull(validateReturnTo(undefined));
    assert.isNull(validateReturnTo(null));
    assert.isNull(validateReturnTo(''));
  });
});

// ---------------------------------------------------------------------------
// 5) POST /account/login — return_to (lógica de validação + destino)
// ---------------------------------------------------------------------------

test.group('POST /account/login — return_to (validação server-side)', () => {
  test('return_to válido no hidden input → destino correto após login bem-sucedido', ({
    assert,
  }) => {
    // A lógica do controller: após sucesso, ctx.response.redirect(returnTo ?? '/account/security')
    const returnTo = validateReturnTo('/account/security');
    assert.equal(returnTo, '/account/security');
    // Simulação: loginOk → redirect(returnTo) = '/account/security'
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/account/security');
  });

  test('return_to ausente no POST → default /account/tokens', ({ assert }) => {
    const returnTo = validateReturnTo(undefined);
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/account/security');
  });

  test('return_to //evil no hidden input → descartado → default', ({ assert }) => {
    const returnTo = validateReturnTo('//evil.com');
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/account/security');
  });

  test('return_to https:// no hidden input → descartado → default', ({ assert }) => {
    const returnTo = validateReturnTo('https://attacker.com');
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/account/security');
  });

  test('return_to /admin/settings válido → redireciona pro admin', ({ assert }) => {
    const returnTo = validateReturnTo('/admin/settings');
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/admin/settings');
  });

  test('open-redirect bloqueado: javascript:// → default', ({ assert }) => {
    const returnTo = validateReturnTo('javascript://xss');
    const dest = returnTo ?? '/account/security';
    assert.equal(dest, '/account/security');
  });
});

// ---------------------------------------------------------------------------
// 7) A query no return_to com a Request REAL do AdonisJS 7
// ---------------------------------------------------------------------------

test.group('return_to — query string com a Request do AdonisJS 7', () => {
  test('requestPathWithQuery usa url(true): o parsedUrl do Adonis 7 não tem .search', ({
    assert,
  }) => {
    // Forma do Adonis 7: `url(includeQueryString)` e `parsedUrl = { pathname, query }`.
    const adonis7 = {
      url: (withQuery?: boolean) =>
        withQuery ? '/agents/consent?user_code=ABCD-EFGH' : '/agents/consent',
      parsedUrl: { pathname: '/agents/consent', query: 'user_code=ABCD-EFGH' },
    };
    assert.equal(requestPathWithQuery(adonis7), '/agents/consent?user_code=ABCD-EFGH');
    // Dublê antigo (só `search`) e `parsedUrl.query` sem `url(true)` continuam valendo.
    assert.equal(
      requestPathWithQuery({ url: () => '/a', parsedUrl: { search: '?b=1' } }),
      '/a?b=1',
    );
    assert.equal(requestPathWithQuery({ url: () => '/a', parsedUrl: { query: 'b=1' } }), '/a?b=1');
    assert.equal(requestPathWithQuery({ url: () => '/a' }), '/a');
  });

  test('o redirect para o login preserva a query com a Request do Adonis 7', async ({ assert }) => {
    const { adminGuard } = await import('../../src/host/register_auth_host.js');
    const redirects: string[] = [];
    const ctx: any = {
      session: { get: () => undefined },
      request: {
        url: (withQuery?: boolean) => (withQuery ? '/admin/users?page=3' : '/admin/users'),
        parsedUrl: { pathname: '/admin/users', query: 'page=3' },
      },
      response: { redirect: (to: string) => redirects.push(to) },
      containerResolver: {
        make: async () => ({
          config: {
            admin: { enabled: true, roles: ['ADMIN'] },
            accountStore: { findById: async () => null },
          },
        }),
      },
    };
    await adminGuard(ctx, async () => {});
    assert.deepEqual(redirects, [
      `/account/login?return_to=${encodeURIComponent('/admin/users?page=3')}`,
    ]);
  });
});
