import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { DEFAULT_MESSAGES, translate } from '../../src/host/i18n.js';
import { magicLink } from '../../src/host/sudo/methods/magic_link.js';
import { oidcStepUp } from '../../src/host/sudo/methods/oidc_step_up.js';
import { passkey } from '../../src/host/sudo/methods/passkey.js';
import { password } from '../../src/host/sudo/methods/password.js';
import type { SudoContext } from '../../src/host/sudo/types.js';

const dir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
const read = (p: string) => readFileSync(dir + p, 'utf8');

/** Instancia um Edge real montando as views da lib + o helper `t` (igual produção). */
function makeEdge() {
  const edge = new Edge();
  edge.mount('authkit', dir);
  edge.global('t', (key: string, params?: Record<string, string | number>) =>
    translate({ ...DEFAULT_MESSAGES }, key, params),
  );
  return edge;
}

/**
 * `SudoContext` mínimo para chamar `describe()` dos métodos reais nos testes
 * de render abaixo. `returnTo: null` por padrão para que `oidcStepUp` não
 * acrescente querystring ao endpoint (a hidden `return_to` da tela é uma prop
 * de render separada, não vem do `describe()` do método) — ver uso em cada teste.
 */
function fakeSudoContext(returnTo: string | null = null): SudoContext {
  return {
    ctx: {} as any,
    account: { id: 'acc-1', email: 'user@example.com' },
    accountId: 'acc-1',
    cfg: {} as any,
    returnTo,
  };
}

test.group('edge views (lib-owned)', () => {
  test('as 7 views existem', ({ assert }) => {
    for (const v of [
      'login.edge',
      'consent.edge',
      'signup.edge',
      'forgot.edge',
      'reset.edge',
      'account/login.edge',
      'account/tokens.edge',
    ]) {
      assert.isTrue(existsSync(dir + v), `falta ${v}`);
    }
  });

  test('submit-lock incluído nas views com formulários POST', ({ assert }) => {
    for (const v of [
      'login.edge',
      'consent.edge',
      'signup.edge',
      'forgot.edge',
      'reset.edge',
      'mfa-challenge.edge',
      'maintenance.edge',
      'account/apps.edge',
      'account/confirm.edge',
      'account/login.edge',
      'account/mfa.edge',
      'account/orgs.edge',
      'account/security.edge',
      'account/tokens.edge',
    ]) {
      assert.include(
        read(v),
        "@include('authkit::partials/submit_lock')",
        `falta o partial submit_lock em ${v}`,
      );
    }
    // O partial existe e carrega o listener delegado + a marca aria-busy.
    const partial = read('partials/submit_lock.edge');
    assert.include(partial, "document.addEventListener('submit'");
    assert.include(partial, 'aria-busy');
    assert.include(partial, 'defaultPrevented');
  });

  test('throttled.edge renderiza com e sem retryAfter', async ({ assert }) => {
    const edge = makeEdge();
    const withRetry = await edge.render('authkit::throttled', {
      brand: undefined,
      retryAfter: 42,
      retryUrl: '/auth/interaction/uid-1',
    });
    assert.include(withRetry, 'Too many attempts');
    assert.include(withRetry, '42 seconds');
    assert.include(withRetry, 'href="/auth/interaction/uid-1"');

    const noRetry = await edge.render('authkit::throttled', {
      brand: undefined,
      retryAfter: null,
      retryUrl: '/conta/confirmar',
    });
    assert.include(noRetry, 'wait a moment');
    assert.include(noRetry, 'href="/conta/confirmar"');
  });

  test('actions de formulário corretas', ({ assert }) => {
    assert.include(read('login.edge'), '/auth/interaction/');
    assert.include(read('signup.edge'), '/auth/interaction/');
    assert.include(read('forgot.edge'), '/auth/forgot-password');
    assert.include(read('reset.edge'), '/auth/reset-password');
    assert.include(read('account/login.edge'), '/account/login');
    assert.include(read('account/tokens.edge'), '/account/security');
  });

  test('campos CSRF presentes em todos os formulários POST', ({ assert }) => {
    for (const v of [
      'login.edge',
      'consent.edge',
      'signup.edge',
      'forgot.edge',
      'reset.edge',
      'account/login.edge',
      'account/tokens.edge',
    ]) {
      assert.include(read(v), 'name="_csrf"', `${v} está sem campo _csrf`);
    }
  });

  test('login.edge tem branches @if(step === "identifier") e @else', ({ assert }) => {
    const content = read('login.edge');
    assert.include(content, "step === 'identifier'");
    assert.include(content, '@else');
    assert.include(content, '/identifier');
    assert.include(content, '/login');
  });

  test('forgot.edge tem branch @if(sent)', ({ assert }) => {
    assert.include(read('forgot.edge'), '@if(sent)');
  });

  test('reset.edge tem branch @if(done) e campo hidden token', ({ assert }) => {
    const content = read('reset.edge');
    assert.include(content, '@if(done)');
    assert.include(content, 'name="token"');
  });

  test('account/tokens.edge tem @each(token in tokens) e rota de revogação', ({ assert }) => {
    const content = read('account/tokens.edge');
    assert.include(content, '@each(token in tokens)');
    // Path da tela agora é configurável (`accountPaths`); o fallback preserva o
    // default `/account/tokens` e o action-subpath `/{id}/revoke` é fixo.
    assert.include(content, "/account/tokens' }}/{{ token.id }}/revoke");
  });

  test('account/security.edge expõe os forms de senha e e-mail com CSRF', ({ assert }) => {
    const content = read('account/security.edge');
    // Path da tela configurável (`accountPaths`) com fallback ao default; os
    // action-subpaths `/password` e `/email` são fixos.
    assert.include(content, "/account/security' }}/password");
    assert.include(content, "/account/security' }}/email");
    assert.include(content, 'name="currentPassword"');
    assert.include(content, 'name="newPassword"');
    assert.include(content, 'name="newEmail"');
    assert.include(content, 'name="_csrf"');
    assert.include(content, '@if(!supported)');
  });
});

test.group('account console views render real (edge.js)', () => {
  test('account/security.edge renderiza os dois formulários + perfil', async ({ assert }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::account/security', {
      csrfToken: 'csrf',
      supported: true,
      profileSupported: true,
      email: 'u@x.com',
      name: 'Old Name',
      avatarUrl: 'https://x/a.png',
      passwordChanged: null,
      emailChangeRequested: null,
      emailChanged: null,
      profileUpdated: null,
      error: null,
    });
    assert.include(html, 'action="/account/security/password"');
    assert.include(html, 'action="/account/security/email"');
    assert.include(html, 'action="/account/security/profile"');
    assert.include(html, 'Old Name');
    assert.include(html, '/account/apps');
    assert.include(html, 'csrf');
  });

  test('account/apps.edge renderiza apps com revogação e degrada sem enumeração', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::account/apps', {
      csrfToken: 'csrf',
      supported: true,
      revoked: null,
      apps: [{ clientId: 'c1', name: 'c1', accessTokens: 2, refreshTokens: 1 }],
    });
    assert.include(html, 'action="/account/apps/c1/revoke"');
    assert.include(html, 'name="_csrf"');

    const degraded = await edge.render('authkit::account/apps', {
      csrfToken: 't',
      supported: false,
      revoked: null,
      apps: [],
    });
    assert.include(degraded, translate({ ...DEFAULT_MESSAGES }, 'account.apps.not_supported'));
    assert.notInclude(degraded, '/revoke');
  });

  test('account/email-confirmed.edge mostra sucesso/falha conforme `ok`', async ({ assert }) => {
    const edge = makeEdge();
    const okHtml = await edge.render('authkit::account/email-confirmed', { ok: true });
    assert.include(okHtml, translate({ ...DEFAULT_MESSAGES }, 'account.email_confirmed.ok_title'));
    const failHtml = await edge.render('authkit::account/email-confirmed', { ok: false });
    assert.include(
      failHtml,
      translate({ ...DEFAULT_MESSAGES }, 'account.email_confirmed.invalid_title'),
    );
  });
});

test.group('R4 login views render real (edge.js)', () => {
  test('login.edge (password) mostra magic link + passkey-first quando disponíveis', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::login', {
      uid: 'i1',
      csrfToken: 'csrf',
      step: 'password',
      email: 'u@x.com',
      account: null,
      brand: { appName: 'X' },
      magicLinkAvailable: true,
      passkeyFirstAvailable: true,
    });
    assert.include(html, '/auth/interaction/i1/magic');
    assert.include(html, translate({ ...DEFAULT_MESSAGES }, 'login.magic_link_button'));
    assert.include(html, '/auth/interaction/i1/passkey/verify');
    assert.include(html, '/auth/interaction/i1/passkey/options');
    assert.include(html, translate({ ...DEFAULT_MESSAGES }, 'login.passkey_button'));
  });

  test('login.edge esconde passwordless quando indisponível e mostra "link enviado"', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const off = await edge.render('authkit::login', {
      uid: 'i1',
      csrfToken: 'c',
      step: 'password',
      email: 'u@x.com',
      account: null,
      brand: { appName: 'X' },
      magicLinkAvailable: false,
      passkeyFirstAvailable: false,
    });
    assert.notInclude(off, translate({ ...DEFAULT_MESSAGES }, 'login.magic_link_button'));
    assert.notInclude(off, translate({ ...DEFAULT_MESSAGES }, 'login.passkey_button'));

    const sent = await edge.render('authkit::login', {
      uid: 'i1',
      csrfToken: 'c',
      step: 'password',
      email: 'u@x.com',
      account: null,
      brand: { appName: 'X' },
      magicLinkAvailable: true,
      magicLinkSent: true,
    });
    assert.include(sent, translate({ ...DEFAULT_MESSAGES }, 'login.magic_link_sent'));
  });

  test('mfa-challenge.edge mostra a checkbox de trusted device quando ligado', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::mfa-challenge', {
      uid: 'i1',
      csrfToken: 'csrf',
      brand: { appName: 'X' },
      passkeyAvailable: false,
      trustedDevicesEnabled: true,
      trustedDeviceDays: 30,
    });
    assert.include(html, 'name="trustDevice"');
    assert.include(
      html,
      translate({ ...DEFAULT_MESSAGES }, 'mfa_challenge.trust_device', { days: 30 }),
    );

    const off = await edge.render('authkit::mfa-challenge', {
      uid: 'i1',
      csrfToken: 'csrf',
      brand: { appName: 'X' },
      passkeyAvailable: false,
      trustedDevicesEnabled: false,
      trustedDeviceDays: 30,
    });
    assert.notInclude(off, 'name="trustDevice"');
  });

  test('account/security.edge mostra a seção de trusted devices + revogação', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::account/security', {
      csrfToken: 'csrf',
      supported: true,
      profileSupported: false,
      email: 'u@x.com',
      name: '',
      avatarUrl: '',
      passwordChanged: null,
      emailChangeRequested: null,
      emailChanged: null,
      profileUpdated: null,
      error: null,
      trustedDevicesEnabled: true,
      trustedDevicesRevoked: null,
    });
    assert.include(html, 'action="/account/security/trusted-devices/revoke"');
    assert.include(
      html,
      translate({ ...DEFAULT_MESSAGES }, 'account.security.trusted_devices_revoke'),
    );
  });
});

test.group('account/confirm.edge (SPI de métodos de sudo)', () => {
  // Os descritores vêm dos MÉTODOS REAIS (`describe()`), não de objetos
  // literais soltos: se algum dos quatro métodos renomear um campo do
  // `SudoMethodDescriptor` (ex.: `endpoint` → `url`), o valor some daqui para
  // baixo e a asserção sobre o HTML renderizado quebra — é a mesma classe de
  // bug que motivou reescrever esta view (props que o controller parou de
  // mandar, e nenhum teste renderizava a view para pegar isso).
  test('account/confirm.edge renderiza um bloco por método disponível', async ({ assert }) => {
    const edge = makeEdge();
    const ctx = fakeSudoContext();
    const passwordDescriptor = { id: 'password', ...(await password().describe(ctx)) };
    const passkeyDescriptor = { id: 'passkey', ...(await passkey().describe(ctx)) };
    const oidcDescriptor = {
      id: 'oidc-step-up',
      ...(await oidcStepUp({ url: '/auth/step-up' }).describe(ctx)),
    };

    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: '/account/security',
      error: null,
      notice: null,
      preferredId: null,
      methods: [passwordDescriptor, passkeyDescriptor, oidcDescriptor],
    });

    assert.include(html, 'action="/account/confirm"');
    assert.include(html, 'name="password"');
    assert.include(html, 'action="/account/confirm/passkey"');
    assert.include(html, 'href="/auth/step-up"');
    assert.include(html, 'value="/account/security"');
  });

  // 'action' (magic-link): POST simples sem `fields` — só csrf + botão. NÃO é
  // o caso do passkey: passkey é `kind: 'webauthn'` e precisa do handshake (ver
  // o grupo abaixo). Renderizar um método WebAuthn como "form só de submit" foi
  // exatamente a regressão que travou o botão de passkey do template.
  //
  // Sem este teste, um método `kind: 'action'` nunca é exercido pela suíte: o
  // ramo `@else` do template é o mesmo do `form`, mas com `fields` vazio ele
  // precisa continuar montando um form válido (csrf + return_to + submit), e
  // é justamente essa combinação que passou despercebida na quebra original
  // (props antigas `passwordless`/`passkeyAvailable`).
  test('account/confirm.edge renderiza método kind=action (sem fields) como form só de submit', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const ctx = fakeSudoContext();
    const magicLinkDescriptor = { id: 'magic-link', ...(await magicLink().describe(ctx)) };

    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: '/account/security',
      error: null,
      notice: null,
      preferredId: null,
      methods: [magicLinkDescriptor],
    });

    assert.include(html, 'action="/account/confirm/magic-link"');
    assert.include(html, 'name="_csrf"');
    assert.include(html, 'value="/account/security"');
    assert.include(html, translate({ ...DEFAULT_MESSAGES }, 'account.confirm.method.magic_link'));
    assert.notInclude(html, 'name="password"');
    // Um 'action' NÃO é um handshake: nada de campo `response` nem de script
    // WebAuthn. O par com o teste do passkey abaixo é o que impede os dois
    // kinds de voltarem a colapsar num só ramo do template.
    assert.notInclude(html, 'name="response"');
    assert.notInclude(html, 'startAuthentication');
  });

  /**
   * REGRESSÃO: o botão de passkey do template embutido não pode ser um form de
   * submit direto.
   *
   * O handler de `POST /account/confirm/passkey` lê `request.input('response')`
   * e recusa quando vem vazio. Um form sem o handshake WebAuthn posta
   * exatamente isso — o botão RENDERIZA, e falha 100% das vezes. Foi assim que
   * a regressão passou: existia um `<form>` com action correta, e nenhuma
   * asserção olhava para o que o torna utilizável.
   *
   * Por isso as asserções abaixo são sobre o MECANISMO (campo `response`,
   * import do @simplewebauthn/browser, chamada de `startAuthentication`, o
   * endpoint de options), não sobre a existência do bloco.
   */
  test('account/confirm.edge renderiza o handshake WebAuthn completo para kind=webauthn', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const ctx = fakeSudoContext();
    const passkeyDescriptor = { id: 'passkey', ...(await passkey().describe(ctx)) };

    // O descritor real precisa PEDIR o handshake — se `passkey()` voltar a
    // dizer `kind: 'action'`, a tela o renderiza como submit direto e o botão
    // volta a falhar sempre.
    assert.equal(passkeyDescriptor.kind, 'webauthn');

    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: '/account/security',
      error: null,
      notice: null,
      preferredId: null,
      methods: [passkeyDescriptor],
    });

    // O campo que o handler lê. Sem ele o POST é inútil.
    assert.include(html, 'name="response"');
    assert.include(html, 'data-webauthn-response');
    // O JS que preenche esse campo. O import é do bundle servido pelo próprio
    // host (`/authkit/assets/webauthn.js`) — NÃO de CDN público.
    assert.include(html, '/authkit/assets/webauthn.js');
    assert.include(html, 'startAuthentication');
    // O endpoint de options é DERIVADO do `action` do form, não hardcoded pelo
    // id do método — a tela continua sem conhecer 'passkey'.
    assert.include(html, "form.getAttribute('action') + '/options'");
    assert.include(html, 'action="/account/confirm/passkey"');
    // O form do handshake carrega csrf e return_to como qualquer outro.
    assert.include(html, 'name="_csrf"');
    assert.include(html, 'value="/account/security"');
  });

  test('account/confirm.edge não emite o script WebAuthn sem nenhum método do tipo', async ({
    assert,
  }) => {
    const edge = makeEdge();
    const ctx = fakeSudoContext();
    const passwordDescriptor = { id: 'password', ...(await password().describe(ctx)) };

    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: null,
      notice: null,
      preferredId: null,
      methods: [passwordDescriptor],
    });

    assert.notInclude(html, '/authkit/assets/webauthn.js');
    assert.notInclude(html, 'data-authkit-webauthn');
  });

  test('account/confirm.edge avisa quando não há método disponível', async ({ assert }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: null,
      notice: null,
      preferredId: null,
      methods: [],
    });
    assert.include(html, translate({ ...DEFAULT_MESSAGES }, 'account.confirm.no_methods'));
  });

  // `confirmNotice` (magic_link.ts, ao enviar o link) precisa chegar à tela
  // distinto do bloco de erro — sem isso, quem pede o link volta pra mesma
  // tela sem nenhum feedback.
  test('account/confirm.edge mostra o aviso (notice) visualmente distinto do erro', async ({
    assert,
  }) => {
    const edge = makeEdge();

    const withNotice = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: null,
      notice: 'Enviamos um link de confirmação para o seu e-mail.',
      preferredId: null,
      methods: [],
    });
    // O marcador é o próprio `class="..."` do bloco (não só o nome da classe
    // Tailwind), porque `partials/styles.edge` é uma folha de estilo COMPILADA
    // e compartilhada por todas as views do pacote — ela contém a definição
    // `.bg-red-50{...}` sempre, esteja o bloco de erro renderizado ou não.
    assert.include(withNotice, 'Enviamos um link de confirmação para o seu e-mail.');
    assert.include(withNotice, 'class="rounded-lg bg-blue-50');
    assert.notInclude(withNotice, 'class="rounded-lg bg-red-50');

    // Notice e error podem coexistir (ex.: aviso de link enviado numa sessão
    // que também carrega um erro antigo) — os dois blocos continuam distintos.
    const both = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: 'Senha incorreta.',
      notice: 'Enviamos um link de confirmação para o seu e-mail.',
      preferredId: null,
      methods: [],
    });
    assert.include(both, 'class="rounded-lg bg-blue-50');
    assert.include(both, 'class="rounded-lg bg-red-50');
  });

  // `preferredId` (último método usado com sucesso) precisa promover o método
  // correspondente na tela — antes desta correção era prop morta: calculada
  // pelo controller e nunca referenciada pela view.
  test('account/confirm.edge destaca o método correspondente a preferredId', async ({ assert }) => {
    const edge = makeEdge();
    const ctx = fakeSudoContext();
    const passwordDescriptor = { id: 'password', ...(await password().describe(ctx)) };
    const passkeyDescriptor = { id: 'passkey', ...(await passkey().describe(ctx)) };
    const badge = translate({ ...DEFAULT_MESSAGES }, 'account.confirm.preferred_badge');

    const html = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: null,
      notice: null,
      preferredId: 'passkey',
      methods: [passwordDescriptor, passkeyDescriptor],
    });

    assert.include(html, badge);
    // Só o método preferido ganha o destaque — não os dois.
    assert.equal(html.split(badge).length - 1, 1);

    const none = await edge.render('authkit::account/confirm', {
      csrfToken: 'tok',
      returnTo: null,
      error: null,
      notice: null,
      preferredId: null,
      methods: [passwordDescriptor, passkeyDescriptor],
    });
    assert.notInclude(none, badge);
  });
});
