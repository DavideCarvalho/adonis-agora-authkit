import { HttpContextFactory, RequestFactory, ResponseFactory } from '@adonisjs/core/factories/http';
import { test } from '@japa/runner';
import { redirectExact } from '../../src/host/redirect_exact.js';

/**
 * Regressão: o starter do AdonisJS liga `redirect.forwardQueryString: true`, e todo
 * `response.redirect(url)` colava a query da request atual no fim da URL que a lib montou —
 * `/login?return_to=%2Fx%3Fuser_code%3DA?user_code=A`. Achado com a tela de consentimento de
 * personal agents num app real: o login nunca voltava com o código.
 */
function ctxFor(url: string) {
  const request = new RequestFactory().merge({ url, method: 'GET' }).create();
  // A Response vê a MESMA request do Node que a Request — como num servidor de verdade.
  const response = new ResponseFactory()
    .merge({
      req: request.request,
      res: request.response,
      config: { redirect: { forwardQueryString: true } } as any,
    })
    .create();
  return new HttpContextFactory().merge({ request, response }).create();
}

test.group('redirectExact', () => {
  test('com forwardQueryString ligado no app, o destino sai exatamente como montado', ({
    assert,
  }) => {
    const ctx = ctxFor('/agents/consent?user_code=BCDF-GHJK');
    const target = `/auth/login?return_to=${encodeURIComponent('/agents/consent?user_code=BCDF-GHJK')}`;
    redirectExact(ctx.response, target);
    assert.equal(ctx.response.getHeader('location'), target);
  });

  test('o redirect cru do Adonis quebraria a mesma URL (é o que este helper evita)', ({
    assert,
  }) => {
    const ctx = ctxFor('/agents/consent?user_code=BCDF-GHJK');
    const target = `/auth/login?return_to=${encodeURIComponent('/agents/consent?user_code=BCDF-GHJK')}`;
    ctx.response.redirect(target);
    assert.notEqual(ctx.response.getHeader('location'), target);
  });

  test('fora de uma Response do Adonis (dublê), usa o redirect(url) de sempre', ({ assert }) => {
    const seen: string[] = [];
    redirectExact({ redirect: (url: string) => seen.push(url) }, '/x?y=1');
    assert.deepEqual(seen, ['/x?y=1']);
  });
});
