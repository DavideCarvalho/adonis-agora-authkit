import { test } from '@japa/runner';
import { createLogoutSources } from '../../src/provider/logout_sources.js';

/** Path público do asset — contrato com a rota registrada no register_auth_host. */
const ASSET_PATH = '/authkit/assets/logout.js';

test.group('logout sources (RP-initiated logout)', () => {
  test('logoutSource injeta o campo logout e referencia o asset same-origin, sem script inline', async ({
    assert,
  }) => {
    const { logoutSource } = createLogoutSources({});
    const ctx: any = { body: '' };
    const form =
      '<form id="op.logoutForm" method="post" action="/oidc/session/end/confirm"><input type="hidden" name="xsrf" value="secret"/></form>';

    await logoutSource(ctx, form);

    // O campo de confirmação é injetado dentro do form.
    assert.include(ctx.body, 'name="logout" value="yes"');
    // O form original (com o xsrf) é preservado.
    assert.include(ctx.body, 'name="xsrf" value="secret"');
    // O fallback <noscript> continua (acessibilidade sem JS).
    assert.include(ctx.body, '<noscript>');
    assert.include(ctx.body, 'form="op.logoutForm"');
    // Auto-submit via asset same-origin — permitido por CSP `script-src 'self'`.
    assert.include(ctx.body, `<script src="${ASSET_PATH}"></script>`);
    // REGRESSÃO (o bug): script inline era bloqueado por CSP com nonce/hash e o
    // logout ficava preso em "Saindo / Encerrando sua sessão…" para sempre.
    assert.notInclude(ctx.body, '<script>');
    assert.notInclude(ctx.body, 'f.submit()');
  });

  test('postLogoutSuccessSource renderiza a tela de sucesso', async ({ assert }) => {
    const { postLogoutSuccessSource } = createLogoutSources({});
    const ctx: any = { body: '' };

    await postLogoutSuccessSource(ctx);

    assert.include(ctx.body, '<h1>');
    assert.include(ctx.body, '</h1>');
    assert.include(ctx.body, '<p>');
  });
});
