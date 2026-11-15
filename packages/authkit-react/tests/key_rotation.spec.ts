/**
 * Testes do componente KeyRotation e dos hooks relacionados.
 *
 * Seguindo o padrão headless do projeto (sem DOM): verifica exports,
 * query keys, e que o client.admin.keys.{status,rotate} funciona.
 */
import { test } from '@japa/runner';
import { createAuthkitClient } from '../src/client/client.js';
import { KeyRotation } from '../src/components/key_rotation.js';
import { authkitKeys } from '../src/queries/keys.js';

test.group('KeyRotation — export', () => {
  test('KeyRotation é uma função', ({ assert }) => {
    assert.isFunction(KeyRotation);
  });
});

test.group('authkitKeys.admin.keys()', () => {
  test('retorna a chave correta', ({ assert }) => {
    assert.deepEqual(authkitKeys.admin.keys(), ['authkit', 'admin', 'keys']);
  });
});

test.group('client.admin.keys', () => {
  test('keys.status() faz GET em /keys', async ({ assert }) => {
    let capturedUrl = '';
    const statusPayload = {
      ageDays: 7,
      policy: { enabled: true, maxAgeDays: 90, keep: 2 },
      nextRotationInDays: 83,
    };
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(statusPayload), { status: 200 }) as any;
      },
    });
    const result = await client.admin.keys.status();
    assert.equal(capturedUrl, '/admin/api/keys');
    assert.equal(result.ageDays, 7);
    assert.isTrue(result.policy.enabled);
    assert.equal(result.nextRotationInDays, 83);
  });

  test('keys.rotate() faz POST em /keys/rotate com body', async ({ assert }) => {
    let capturedMethod = '';
    let capturedUrl = '';
    let capturedBody = '';
    const rotatePayload = {
      rotated: true,
      newKid: 'kid-new',
      retiredKids: ['kid-old'],
      keptKids: [],
    };
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'tok',
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedMethod = String(init?.method);
        capturedBody = String(init?.body);
        return new Response(JSON.stringify(rotatePayload), { status: 200 }) as any;
      },
    });
    const result = await client.admin.keys.rotate({ retire: true });
    assert.equal(capturedUrl, '/admin/api/keys/rotate');
    assert.equal(capturedMethod, 'POST');
    assert.include(capturedBody, '"retire":true');
    assert.isTrue(result.rotated);
    assert.equal(result.newKid, 'kid-new');
  });

  test('keys.rotate() aceita input undefined (sem body retire)', async ({ assert }) => {
    let capturedBody = '';
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      csrfToken: 'tok',
      fetch: async (_url, init) => {
        capturedBody = String(init?.body);
        return new Response(
          JSON.stringify({ rotated: true, newKid: 'k', retiredKids: [], keptKids: [] }),
          { status: 200 },
        ) as any;
      },
    });
    await client.admin.keys.rotate();
    // sem retire no body (ou body vazio)
    assert.notInclude(capturedBody, '"retire":true');
  });
});

test.group('KeyRotation — jwks.readOnly', () => {
  async function renderWith(status: Record<string, unknown>) {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { AuthkitClientProvider } = await import('../src/client/context.js');
    const { createElementWithChildren } = await import('./helpers/create_element.js');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(authkitKeys.admin.keys(), status);
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      fetch: async () => {
        throw new Error('no fetch during SSR render');
      },
    });
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElementWithChildren(AuthkitClientProvider, { client }, createElement(KeyRotation)),
      ),
    );
  }
  const base = {
    ageDays: 3,
    policy: { enabled: true, maxAgeDays: 90, keep: 2 },
    nextRotationInDays: null,
    keys: [],
  };

  test('a writer instance shows the rotate action', async ({ assert }) => {
    const html = await renderWith({ ...base, readOnly: false });
    assert.include(html, 'Rotacionar agora');
    assert.notInclude(html, 'authkit-keys__read-only');
  });

  test('a read-only instance hides rotate and says where to rotate', async ({ assert }) => {
    const html = await renderWith({ ...base, readOnly: true });
    assert.notInclude(html, 'Rotacionar agora');
    assert.notInclude(html, 'Aposentar as chaves antigas');
    assert.include(html, 'authkit-keys__read-only');
  });
});
