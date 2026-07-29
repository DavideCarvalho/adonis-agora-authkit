/**
 * Método de sudo `magicLink`.
 *
 * O ponto central destes testes é que o token de sudo NÃO é o token de login:
 * ele nasce aqui (`randomBytes`), vive HASHEADO na sessão que o pediu, serve
 * uma vez só e nunca toca `AccountStore.issueMagicLinkToken` /
 * `consumeMagicLinkToken`.
 */

import { createHash } from 'node:crypto';
import { test } from '@japa/runner';
import { sudoContextFrom } from '../../src/host/controllers/account_confirm_controller.js';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import {
  SUDO_LINK_SESSION_KEY,
  SUDO_LINK_TTL_MS,
  issueSudoLinkToken,
  magicLink,
  verifySudoLinkToken,
} from '../../src/host/sudo/methods/magic_link.js';
import { password } from '../../src/host/sudo/methods/password.js';
import { completeSudo, fail, setMountedSudoMethods } from '../../src/host/sudo/runtime.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

function ctxWith(
  opts: {
    email?: string | null;
    onSudoLink?: unknown;
    session?: Record<string, unknown>;
    accountId?: string;
  } = {},
) {
  const session: Record<string, unknown> = { ...opts.session };
  const accountId = opts.accountId ?? 'acc-1';
  return {
    accountId,
    account: { id: accountId, email: opts.email === undefined ? 'u@e.com' : opts.email },
    returnTo: null,
    cfg: { mail: opts.onSudoLink ? { onSudoLink: opts.onSudoLink } : {} },
    ctx: {
      session: {
        get: (k: string) => session[k],
        put: (k: string, v: unknown) => {
          session[k] = v;
        },
        forget: (k: string) => {
          delete session[k];
        },
      },
    },
    _session: session,
  } as any;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Fixa o estado de processo de "o que foi montado" para o que estes testes de
 * fato modelam: um host que MONTOU o magic link (é o que `captureHandlers()`
 * faz, registrando o método direto). A lista é do HOST, não a de defaults da
 * lib — e por isso a derivação de `derivedSudoMethods` não a toca.
 *
 * Sem isto, o teste herda o `mountedSudoMethods` que outro spec deixou no
 * processo: se o vizinho montou os DEFAULTS, o magic link é derivado para fora
 * (host com senha não passa a oferecer step-up por e-mail) e todo handler aqui
 * responde `fail`. Fixar torna o grupo independente da ordem dos arquivos.
 */
function mountHostMagicLink() {
  setMountedSudoMethods([magicLink()], { fromDefaults: false });
}

test.group('sudoMethods.magicLink — disponibilidade', () => {
  test('disponível quando há e-mail e hook de envio', async ({ assert }) => {
    assert.isTrue(await magicLink().isAvailable(ctxWith({ onSudoLink: async () => {} })));
  });

  /**
   * MUDOU, e é o coração do conserto do deadlock passwordless: antes, sem o hook
   * `mail.onSudoLink` o método se declarava INDISPONÍVEL. Num host sem senha e
   * sem passkey isso deixava a tela `/account/confirm` sem um único método —
   * ou seja, o único método sem credencial prévia que a lib tem só funcionava se
   * alguém tivesse escrito um hook à mão. A entrega agora cai no mailer default
   * do host-kit, igual a todo outro e-mail da lib.
   */
  test('disponível SEM hook de envio — a entrega cai no mailer default', async ({ assert }) => {
    assert.isTrue(await magicLink().isAvailable(ctxWith()));
  });

  test('indisponível sem e-mail na conta', async ({ assert }) => {
    assert.isFalse(
      await magicLink().isAvailable(ctxWith({ email: null, onSudoLink: async () => {} })),
    );
  });
});

test.group('sudoMethods.magicLink — token', () => {
  test('token válido é aceito uma vez', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    c._session[SUDO_LINK_SESSION_KEY] = {
      hash: hash('tok-1'),
      expiresAt: Date.now() + SUDO_LINK_TTL_MS,
      accountId: 'acc-1',
    };

    assert.isTrue(verifySudoLinkToken(c, 'tok-1'));
  });

  test('token NÃO serve duas vezes', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    c._session[SUDO_LINK_SESSION_KEY] = {
      hash: hash('tok-1'),
      expiresAt: Date.now() + SUDO_LINK_TTL_MS,
      accountId: 'acc-1',
    };

    assert.isTrue(verifySudoLinkToken(c, 'tok-1'));
    assert.isFalse(verifySudoLinkToken(c, 'tok-1'));
  });

  test('token expirado é rejeitado', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    c._session[SUDO_LINK_SESSION_KEY] = {
      hash: hash('tok-1'),
      expiresAt: Date.now() - 1,
      accountId: 'acc-1',
    };

    assert.isFalse(verifySudoLinkToken(c, 'tok-1'));
  });

  test('token de OUTRA sessão é rejeitado (nada guardado nesta)', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    assert.isFalse(verifySudoLinkToken(c, 'tok-de-outro-browser'));
  });

  test('o segredo NÃO é guardado em claro na sessão', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    issueSudoLinkToken(c);

    const stored = c._session[SUDO_LINK_SESSION_KEY] as { hash: string };
    assert.notInclude(JSON.stringify(stored), 'tok');
    assert.lengthOf(stored.hash, 64);
  });

  /**
   * ANTI-BRUTE-FORCE. Os outros testes de uso único reusam o token CERTO, o que
   * não distingue "queimou no consumo" de "queimou no acerto". A propriedade
   * real é: a PRIMEIRA tentativa queima o pendente, mesmo errada. Sem ela,
   * quem tem a sessão (mas não o e-mail) pode chutar o token à vontade.
   */
  test('uma tentativa ERRADA queima o pendente — o token certo depois já não vale', async ({
    assert,
  }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    c._session[SUDO_LINK_SESSION_KEY] = {
      hash: hash('tok-certo'),
      expiresAt: Date.now() + SUDO_LINK_TTL_MS,
      accountId: 'acc-1',
    };

    assert.isFalse(verifySudoLinkToken(c, 'tok-errado'));
    assert.isFalse(verifySudoLinkToken(c, 'tok-certo'));
  });

  /**
   * O TTL só era exercitado por pendentes montados à mão pelos testes — ou
   * seja, a emissão podia parar de gravar `expiresAt` sem ninguém notar.
   */
  test('a emissão grava a expiração em Date.now() + SUDO_LINK_TTL_MS', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {} });
    const antes = Date.now();
    issueSudoLinkToken(c);
    const depois = Date.now();

    const stored = c._session[SUDO_LINK_SESSION_KEY] as { expiresAt: number };
    assert.isNumber(stored.expiresAt);
    assert.isAtLeast(stored.expiresAt, antes + SUDO_LINK_TTL_MS);
    assert.isAtMost(stored.expiresAt, depois + SUDO_LINK_TTL_MS);
  });
});

/**
 * VINCULAÇÃO À CONTA (Critical).
 *
 * "O pendente morre no logout" é falso: o `regenerate()` do @adonisjs/session
 * troca o id e MIGRA os dados. Num navegador compartilhado, o pendente de A
 * sobrevive ao login de B.
 */
test.group('sudoMethods.magicLink — token vinculado à conta emissora', () => {
  test('pendente emitido por outra conta é recusado', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {}, accountId: 'acc-2' });
    c._session[SUDO_LINK_SESSION_KEY] = {
      hash: hash('tok-1'),
      expiresAt: Date.now() + SUDO_LINK_TTL_MS,
      accountId: 'acc-1',
    };

    assert.isFalse(verifySudoLinkToken(c, 'tok-1'));
  });

  test('a emissão grava a conta que pediu', async ({ assert }) => {
    const c = ctxWith({ onSudoLink: async () => {}, accountId: 'acc-9' });
    issueSudoLinkToken(c);

    const stored = c._session[SUDO_LINK_SESSION_KEY] as { accountId: string };
    assert.equal(stored.accountId, 'acc-9');
  });
});

/**
 * GUARD DE FORMA. O valor na chave de sessão é JSON vindo de um store: pode
 * estar com outra forma (versão anterior do pacote, host que escreveu ali,
 * dado truncado). Sem guard, `Buffer.from(undefined, 'hex')` lança (500) e,
 * pior, `Date.now() > undefined` é `false` — o token nunca expiraria.
 */
test.group('sudoMethods.magicLink — pendente com forma inesperada', () => {
  const casos: Array<[string, unknown]> = [
    ['objeto vazio', {}],
    ['sem hash', { expiresAt: Date.now() + SUDO_LINK_TTL_MS, accountId: 'acc-1' }],
    ['sem expiresAt (seria fail-open: nunca expira)', { hash: hash('tok-1'), accountId: 'acc-1' }],
    ['sem accountId', { hash: hash('tok-1'), expiresAt: Date.now() + SUDO_LINK_TTL_MS }],
    [
      'expiresAt como string',
      { hash: hash('tok-1'), expiresAt: `${Date.now() + 1000}`, accountId: 'acc-1' },
    ],
    ['valor escalar na chave', 'tok-1'],
  ];

  for (const [nome, valor] of casos) {
    test(`recusa sem lançar — ${nome}`, async ({ assert }) => {
      const c = ctxWith({ onSudoLink: async () => {} });
      c._session[SUDO_LINK_SESSION_KEY] = valor;

      assert.isFalse(verifySudoLinkToken(c, 'tok-1'));
      // Forma errada também é lixo: não pode ficar na sessão.
      assert.isUndefined(c._session[SUDO_LINK_SESSION_KEY]);
    });
  }
});

const ACCOUNT = { id: 'acc-1', email: 'user@example.com' };

/** Captura os handlers registrados pelo método, por `"<VERBO> <path>"`. */
function captureHandlers() {
  const routes = new Map<string, (ctx: any) => Promise<unknown>>();
  const router = {
    post: (p: string, h: any) => {
      routes.set(`POST ${p}`, h);
    },
    get: (p: string, h: any) => {
      routes.set(`GET ${p}`, h);
    },
  } as any;
  magicLink().register!(router, { contextFrom: sudoContextFrom, completeSudo, fail });
  return routes;
}

function fakeCtx(
  opts: {
    params?: Record<string, unknown>;
    qs?: Record<string, unknown>;
    method?: string;
    session?: Record<string, unknown>;
    cfg?: Record<string, unknown>;
    onSudoLink?: (data: { email: string; sudoUrl: string }) => Promise<void>;
  } = {},
) {
  // A sessão recebida é usada POR REFERÊNCIA (não copiada): o fluxo do magic
  // link são duas requisições — o POST que emite e o GET que consome — e o
  // token só vale se as duas enxergarem a MESMA sessão.
  const session: Record<string, unknown> = opts.session ?? {};
  session[ACCOUNT_SESSION_KEY] ??= ACCOUNT.id;
  const flashed: Record<string, unknown> = {};
  const redirects: string[] = [];
  const sent: Array<{ email: string; sudoUrl: string }> = [];

  const cfg = {
    messages: { ...DEFAULT_MESSAGES },
    render: async () => ({}),
    accountStore: {
      async findById(id: string) {
        return id === ACCOUNT.id ? ACCOUNT : null;
      },
    },
    mail: {
      onSudoLink:
        opts.onSudoLink ??
        (async (data: { email: string; sudoUrl: string }) => {
          sent.push(data);
        }),
    },
    audit: {
      records: [] as unknown[],
      async record(e: unknown) {
        (cfg.audit.records as unknown[]).push(e);
      },
    },
    ...opts.cfg,
  } as any;

  const ctx = {
    params: opts.params ?? {},
    session: {
      get: (k: string) => session[k],
      put: (k: string, v: unknown) => {
        session[k] = v;
      },
      forget: (k: string) => {
        delete session[k];
      },
      flash: (k: string, v: unknown) => {
        flashed[k] = v;
      },
      flashMessages: { get: (k: string) => flashed[k] ?? null },
    },
    request: {
      csrfToken: 'csrf-token',
      method: () => opts.method ?? 'POST',
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, undefined])),
      input: () => undefined,
      qs: () => opts.qs ?? {},
      ip: () => '203.0.113.1',
      protocol: () => 'https',
      host: () => 'app.example.com',
    },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
        return { _redirect: url };
      },
      notFound: (body?: unknown) => ({ _notFound: body ?? null }),
    },
    containerResolver: { make: async () => ({ config: cfg }) },
  } as any;

  return { ctx, cfg, session, flashed, redirects, sent };
}

/** Extrai o token do `sudoUrl` que o hook recebeu. */
const tokenFrom = (sudoUrl: string) =>
  sudoUrl.split('/account/confirm/magic-link/')[1]!.split('?')[0]!;

test.group('sudoMethods.magicLink — handler de emissão (POST)', (group) => {
  group.each.setup(mountHostMagicLink);

  test('emite o link e guarda só o hash na sessão', async ({ assert }) => {
    const h = fakeCtx();
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);

    assert.lengthOf(h.sent, 1);
    assert.equal(h.sent[0]!.email, ACCOUNT.email);
    // Link de e-mail precisa ser absoluto — caminho relativo não é clicável.
    assert.isTrue(
      h.sent[0]!.sudoUrl.startsWith('https://app.example.com/account/confirm/magic-link/'),
    );

    const token = tokenFrom(h.sent[0]!.sudoUrl);
    const stored = h.session[SUDO_LINK_SESSION_KEY] as { hash: string };
    assert.notInclude(JSON.stringify(stored), token);
    assert.equal(stored.hash, hash(token));
  });

  test('método fora de config.sudo.methods NÃO emite token nem envia e-mail', async ({
    assert,
  }) => {
    const h = fakeCtx({ cfg: { sudo: { methods: [password()] } } });
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);

    assert.isUndefined(h.session[SUDO_LINK_SESSION_KEY]);
    assert.lengthOf(h.sent, 0);
    assert.isNotNull(h.flashed.confirmError);
  });

  test('conta inexistente NÃO emite token nem envia e-mail', async ({ assert }) => {
    const h = fakeCtx({
      cfg: {
        accountStore: {
          async findById() {
            return null;
          },
        },
      },
    });
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);

    assert.isUndefined(h.session[SUDO_LINK_SESSION_KEY]);
    assert.lengthOf(h.sent, 0);
  });

  test('falha no envio apaga o token pendente', async ({ assert }) => {
    const h = fakeCtx({
      onSudoLink: async () => {
        throw new Error('smtp caiu');
      },
    });
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);

    assert.isUndefined(h.session[SUDO_LINK_SESSION_KEY]);
    assert.isNotNull(h.flashed.confirmError);
  });

  test('o return_to é preservado no link e no redirect', async ({ assert }) => {
    const h = fakeCtx({ qs: { return_to: '/account/tokens' } });
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);

    assert.include(h.sent[0]!.sudoUrl, '?return_to=%2Faccount%2Ftokens');
    assert.deepEqual(h.redirects, ['/account/confirm?return_to=%2Faccount%2Ftokens']);
  });
});

test.group('sudoMethods.magicLink — handler de consumo (GET)', (group) => {
  group.each.setup(mountHostMagicLink);

  /** Roda o POST e devolve o token que o hook recebeu, para o GET consumir. */
  async function issueVia(h: ReturnType<typeof fakeCtx>) {
    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);
    return tokenFrom(h.sent[0]!.sudoUrl);
  }

  test('token emitido nesta sessão concede sudo', async ({ assert }) => {
    const h = fakeCtx();
    const token = await issueVia(h);

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
    assert.deepInclude(h.cfg.audit.records[0], { type: 'sudo.confirmed', accountId: ACCOUNT.id });
  });

  test('o mesmo token não concede sudo duas vezes', async ({ assert }) => {
    const h = fakeCtx();
    const token = await issueVia(h);
    const handler = captureHandlers().get('GET /account/confirm/magic-link/:token')!;

    await handler(
      fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg }).ctx,
    );
    delete h.session[SUDO_SESSION_KEY];
    await handler(
      fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg }).ctx,
    );

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
  });

  test('token de outro navegador não concede sudo (nada pendente nesta sessão)', async ({
    assert,
  }) => {
    const h = fakeCtx();
    const token = await issueVia(h);

    // Sessão limpa: mesmo token, outro browser.
    const other = fakeCtx({ method: 'GET', params: { token } });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(other.ctx);

    assert.isUndefined(other.session[SUDO_SESSION_KEY]);
    assert.lengthOf(other.cfg.audit.records, 0);
  });

  test('método fora de config.sudo.methods não concede sudo mesmo com token válido', async ({
    assert,
  }) => {
    const h = fakeCtx();
    const token = await issueVia(h);
    h.cfg.sudo = { methods: [password()] };

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
  });

  test('conta inexistente não concede sudo mesmo com token válido', async ({ assert }) => {
    const h = fakeCtx();
    const token = await issueVia(h);
    h.cfg.accountStore = {
      async findById() {
        return null;
      },
    };

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
  });

  /**
   * PoC do review, ponta a ponta: navegador compartilhado.
   *
   * A pede o link → A faz logout → B loga no mesmo navegador (a sessão migra,
   * só o `ACCOUNT_SESSION_KEY` troca) → A abre o link do próprio e-mail. Sem a
   * vinculação, `c.account` já é B e o sudo era concedido SOBRE A CONTA DE B.
   */
  test('token emitido pela conta A não concede sudo depois que B loga no mesmo navegador', async ({
    assert,
  }) => {
    const OUTRA = { id: 'acc-2', email: 'outra@example.com' };
    const duasContas = {
      accountStore: {
        async findById(id: string) {
          if (id === ACCOUNT.id) return ACCOUNT;
          return id === OUTRA.id ? OUTRA : null;
        },
      },
    };

    const h = fakeCtx({ cfg: duasContas });
    const token = await issueVia(h);

    // Logout de A + login de B: o pendente de A CONTINUA na sessão.
    h.session[ACCOUNT_SESSION_KEY] = OUTRA.id;
    assert.isDefined(h.session[SUDO_LINK_SESSION_KEY]);

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
  });

  test('contraprova: sem troca de conta o mesmo fluxo concede sudo', async ({ assert }) => {
    const h = fakeCtx();
    const token = await issueVia(h);

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
  });

  test('sem token na rota não concede sudo', async ({ assert }) => {
    const h = fakeCtx();
    await issueVia(h);

    const get = fakeCtx({ method: 'GET', params: {}, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
  });
});

test.group('sudoMethods.magicLink — o token de sudo não é o de login', (group) => {
  group.each.setup(mountHostMagicLink);

  test('não toca em issueMagicLinkToken/consumeMagicLinkToken do AccountStore', async ({
    assert,
  }) => {
    const touched: string[] = [];
    const h = fakeCtx({
      cfg: {
        accountStore: {
          async findById(id: string) {
            return id === ACCOUNT.id ? ACCOUNT : null;
          },
          async issueMagicLinkToken() {
            touched.push('issue');
            return { token: 'login-token' };
          },
          async consumeMagicLinkToken() {
            touched.push('consume');
            return ACCOUNT;
          },
        },
      },
    });

    await captureHandlers().get('POST /account/confirm/magic-link')!(h.ctx);
    const token = tokenFrom(h.sent[0]!.sudoUrl);

    const get = fakeCtx({ method: 'GET', params: { token }, session: h.session, cfg: h.cfg });
    await captureHandlers().get('GET /account/confirm/magic-link/:token')!(get.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
    assert.deepEqual(touched, []);
    // 32 bytes em hex — entropia de credencial, gerada aqui e não pelo store.
    assert.lengthOf(token, 64);
  });
});
