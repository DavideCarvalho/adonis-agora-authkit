import { test } from '@japa/runner';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { edgeRenderer } from '../../src/host/renderers/edge_renderer.js';
import { inertiaRenderer } from '../../src/host/renderers/inertia_renderer.js';

/**
 * Cria um ctx mínimo com suporte a Edge + Inertia simultaneamente.
 * Isso permite exercitar os dois caminhos (fallback edge e happy-path inertia)
 * sem ctx separado.
 */
function makeCtx() {
  const inertiaCalls: any[] = [];
  const edgeCalls: any[] = [];
  const ctx = {
    inertia: { render: (name: string, props: any) => inertiaCalls.push([name, props]) },
    view: { render: (name: string, props: any) => edgeCalls.push([name, props]) },
  } as any;
  return { ctx, inertiaCalls, edgeCalls };
}

test.group('renderers', () => {
  test('inertiaRenderer chama ctx.inertia.render com prefixo + messages', async ({ assert }) => {
    const { ctx, inertiaCalls } = makeCtx();
    await inertiaRenderer({ prefix: 'authkit', views: ['login'] })(ctx, 'login', { uid: 'x' });
    assert.equal(inertiaCalls[0][0], 'authkit/login');
    assert.equal(inertiaCalls[0][1].uid, 'x');
    // Sem container/serviço, cai no default pt-BR embutido como shared prop.
    assert.deepEqual(inertiaCalls[0][1].messages, { ...DEFAULT_MESSAGES });
  });

  test('edgeRenderer chama ctx.view.render com namespace authkit:: + helper t', async ({
    assert,
  }) => {
    const { ctx, edgeCalls } = makeCtx();
    await edgeRenderer()(ctx, 'account/tokens', { a: 1 });
    assert.equal(edgeCalls[0][0], 'authkit::account/tokens');
    assert.equal(edgeCalls[0][1].a, 1);
    // `t` é exposto às views e traduz a partir do default em inglês.
    assert.isFunction(edgeCalls[0][1].t);
    assert.equal(edgeCalls[0][1].t('account.tokens.create'), 'Create');
    assert.equal(edgeCalls[0][1].t('login.greeting', { name: 'Ana' }), 'Hi, Ana');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Allowlist: `views` fornecido → view listada vai ao Inertia, não listada vai ao Edge.
  // ───────────────────────────────────────────────────────────────────────────

  test('inertiaRenderer com views: view listada vai ao Inertia', async ({ assert }) => {
    const { ctx, inertiaCalls, edgeCalls } = makeCtx();
    await inertiaRenderer({ prefix: 'authkit', views: ['login', 'signup'] })(ctx, 'login', {
      uid: 'y',
    });
    assert.equal(inertiaCalls[0][0], 'authkit/login');
    assert.equal(inertiaCalls[0][1].uid, 'y');
    assert.lengthOf(edgeCalls, 0);
  });

  test('inertiaRenderer com views: view NÃO listada vai ao Edge (fallback silencioso)', async ({
    assert,
  }) => {
    const { ctx, inertiaCalls, edgeCalls } = makeCtx();
    // 'account/security' não está na lista → fallback Edge.
    await inertiaRenderer({ prefix: 'authkit', views: ['login', 'account/tokens'] })(
      ctx,
      'account/security',
      { csrfToken: 'tok' },
    );
    assert.lengthOf(inertiaCalls, 0);
    assert.equal(edgeCalls[0][0], 'authkit::account/security');
    assert.equal(edgeCalls[0][1].csrfToken, 'tok');
  });

  test('inertiaRenderer com views: maintenance não listada → Edge', async ({ assert }) => {
    const { ctx, inertiaCalls, edgeCalls } = makeCtx();
    await inertiaRenderer({ prefix: 'authkit', views: ['login'] })(ctx, 'maintenance', {});
    assert.lengthOf(inertiaCalls, 0);
    assert.equal(edgeCalls[0][0], 'authkit::maintenance');
  });
});
