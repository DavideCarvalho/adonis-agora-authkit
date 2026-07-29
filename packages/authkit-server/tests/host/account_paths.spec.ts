/**
 * Feature: rotas do console de conta configuráveis/localizáveis (`accountRoutes`).
 *
 * Prova que o prefixo (`/account` → `/conta`) e os segmentos de tela
 * (`security` → `seguranca`, `confirm` → `confirmar`) se propagam por TODAS as
 * camadas: registro de rotas, redirect de sudo, fluxo magic-link, URL de e-mail
 * e as views Edge (incl. os `fetch()` do `mfa.edge`). Os action-subpaths
 * (`/password`, `/passkeys/verify`, ...) e o segmento `api` continuam FIXOS.
 *
 * Isolamento: cada grupo restaura os singletons no teardown (`resetAccountPaths`
 * + `resetAccountLoginUrl`) — a suíte existente (que assume os defaults) não
 * pode enxergar overrides vazados daqui.
 */

import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { accountHome } from '../../src/host/account_home.js';
import { getAccountLoginUrl, resetAccountLoginUrl } from '../../src/host/account_login_url.js';
import {
  accountPath,
  accountPathsMap,
  accountPrefix,
  joinAccountPath,
  normalizeAccountPrefix,
  resetAccountPaths,
  setAccountPaths,
} from '../../src/host/account_paths.js';
import { sudoContextFrom } from '../../src/host/controllers/account_confirm_controller.js';
import { sendNewLoginEmail } from '../../src/host/default_mailer.js';
import { DEFAULT_MESSAGES, translate } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';
import { magicLink } from '../../src/host/sudo/methods/magic_link.js';
import { completeSudo, fail, setMountedSudoMethods } from '../../src/host/sudo/runtime.js';
import { SUDO_SESSION_KEY, requireSudo } from '../../src/host/sudo_mode.js';

// ─── helpers ──────────────────────────────────────────────────────────────

/** Router fake que só grava os patterns registrados (dentro e fora de grupos). */
function fakeRouter() {
  const routes: Array<{ method: string; pattern: string }> = [];
  const mk = (method: string) => (pattern: string) => {
    routes.push({ method, pattern });
    const chain: any = { as: () => chain, middleware: () => chain, use: () => chain };
    return chain;
  };
  const groupChain: any = {
    as: () => groupChain,
    prefix: () => groupChain,
    middleware: () => groupChain,
    use: () => groupChain,
  };
  const router: any = {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    delete: mk('DELETE'),
    put: mk('PUT'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      cb();
      return groupChain;
    },
    routes,
  };
  return router;
}

const has = (router: any, pattern: string): boolean =>
  router.routes.some((r: any) => r.pattern === pattern);

const PT = { prefix: '/conta', paths: { security: 'seguranca', confirm: 'confirmar' } };

// ─── módulo account_paths ───────────────────────────────────────────────────

test.group('account_paths', (group) => {
  group.each.teardown(() => resetAccountPaths());

  test('defaults idênticos ao histórico (`/account/*`)', ({ assert }) => {
    assert.equal(accountPath('security'), '/account/security');
    assert.equal(accountPath('confirm'), '/account/confirm');
    assert.equal(accountPath('emailConfirm'), '/account/email/confirm');
    assert.equal(accountPrefix(), '/account');
  });

  test('overrides pt-BR aplicam prefixo + segmento de tela', ({ assert }) => {
    setAccountPaths(PT);
    assert.equal(accountPath('security'), '/conta/seguranca');
    assert.equal(accountPath('confirm'), '/conta/confirmar');
    // Tela não sobrescrita segue o prefixo novo com o segmento default.
    assert.equal(accountPath('mfa'), '/conta/mfa');
    assert.equal(accountPrefix(), '/conta');
  });

  test('subpath = tela + concat fixo', ({ assert }) => {
    setAccountPaths(PT);
    assert.equal(`${accountPath('security')}/password`, '/conta/seguranca/password');
  });

  test('normaliza prefixo e segmento (barras nas pontas)', ({ assert }) => {
    setAccountPaths({ prefix: 'conta/', paths: { security: '/seguranca/' } });
    assert.equal(normalizeAccountPrefix('conta/'), '/conta');
    assert.equal(accountPath('security'), '/conta/seguranca');
  });

  test('valores vazios caem no default (nunca path quebrado)', ({ assert }) => {
    setAccountPaths({ prefix: '   ', paths: { security: '' } });
    assert.equal(accountPath('security'), '/account/security');
  });

  test('prefixo raiz (\'/\') nunca produz "//" (protocol-relative em <form action>)', ({
    assert,
  }) => {
    setAccountPaths({ prefix: '/' });
    assert.equal(accountPrefix(), '/');
    assert.equal(accountPath('security'), '/security');
    assert.notEqual(accountPath('security'), '//security');
    assert.isFalse(accountPath('security').startsWith('//'));
  });

  test('joinAccountPath: base canônica de accountPath() e de qualquer composição externa', ({
    assert,
  }) => {
    // Default (`/account`): igual a concatenar o prefixo bruto.
    assert.equal(joinAccountPath('api'), '/account/api');
    // Prefixo customizado: mesmo comportamento de accountPath().
    setAccountPaths({ prefix: '/conta' });
    assert.equal(joinAccountPath('api'), '/conta/api');
    // Prefixo raiz: colapsa pra evitar '//api' (mesma proteção de accountPath()).
    setAccountPaths({ prefix: '/' });
    assert.equal(joinAccountPath('api'), '/api');
    assert.isFalse(joinAccountPath('api').startsWith('//'));
  });

  test('accountPathsMap devolve todas as telas com o path completo', ({ assert }) => {
    setAccountPaths(PT);
    const map = accountPathsMap();
    assert.equal(map.security, '/conta/seguranca');
    assert.equal(map.confirm, '/conta/confirmar');
    assert.equal(map.logout, '/conta/logout');
  });

  test('resetAccountPaths isola: overrides somem', ({ assert }) => {
    setAccountPaths(PT);
    assert.equal(accountPath('security'), '/conta/seguranca');
    resetAccountPaths();
    assert.equal(accountPath('security'), '/account/security');
    assert.equal(accountPrefix(), '/account');
  });
});

// ─── (a) registro de rotas monta nos paths novos; os antigos somem (404) ─────

test.group('registerAuthHost + accountRoutes (pt-BR)', (group) => {
  group.each.teardown(() => {
    resetAccountPaths();
    resetAccountLoginUrl();
  });

  test('telas montam nos paths novos e os paths antigos NÃO existem', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { accountRoutes: PT });

    // Telas navegáveis no path novo.
    assert.isTrue(has(router, '/conta/seguranca'), 'security montada em /conta/seguranca');
    assert.isTrue(has(router, '/conta/seguranca/password'), 'action-subpath fixo preservado');
    assert.isTrue(has(router, '/conta/confirmar'), 'confirm montada em /conta/confirmar');
    assert.isTrue(has(router, '/conta/mfa/passkeys/verify'), 'mfa passkeys verify');
    assert.isTrue(has(router, '/conta/email/confirm'), 'emailConfirm segue o prefixo');

    // Os paths ANTIGOS não existem mais → 404 (a rota nem foi registrada).
    assert.isFalse(has(router, '/account/security'), 'path antigo removido');
    assert.isFalse(has(router, '/account/security/password'), 'path antigo removido');
    assert.isFalse(has(router, '/account/confirm'), 'path antigo removido');
  });

  test('a JSON API segue o prefixo mas o segmento `api` é fixo', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { accountRoutes: PT });
    assert.isTrue(has(router, '/conta/api/me'), 'api segue o prefixo');
    assert.isTrue(has(router, '/conta/api/security'), 'api/security (segmento api fixo)');
    assert.isFalse(has(router, '/account/api/me'), 'api antiga removida');
  });

  test("prefixo raiz ('/'): a JSON API monta em /api/* — nunca //api/*", ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { accountRoutes: { prefix: '/' } });
    assert.isTrue(has(router, '/api/me'), 'api monta em /api/me');
    assert.isTrue(has(router, '/api/security'), 'api monta em /api/security');
    assert.isFalse(has(router, '//api/me'), 'nunca //api/me (protocol-relative)');
    assert.isFalse(
      router.routes.some((r: any) => r.pattern.startsWith('//')),
      'nenhuma rota registrada com // no início',
    );
  });

  test('as rotas de sudo (defaults password+passkey) derivam de accountPath(confirm)', ({
    assert,
  }) => {
    const router = fakeRouter();
    registerAuthHost(router, { accountRoutes: PT });
    assert.isTrue(has(router, '/conta/confirmar'), 'password (URL legada = confirm)');
    assert.isTrue(has(router, '/conta/confirmar/passkey'), 'passkey verify');
    assert.isTrue(has(router, '/conta/confirmar/passkey/options'), 'passkey options');
    assert.isFalse(has(router, '/account/confirm/passkey'), 'path antigo removido');
  });

  test('mesmo com account:false, sudo + api respeitam o prefixo novo', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { account: false, accountRoutes: PT });
    // Telas desmontadas.
    assert.isFalse(has(router, '/conta/seguranca'), 'security desmontada');
    // Infra (sudo + api) montada no prefixo novo.
    assert.isTrue(has(router, '/conta/confirmar'), 'sudo confirm montado');
    assert.isTrue(has(router, '/conta/api/me'), 'api montada');
  });

  test('back-compat: sem accountRoutes tudo fica em /account/*', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router);
    assert.isTrue(has(router, '/account/security'));
    assert.isTrue(has(router, '/account/confirm'));
    assert.isTrue(has(router, '/account/api/me'));
    assert.isFalse(has(router, '/conta/seguranca'));
  });

  test('getAccountLoginUrl e accountHome derivam dos overrides', ({ assert }) => {
    setAccountPaths(PT);
    assert.equal(getAccountLoginUrl(), '/conta/login');
    assert.equal(accountHome({}), '/conta/seguranca');
  });
});

// ─── (b) redirect de sudo + fluxo magic-link ────────────────────────────────

test.group('sudo com accountRoutes', (group) => {
  group.each.teardown(() => resetAccountPaths());
  // Este grupo registra `magicLink()` DIRETO (ver `magicHandlers`), ou seja
  // modela um host que montou esse método. Fixar a lista montada torna o grupo
  // independente da ordem dos arquivos: herdar a lista de DEFAULTS de outro spec
  // faria a derivação de `derivedSudoMethods` tirar o magic link (host com senha
  // não passa a oferecer step-up por e-mail) e todo handler responderia `fail`.
  group.each.setup(() => setMountedSudoMethods([magicLink()], { fromDefaults: false }));

  function fakeSettings(val: unknown) {
    return {
      async getSetting() {
        return val;
      },
      async setSetting() {},
      async deleteSetting() {},
      async listSettings() {
        return [];
      },
    } as any;
  }

  function sudoRedirectCtx() {
    const sessionData: Record<string, unknown> = { [ACCOUNT_SESSION_KEY]: 'acc-1' };
    const history: string[] = [];
    return {
      _history: history,
      session: {
        get: (k: string) => sessionData[k],
        put: (k: string, v: unknown) => {
          sessionData[k] = v;
        },
        forget: (k: string) => {
          delete sessionData[k];
        },
      },
      request: { url: () => '/conta/seguranca', parsedUrl: { search: '' } },
      response: {
        redirect: (url: string) => {
          history.push(url);
          return { _redirect: url };
        },
      },
    } as any;
  }

  test('POST protegido por sudo redireciona para /conta/confirmar?return_to=...', async ({
    assert,
  }) => {
    setAccountPaths(PT);
    const ctx = sudoRedirectCtx();
    const result = await requireSudo(ctx, fakeSettings({ enabled: true, graceMinutes: 15 }));
    assert.notEqual(result, true);
    assert.equal(ctx._history[0], '/conta/confirmar?return_to=%2Fconta%2Fseguranca');
  });

  // Fluxo magic-link completo: emissão → volta pra /conta/confirmar; consumo →
  // marca sudo e devolve ao return_to (loop fecha).
  function magicHandlers() {
    const routes = new Map<string, (ctx: any) => Promise<unknown>>();
    const router = {
      post: (p: string, h: any) => routes.set(`POST ${p}`, h),
      get: (p: string, h: any) => routes.set(`GET ${p}`, h),
    } as any;
    magicLink().register!(router, { contextFrom: sudoContextFrom, completeSudo, fail });
    return routes;
  }

  function magicCtx(session: Record<string, unknown>, qs: Record<string, unknown>) {
    const ACCOUNT = { id: 'acc-1', email: 'user@example.com' };
    session[ACCOUNT_SESSION_KEY] ??= ACCOUNT.id;
    const redirects: string[] = [];
    const sent: Array<{ email: string; sudoUrl: string }> = [];
    const cfg = {
      messages: { ...DEFAULT_MESSAGES },
      accountStore: {
        async findById(id: string) {
          return id === ACCOUNT.id ? ACCOUNT : null;
        },
      },
      mail: {
        onSudoLink: async (d: { email: string; sudoUrl: string }) => {
          sent.push(d);
        },
      },
      audit: { async record() {} },
    } as any;
    const ctx = {
      params: qs.token ? { token: qs.token } : {},
      session: {
        get: (k: string) => session[k],
        put: (k: string, v: unknown) => {
          session[k] = v;
        },
        forget: (k: string) => {
          delete session[k];
        },
        flash: () => {},
        flashMessages: { get: () => null },
      },
      request: {
        csrfToken: 'csrf',
        method: () => 'POST',
        only: () => ({}),
        input: () => undefined,
        qs: () => qs,
        ip: () => '203.0.113.1',
        protocol: () => 'https',
        host: () => 'app.example.com',
      },
      response: {
        redirect: (url: string) => {
          redirects.push(url);
          return { _redirect: url };
        },
        notFound: () => ({ _notFound: true }),
      },
      containerResolver: { make: async () => ({ config: cfg }) },
    } as any;
    return { ctx, redirects, sent, session };
  }

  test('magic-link: emite para /conta/confirmar e o consumo volta ao return_to', async ({
    assert,
  }) => {
    setAccountPaths(PT);
    const session: Record<string, unknown> = {};
    const handlers = magicHandlers();

    // Emissão (POST): link absoluto no path novo + redirect de volta para /conta/confirmar.
    const emit = magicCtx(session, { return_to: '/conta/seguranca' });
    await handlers.get('POST /conta/confirmar/magic-link')!(emit.ctx);
    assert.lengthOf(emit.sent, 1);
    assert.isTrue(
      emit.sent[0]!.sudoUrl.startsWith('https://app.example.com/conta/confirmar/magic-link/'),
      'link de e-mail no path novo',
    );
    assert.equal(emit.redirects[0], '/conta/confirmar?return_to=%2Fconta%2Fseguranca');

    // Consumo (GET) do token emitido → marca sudo e devolve ao return_to.
    const token = emit.sent[0]!.sudoUrl.split('/magic-link/')[1]!.split('?')[0]!;
    const consume = magicCtx(session, { token, return_to: '/conta/seguranca' });
    await handlers.get('GET /conta/confirmar/magic-link/:token')!(consume.ctx);
    assert.isNumber(session[SUDO_SESSION_KEY], 'sudo marcado');
    assert.equal(consume.redirects[0], '/conta/seguranca', 'loop fecha no return_to');
  });
});

// ─── (c) e-mail de troca contém a URL nova ──────────────────────────────────

test.group('e-mail com accountRoutes', (group) => {
  group.each.teardown(() => resetAccountPaths());

  test('o CTA do e-mail aponta para o path novo do console', async ({ assert }) => {
    setAccountPaths(PT);
    const htmls: string[] = [];
    const ctx = {
      logger: { info: () => {}, error: () => {} },
      request: { protocol: () => 'https', host: () => 'app.example.com' },
    } as any;
    // Origin agora vem do issuer resolvido (plan 004), não de request.host() — o
    // issuer casa com o host de antes para preservar a asserção deste teste.
    const cfg = { issuer: 'https://app.example.com' } as any;
    // Intercepta o mailer: sem @adonisjs/mail o fallback loga; injetamos um stub
    // que captura o HTML renderizado.
    const { __setMailLoaderForTests } = await import('../../src/host/default_mailer.js');
    __setMailLoaderForTests(() =>
      Promise.resolve({
        send: async (cb: any) => {
          const msg: any = {
            from: () => msg,
            to: () => msg,
            subject: () => msg,
            html: (v: string) => {
              htmls.push(v);
              return msg;
            },
            text: () => msg,
          };
          cb(msg);
        },
      }),
    );
    try {
      await sendNewLoginEmail(ctx, cfg, { email: 'u@e.com', ip: '203.0.113.1', when: 'hoje' });
    } finally {
      __setMailLoaderForTests(undefined);
    }
    assert.lengthOf(htmls, 1);
    assert.include(htmls[0], 'https://app.example.com/conta/seguranca');
    assert.notInclude(htmls[0], '/account/security');
  });
});

// ─── (d) view edge renderiza os paths novos (incl. o fetch do mfa.edge) ──────

test.group('views edge com accountRoutes', (group) => {
  group.each.teardown(() => resetAccountPaths());

  function makeEdge() {
    const dir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
    const edge = new Edge();
    edge.mount('authkit', dir);
    edge.global('t', (key: string, params?: Record<string, string | number>) =>
      translate({ ...DEFAULT_MESSAGES }, key, params),
    );
    return edge;
  }

  test('mfa.edge usa os paths novos nos forms E nos fetch()', async ({ assert }) => {
    setAccountPaths(PT);
    const edge = makeEdge();
    const html = await edge.render('authkit::account/mfa', {
      csrfToken: 'csrf',
      enabled: false,
      recoveryCodes: null,
      passkeysSupported: true,
      passkeys: [],
      accountPaths: accountPathsMap(),
    });
    // Forms no path novo (enroll: enabled:false renderiza a oferta de enroll;
    // logout: sempre presente).
    assert.include(html, 'action="/conta/mfa/enroll"');
    assert.include(html, 'action="/conta/logout"');
    // Os fetch() client-side (options + verify) no path novo.
    assert.include(html, "fetch('/conta/mfa/passkeys/options'");
    assert.include(html, "fetch('/conta/mfa/passkeys/verify'");
    // Nenhum resquício do path antigo.
    assert.notInclude(html, '/account/mfa');
  });

  test('sem accountPaths (render direto) o fallback mantém o default', async ({ assert }) => {
    const edge = makeEdge();
    const html = await edge.render('authkit::account/mfa', {
      csrfToken: 'csrf',
      enabled: false,
      recoveryCodes: null,
      passkeysSupported: true,
      passkeys: [],
    });
    assert.include(html, "fetch('/account/mfa/passkeys/verify'");
  });
});
