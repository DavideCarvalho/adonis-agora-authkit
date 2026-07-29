/**
 * O DEADLOCK DO HOST PASSWORDLESS (plano 020).
 *
 * `0.46.0` publicou o SPI de métodos de sudo justamente para resolver isto — e
 * NÃO mexeu no default. Um host que declara
 *
 * ```ts
 * defineConfig({
 *   authMethods: { password: false },
 *   passwordless: { magicLink: true, passkeyFirst: true, signup: true },
 * })
 * registerAuthHost(router)            // sem `sudoMethods`
 * ```
 *
 * monta `[password(), passkey()]`. O usuário que se cadastrou por magic link não
 * tem senha (o signup passwordless grava um hash aleatório inutilizável) e não
 * tem passkey — então NENHUM dos dois métodos é satisfazível, e ele fica preso
 * fora de toda operação sob `requireSudo`: exportar/excluir dados (LGPD), MFA,
 * PATs, troca de e-mail. Inclusive fora do cadastro de passkey, que é o que
 * destravaria todo o resto.
 *
 * Estes testes são a reprodução do deadlock (grupo 1) e as duas travas de
 * regressão que o conserto NÃO pode quebrar (grupo 2).
 */

import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../../src/define_config.js';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import AccountConfirmController from '../../src/host/controllers/account_confirm_controller.js';
import { __setMailLoaderForTests } from '../../src/host/default_mailer.js';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';
import { magicLink } from '../../src/host/sudo/methods/magic_link.js';
import { oidcStepUp } from '../../src/host/sudo/methods/oidc_step_up.js';
import { passkey } from '../../src/host/sudo/methods/passkey.js';
import { password } from '../../src/host/sudo/methods/password.js';
import { configuredSudoMethods, isSudoMethodEnabled } from '../../src/host/sudo/runtime.js';
import { warnUnsatisfiableSudoConfig } from '../../src/host/sudo/satisfiability.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';
import { fakeAccountStore } from '../bootstrap.js';

const ACCOUNT = { id: 'acc-1', email: 'aluno@example.com' };

/**
 * Métodos de sudo que uma conta SEM senha e SEM passkey consegue satisfazer —
 * é a definição operacional de "não está em deadlock".
 */
const CREDENTIAL_FREE = ['oidc-step-up', 'magic-link'];

/** Router falso que GUARDA os handlers, para podermos invocá-los. */
function capturingRouter() {
  const routes = new Map<string, (ctx: any) => Promise<unknown>>();
  const chain: any = {
    as: () => chain,
    middleware: () => chain,
    use: () => chain,
    prefix: () => chain,
  };
  const mk = (verb: string) => (pattern: string, handler: any) => {
    if (typeof handler === 'function') routes.set(`${verb} ${pattern}`, handler);
    return chain;
  };
  return {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    put: mk('PUT'),
    delete: mk('DELETE'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      cb();
      return chain;
    },
    routes,
  } as any;
}

/**
 * Mailer fake do `@adonisjs/mail`, para o caso "o host tem mailer configurado
 * mas não escreveu hook nenhum de sudo" — que é o caso do consumidor real.
 */
function fakeMailStub() {
  const sent: Array<{ to?: string; subject?: string; html?: string; text?: string }> = [];
  const stub = {
    async send(cb: any) {
      const message: any = {
        _sent: {} as Record<string, unknown>,
        from(v: unknown) {
          this._sent.from = v;
          return this;
        },
        to(v: unknown) {
          this._sent.to = v;
          return this;
        },
        subject(v: unknown) {
          this._sent.subject = v;
          return this;
        },
        html(v: unknown) {
          this._sent.html = v;
          return this;
        },
        text(v: unknown) {
          this._sent.text = v;
          return this;
        },
      };
      await cb(message);
      sent.push(message._sent as any);
    },
  };
  return { stub, sent };
}

/**
 * Contexto de request de um host passwordless igual ao consumidor real:
 * `authMethods.password === false`, `passwordless.*` ligado, e no `mail` só o
 * hook de LOGIN (`onMagicLink`) — nenhum `onSudoLink`.
 */
function passwordlessCtx(cfgOverrides: Record<string, unknown> = {}) {
  const session: Record<string, unknown> = { [ACCOUNT_SESSION_KEY]: ACCOUNT.id };
  const flashed: Record<string, unknown> = {};
  const redirects: string[] = [];
  const rendered: Array<{ props: Record<string, unknown> }> = [];
  const logs: Array<{ level: string; msg: string }> = [];

  const cfg = {
    messages: { ...DEFAULT_MESSAGES },
    authMethods: { password: false },
    passwordless: { magicLink: true, passkeyFirst: true, signup: true },
    // Só o hook de LOGIN. É exatamente o `config/authkit.ts` do consumidor.
    mail: { onMagicLink: async () => {} },
    accountStore: {
      async findById(id: string) {
        return id === ACCOUNT.id ? ACCOUNT : null;
      },
      // Signup passwordless: senha aleatória INUTILIZÁVEL gravada na coluna.
      // De dentro do pacote é indistinguível de uma senha real — é por isso que
      // `password().isAvailable` diz "disponível" e a tela mostra um campo que
      // ninguém consegue preencher.
      async __getRawRow() {
        return { password: 'hash-aleatorio-que-ninguem-conhece' };
      },
      // Conta sem passkey — e cadastrar uma exige sudo.
      async listPasskeys() {
        return [];
      },
      async verifyCredentials() {
        return null;
      },
    },
    render: async (_c: unknown, _v: string, props: Record<string, unknown>) => {
      rendered.push({ props });
      return {};
    },
    audit: {
      records: [] as unknown[],
      async record(e: unknown) {
        (cfg.audit.records as unknown[]).push(e);
      },
    },
    ...cfgOverrides,
  } as any;

  const ctx = {
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
      method: () => 'POST',
      only: () => ({}),
      input: () => undefined,
      qs: () => ({}),
      ip: () => '203.0.113.1',
      protocol: () => 'https',
      host: () => 'contas.example.com',
      csrfToken: 'csrf',
    },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
        return { _redirect: url };
      },
      notFound: (body?: unknown) => ({ _notFound: body ?? null }),
    },
    logger: {
      info: (_m: unknown, msg: string) => logs.push({ level: 'info', msg }),
      warn: (_m: unknown, msg: string) => logs.push({ level: 'warn', msg }),
      error: (_m: unknown, msg: string) => logs.push({ level: 'error', msg }),
    },
    containerResolver: { make: async () => ({ config: cfg }) },
  } as any;

  return { ctx, cfg, session, flashed, redirects, rendered, logs };
}

/** Ids que a TELA de confirmação oferece para esta conta. */
async function offeredIds(h: ReturnType<typeof passwordlessCtx>): Promise<string[]> {
  await new AccountConfirmController().show(h.ctx);
  return (h.rendered.at(-1)!.props.methods as Array<{ id: string }>).map((m) => m.id);
}

// ───────────────────────────────────────────────────────────────────────────
// 1 — A reprodução do deadlock
// ───────────────────────────────────────────────────────────────────────────

test.group('sudo — host passwordless sem `sudoMethods` (o deadlock)', (group) => {
  group.each.setup(() => {
    resetAuthHostConfig();
    const { stub, sent } = fakeMailStub();
    __setMailLoaderForTests(() => Promise.resolve(stub));
    return () => {
      __setMailLoaderForTests(undefined);
      resetAuthHostConfig();
      sent.length = 0;
    };
  });

  test('a tela oferece ao menos um método que uma conta sem senha e sem passkey consegue satisfazer', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const h = passwordlessCtx();
    const ids = await offeredIds(h);

    assert.isTrue(
      ids.some((id) => CREDENTIAL_FREE.includes(id)),
      `deadlock: a tela só oferece [${ids.join(', ')}] — nada que uma conta sem senha e sem passkey consiga satisfazer`,
    );
  });

  test('o método oferecido tem rota montada e concede sudo de ponta a ponta', async ({
    assert,
  }) => {
    const { stub, sent } = fakeMailStub();
    __setMailLoaderForTests(() => Promise.resolve(stub));

    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const h = passwordlessCtx();
    const ids = await offeredIds(h);
    const usable = ids.find((id) => CREDENTIAL_FREE.includes(id));
    assert.isDefined(
      usable,
      `deadlock: nenhum método satisfazível oferecido (oferecidos: [${ids.join(', ')}])`,
    );

    // O único credential-free que a lib consegue montar sozinha é o magic link
    // (o `oidcStepUp` exige uma URL do host).
    assert.equal(usable, 'magic-link');

    const emitir = router.routes.get('POST /account/confirm/magic-link');
    assert.isFunction(emitir, 'a rota que emite o link de sudo precisa estar montada');
    await emitir!(h.ctx);

    // O e-mail saiu (aqui pelo mailer default do host — o consumidor real tem
    // `@adonisjs/mail` configurado e NENHUM hook `onSudoLink`).
    assert.lengthOf(sent, 1, 'o link de sudo precisa ter sido enviado');
    const token = /magic-link\/([0-9a-f]{64})/.exec(String(sent[0].html ?? ''))?.[1];
    assert.isString(token, 'o e-mail precisa carregar o link com o token');

    const consumir = router.routes.get('GET /account/confirm/magic-link/:token');
    assert.isFunction(consumir);
    h.ctx.params = { token };
    await consumir!(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY], 'o sudo tem de ter sido concedido');
  });

  test('o handler ACEITA o método que a tela oferece (os dois lados convergem)', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const h = passwordlessCtx();
    for (const id of await offeredIds(h)) {
      assert.isTrue(
        isSudoMethodEnabled(h.cfg, id),
        `o handler recusaria "${id}", que a tela oferece`,
      );
    }
  });

  test('o campo de senha para de ser oferecido a quem o host declarou sem senha', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const h = passwordlessCtx();
    const ids = await offeredIds(h);

    // `authMethods: { password: false }` é declaração de CONFIG, autoritativa: o
    // deployment não tem senha usável. Oferecer o campo é oferecer uma opção que
    // não pode dar certo.
    assert.notInclude(ids, 'password');
    assert.isFalse(isSudoMethodEnabled(h.cfg, 'password'));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — As travas de regressão: têm de passar ANTES e DEPOIS
// ───────────────────────────────────────────────────────────────────────────

test.group('sudo — o que o conserto NÃO pode mudar', (group) => {
  group.each.setup(() => {
    resetAuthHostConfig();
    return () => resetAuthHostConfig();
  });

  test('host COM senha e sem `sudoMethods` continua com exatamente [password, passkey]', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    // Mesmo host, mas sem os pins de passwordless: é a maioria dos consumidores.
    const h = passwordlessCtx({
      authMethods: {},
      passwordless: { magicLink: false, passkeyFirst: false, signup: false },
      accountStore: {
        async findById() {
          return ACCOUNT;
        },
        async __getRawRow() {
          return { password: 'hash-de-verdade' };
        },
        async listPasskeys() {
          return [{ id: 'pk-1' }];
        },
      },
    });

    assert.deepEqual(await offeredIds(h), ['password', 'passkey']);
    assert.isTrue(isSudoMethodEnabled(h.cfg, 'password'));
    assert.isTrue(isSudoMethodEnabled(h.cfg, 'passkey'));
    assert.deepEqual(
      configuredSudoMethods(h.cfg).map((m) => m.id),
      ['password', 'passkey'],
    );
  });

  test('lista explícita do host é respeitada ao pé da letra — nada somado, nada tirado', async ({
    assert,
  }) => {
    const router = capturingRouter();
    const map = registerAuthHost(router, {
      mountPath: '/oidc',
      sudoMethods: [password(), passkey()],
    });

    // Montagem: exatamente a lista do host.
    assert.deepEqual(map.sudoMethods, ['password', 'passkey']);

    // Oferta/aceite com `config.sudo.methods` explícito: idem, inclusive num
    // host passwordless — a opção SUBSTITUI os defaults e a lista é do host.
    const h = passwordlessCtx({ sudo: { methods: [password(), passkey()] } });
    assert.deepEqual(
      configuredSudoMethods(h.cfg).map((m) => m.id),
      ['password', 'passkey'],
    );
    assert.isTrue(isSudoMethodEnabled(h.cfg, 'password'));
    assert.isTrue(isSudoMethodEnabled(h.cfg, 'passkey'));
    assert.isFalse(isSudoMethodEnabled(h.cfg, 'magic-link'));
  });

  test('host passwordless com lista explícita ainda recebe a lista dele — e o aviso de boot', async ({
    assert,
  }) => {
    // A derivação NÃO conserta uma lista explícita; quem fala é o backstop.
    const h = passwordlessCtx({ sudo: { methods: [password(), passkey()] } });
    assert.deepEqual(
      configuredSudoMethods(h.cfg).map((m) => m.id),
      ['password', 'passkey'],
    );

    const warns: string[] = [];
    const msg = warnUnsatisfiableSudoConfig({
      methods: [password(), passkey()],
      passwordPinnedOff: true,
      passwordlessSignup: true,
      warn: (m) => warns.push(m),
    });
    assert.isString(msg);
    assert.lengthOf(warns, 1);
  });

  test('host que montou só magicLink continua oferecendo só magic-link', async ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [magicLink()] });

    // Host COM senha que escolheu magic-link: a escolha é dele, em qualquer
    // direção — a derivação não mexe em lista de host.
    const h = passwordlessCtx({
      authMethods: {},
      mail: { onSudoLink: async () => {} },
    });

    assert.deepEqual(await offeredIds(h), ['magic-link']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4 — O backstop: uma config de sudo sem saída tem de ser ALTA no boot
// ───────────────────────────────────────────────────────────────────────────

test.group('sudo — aviso de boot para config sem método satisfazível', () => {
  /** Roda o backstop capturando o que ele avisaria. */
  function run(input: Parameters<typeof warnUnsatisfiableSudoConfig>[0]) {
    const warns: string[] = [];
    const msg = warnUnsatisfiableSudoConfig({ ...input, warn: (m) => warns.push(m) });
    return { msg, warns };
  }

  test('dispara: host passwordless que declarou só password + passkey', ({ assert }) => {
    const { msg, warns } = run({
      methods: [password(), passkey()],
      passwordPinnedOff: true,
      passwordlessSignup: false,
    });

    assert.lengthOf(warns, 1);
    // A mensagem tem de dar as três coisas: o gatilho (para o host se
    // reconhecer), a consequência e a saída.
    assert.include(msg!, 'authMethods: { password: false }');
    assert.include(msg!, 'requireSudo');
    assert.include(msg!, 'oidcStepUp');
    assert.include(msg!, 'magicLink');
  });

  test('dispara também por passwordless.signup — o cadastro cria conta sem senha usável', ({
    assert,
  }) => {
    const { msg, warns } = run({
      methods: [password(), passkey()],
      passwordPinnedOff: false,
      passwordlessSignup: true,
    });

    assert.lengthOf(warns, 1);
    assert.include(msg!, 'passwordless: { signup: true }');
  });

  test('cala: a lista tem um método credential-free (oidcStepUp)', ({ assert }) => {
    const { warns } = run({
      methods: [password(), oidcStepUp({ url: '/auth/step-up' })],
      passwordPinnedOff: true,
      passwordlessSignup: true,
    });

    assert.lengthOf(warns, 0);
  });

  test('cala: a lista tem magicLink', ({ assert }) => {
    const { warns } = run({
      methods: [passkey(), magicLink()],
      passwordPinnedOff: true,
      passwordlessSignup: true,
    });

    assert.lengthOf(warns, 0);
  });

  test('cala: host com senha (não é passwordless, password + passkey serve)', ({ assert }) => {
    const { warns } = run({
      methods: [password(), passkey()],
      passwordPinnedOff: false,
      passwordlessSignup: false,
    });

    assert.lengthOf(warns, 0);
  });

  test('cala: host sem `sudo.methods` declarado — vale o default derivado', ({ assert }) => {
    const { warns } = run({
      methods: undefined,
      passwordPinnedOff: true,
      passwordlessSignup: true,
    });

    assert.lengthOf(warns, 0);
  });

  /**
   * O aviso é heurístico por construção: de um método CUSTOMIZADO o pacote não
   * sabe se exige credencial prévia. Diante de um, ele se cala — um aviso de boot
   * que grita para configuração correta é um aviso que o host aprende a ignorar,
   * e este precisa ser levado a sério na primeira vez que aparecer. É também a
   * razão de ser WARN e não THROW: não há prova, há suspeita forte.
   */
  test('cala diante de um método customizado — não afirma o que não pode provar', ({ assert }) => {
    const custom = {
      id: 'meu-step-up',
      async isAvailable() {
        return true;
      },
      async describe() {
        return {
          labelKey: 'x',
          kind: 'redirect' as const,
          endpoint: '/x',
        };
      },
    };

    const { warns } = run({
      methods: [password(), custom],
      passwordPinnedOff: true,
      passwordlessSignup: true,
    });

    assert.lengthOf(warns, 0);
  });
});

/**
 * A COSTURA: o aviso sai de verdade quando o `defineConfig` resolve.
 *
 * O teste acima exercita a função; este prega a costura, porque "loud at boot"
 * é a propriedade que importa — um backstop que existe e nunca é chamado é o
 * mesmo tipo de coisa que este plano veio consertar. `configProvider.resolve` é
 * exatamente o que o `boot()` do provider chama, antes de qualquer request.
 */
test.group('sudo — o backstop dispara no boot, a partir do defineConfig', () => {
  const baseConfig = {
    issuer: 'https://sudo-backstop.test',
    adapter: adapters.redis({ connection: 'main' }),
    jwks: { source: 'managed' as const, algorithm: 'RS256' as const },
    clients: [
      { clientId: 'app1', clientSecret: 's', redirectUris: ['https://sudo-backstop.test/cb'] },
    ],
  };

  async function resolveWith(extra: Record<string, unknown>) {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => {
      warns.push(String(msg));
    };
    try {
      await configProvider.resolve(
        fakeApp,
        defineConfig({ ...baseConfig, accountStore: fakeAccountStore(), ...extra } as any),
      );
    } finally {
      console.warn = original;
    }
    return warns.filter((w) => w.includes('sudo mode SEM SAÍDA'));
  }

  test('config passwordless com sudo.methods sem saída avisa no resolve', async ({ assert }) => {
    const warns = await resolveWith({
      authMethods: { password: false },
      passwordless: { magicLink: true, signup: true },
      sudo: { methods: [password(), passkey()] },
    });

    assert.lengthOf(warns, 1);
  });

  test('a mesma config com magicLink na lista não avisa', async ({ assert }) => {
    const warns = await resolveWith({
      authMethods: { password: false },
      passwordless: { magicLink: true, signup: true },
      sudo: { methods: [passkey(), magicLink()] },
    });

    assert.lengthOf(warns, 0);
  });

  test('config passwordless SEM sudo.methods não avisa — o default derivado resolve', async ({
    assert,
  }) => {
    const warns = await resolveWith({
      authMethods: { password: false },
      passwordless: { magicLink: true, signup: true },
    });

    assert.lengthOf(warns, 0);
  });
});
