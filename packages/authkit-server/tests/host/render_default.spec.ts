import { fileURLToPath } from 'node:url';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import AccountSessionController from '../../src/host/controllers/account_session_controller.js';
import { fakeAccountStore } from '../bootstrap.js';

/**
 * Regression (ITEM 3 — `render` sem default): antes desta mudança,
 * `config/authkit.ts` sem `render: edgeRenderer()` deixava `cfg.render`
 * `undefined` — `account_session_controller.ts` fazia `cfg.render!` e chamava
 * `render(ctx, ...)`, que estourava `TypeError: render is not a function`, ou
 * seja, TODA request a `/account/*` (e `/auth/interaction/*`) virava um 500
 * sem nenhuma explicação. Não havia default de runtime.
 *
 * Este teste resolve um `defineConfig()` SEM passar `render` e chama o
 * controller REAL (`AccountSessionController#show`) com um `ctx` que usa uma
 * instância REAL de `Edge` (mesmo disco `authkit` que o provider monta em
 * produção) — provando que a página de login agora renderiza de verdade em
 * vez de estourar.
 */

async function resolveConfigWithoutRender() {
  const fakeApp = {
    container: { make: async () => ({ connection: () => ({}) }) },
  } as any;
  return configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: 'https://auth.test',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      // `render` OMITIDO DE PROPÓSITO — é exatamente o caso que quebrava.
    }),
  ) as Promise<any>;
}

function makeEdge() {
  const dir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
  const edge = new Edge();
  edge.mount('authkit', dir);
  return edge;
}

test.group('render default (ITEM 3)', () => {
  test('defineConfig() sem `render` resolve com um default de runtime (não fica undefined)', async ({
    assert,
  }) => {
    const cfg = await resolveConfigWithoutRender();
    assert.isFunction(cfg.render);
  });

  test('GET /account/login sem `render` configurado renderiza a view de verdade (não estoura 500)', async ({
    assert,
  }) => {
    const cfg = await resolveConfigWithoutRender();
    const edge = makeEdge();

    const ctx: any = {
      session: { get: () => undefined },
      request: {
        csrfToken: 'csrf-tok',
        // O default é entrar pelo IdP (redirect); o formulário de senha é o `?method=password`.
        qs: () => ({ return_to: undefined, method: 'password' }),
        input: () => undefined,
      },
      response: { redirect: () => {} },
      containerResolver: { make: async () => ({ config: cfg }) },
      view: edge,
    };

    const controller = new AccountSessionController();
    const html = await controller.show(ctx);

    assert.isString(html);
    assert.include(html as string, '/account/login');
    assert.include(html as string, 'name="_csrf"');
  });
});
