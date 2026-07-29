/**
 * Montagem das rotas dos métodos de sudo (`AuthHostOptions.sudoMethods`).
 *
 * Dois requisitos, os dois estruturais:
 *
 *  1. O host precisa conseguir MONTAR um método que não seja built-in. Sem
 *     isso, `config.sudo.methods` oferece na tela uma opção cujo endpoint dá
 *     404 — e `magicLink()` não é alcançável em runtime de jeito nenhum.
 *  2. Todo handler montado por um método é BARRADO por `config.sudo.methods`
 *     mesmo que o método NÃO tenha chamado `isSudoMethodEnabled`. A garantia
 *     tem de vir do ponto de registro; depender de o autor do método lembrar
 *     de checar é justamente o que reabriria a falha Critical.
 */

import { RouterFactory } from '@adonisjs/core/factories/http';
import type { Router } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { resolveRateLimit } from '../../src/define_config.js';
import AccountConfirmController from '../../src/host/controllers/account_confirm_controller.js';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { __setLimiterLoaderForTests, createAuthThrottles } from '../../src/host/rate_limit.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';
import { sudoContextFrom } from '../../src/host/sudo/index.js';
import { magicLink } from '../../src/host/sudo/methods/magic_link.js';
import { password } from '../../src/host/sudo/methods/password.js';
import {
  completeSudo,
  fail,
  guardSudoRoutes,
  isSudoMethodEnabled,
} from '../../src/host/sudo/runtime.js';
import type { SudoMethod, SudoRouteHelpers } from '../../src/host/sudo/types.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

const ACCOUNT = { id: 'acc-1', email: 'user@example.com' };

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

function fakeCtx(cfgOverrides: Record<string, unknown> = {}) {
  const session: Record<string, unknown> = { [ACCOUNT_SESSION_KEY]: ACCOUNT.id };
  const flashed: Record<string, unknown> = {};
  const redirects: string[] = [];

  const cfg = {
    messages: { ...DEFAULT_MESSAGES },
    accountStore: {
      async findById(id: string) {
        return id === ACCOUNT.id ? ACCOUNT : null;
      },
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

  return { ctx, cfg, session, flashed, redirects };
}

/**
 * Método customizado DESATENTO: concede sudo sem nunca consultar
 * `config.sudo.methods`. É exatamente o método que o review descreve — e o
 * ponto do teste é que ele fica seguro mesmo assim.
 */
function metodoDesatento(): SudoMethod {
  return {
    id: 'custom',
    async isAvailable() {
      return true;
    },
    async describe() {
      return {
        labelKey: 'account.confirm.method.password',
        kind: 'action' as const,
        endpoint: '/account/confirm/custom',
      };
    },
    register(router: Router, h: SudoRouteHelpers) {
      router.post('/account/confirm/custom', async (ctx: any) => {
        const c = await h.contextFrom(ctx);
        return h.completeSudo(c, 'custom');
      });
    },
  };
}

test.group('sudo — AuthHostOptions.sudoMethods monta métodos do host', () => {
  test('sem a opção, monta os defaults (password + passkey + magic-link)', ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    assert.isTrue(router.routes.has('POST /account/confirm'));
    assert.isTrue(router.routes.has('POST /account/confirm/passkey'));
    // `magicLink` entrou nos defaults: é o único método sem credencial prévia
    // que a lib consegue montar sozinha, e sem ele um host passwordless não tem
    // um único método satisfazível. MONTAR não é OFERECER — num host com senha a
    // tela segue mostrando só password + passkey (ver
    // `sudo_passwordless_default.spec.ts`).
    assert.isTrue(router.routes.has('POST /account/confirm/magic-link'));
  });

  test('com a opção, monta as rotas do método customizado', ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    assert.isTrue(router.routes.has('POST /account/confirm/custom'));
    // A opção SUBSTITUI os defaults — é a lista do host, não um acréscimo.
    assert.isFalse(router.routes.has('POST /account/confirm/passkey'));
  });

  test('magicLink() vira alcançável em runtime quando o host o registra', async ({ assert }) => {
    const { magicLink } = await import('../../src/host/sudo/methods/magic_link.js');
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [magicLink()] });

    assert.isTrue(router.routes.has('POST /account/confirm/magic-link'));
    assert.isTrue(router.routes.has('GET /account/confirm/magic-link/:token'));
  });
});

test.group('sudo — a barreira de config.sudo.methods é do ponto de registro', () => {
  test('método que NÃO checa isSudoMethodEnabled ainda é barrado pela config', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    // Host restringiu a `password`: o método 'custom' está fora.
    const h = fakeCtx({ sudo: { methods: [password()] } });
    await router.routes.get('POST /account/confirm/custom')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
    // Recusa com a mesma coreografia de um erro comum — não vaza a config.
    assert.isNotNull(h.flashed.confirmError);
  });

  test('contraprova: com o método na config, o mesmo handler concede sudo', async ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    const custom = metodoDesatento();
    const h = fakeCtx({ sudo: { methods: [custom] } });
    await router.routes.get('POST /account/confirm/custom')!(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 1);
  });

  test('sem config explícita, o método montado continua valendo', async ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    const h = fakeCtx();
    await router.routes.get('POST /account/confirm/custom')!(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
  });
});

/**
 * CONVERGÊNCIA entre os dois lados no caso "host não configurou nada".
 *
 * A tela (`configuredSudoMethods`) e os handlers (`isSudoMethodEnabled`) tinham
 * defaults DIFERENTES: a tela caía numa lista hardcoded (`password + passkey`),
 * os handlers caíam em "o que tem rota montada". Um host que passasse só
 * `registerAuthHost({ sudoMethods: [magicLink()] })` via a tela oferecer dois
 * métodos 404 e esconder o único que funcionava.
 */
test.group('sudo — a tela oferece exatamente o que foi montado (sem config)', () => {
  /** Contexto de render para o controller, com `mail.onSudoLink` (magic-link exige). */
  function showCtx(cfgOverrides: Record<string, unknown> = {}) {
    const rendered: Array<{ props: Record<string, unknown> }> = [];
    const h = fakeCtx({
      mail: { onSudoLink: async () => {} },
      render: async (_c: unknown, _v: string, props: Record<string, unknown>) => {
        rendered.push({ props });
        return {};
      },
      accountStore: {
        async findById() {
          return ACCOUNT;
        },
        // Conta COM senha: se a tela ainda caísse nos defaults hardcoded,
        // `password` apareceria — é justamente o que o teste precisa detectar.
        async __getRawRow() {
          return { password: 'hash-existente' };
        },
      },
      ...cfgOverrides,
    });
    return { ...h, rendered };
  }

  test('montando só magicLink, a tela oferece magic-link e nada mais', async ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [magicLink()] });

    const h = showCtx();
    await new AccountConfirmController().show(h.ctx);

    const ids = (h.rendered[0].props.methods as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ['magic-link']);
    // Os métodos que a tela NÃO oferece são exatamente os que não têm rota.
    assert.isFalse(router.routes.has('POST /account/confirm'));
    assert.isFalse(router.routes.has('POST /account/confirm/passkey'));
  });

  test('o método oferecido pela tela é aceito pelo handler (mesma resposta dos dois lados)', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [magicLink()] });

    const h = showCtx();
    await new AccountConfirmController().show(h.ctx);
    const offered = (h.rendered[0].props.methods as Array<{ id: string }>).map((m) => m.id);

    // Lado da TELA e lado dos HANDLERS, sem `config.sudo.methods`: convergem.
    for (const id of offered) {
      assert.isTrue(isSudoMethodEnabled(h.cfg, id), `handler recusaria "${id}" que a tela oferece`);
      assert.isTrue(router.routes.has('POST /account/confirm/magic-link'));
    }
  });

  test('sem config, a tela segue o que o host montou — inclusive um método customizado', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    const h = showCtx();
    await new AccountConfirmController().show(h.ctx);

    const ids = (h.rendered[0].props.methods as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ['custom']);
  });

  test('com config explícita, ela ainda manda na tela (e o drift volta a ser possível)', async ({
    assert,
  }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [magicLink()] });

    // Config explícita diverge do que foi montado: é o ÚNICO caso de drift que
    // sobra, e é o que o aviso do controller existe para denunciar.
    const h = showCtx({ sudo: { methods: [password()] } });
    await new AccountConfirmController().show(h.ctx);

    const ids = (h.rendered[0].props.methods as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ['password']);
  });
});

/**
 * O wrapper `guardSudoRoutes` contra o `Router` DE VERDADE.
 *
 * Este grupo NÃO pode usar `capturingRouter()`. Foi exatamente por isso que o
 * bug passou: o objeto literal não tem campos privados, então um Proxy sobre
 * ele funciona para tudo. O `Router` do Adonis é uma classe com `#app`,
 * `#globalMatchers` e `#pushToRoutes` — ler/chamar um membro com `this`
 * apontando para o Proxy lança `TypeError`, e um método customizado que
 * agrupasse suas rotas (`router.group(...).prefix('/sudo')`, uso legítimo do
 * tipo `Router` que `SudoMethod.register` declara receber) explodia NO BOOT.
 *
 * Os built-in escapavam só porque usam apenas `.post`/`.get`.
 */
test.group('sudo — guardSudoRoutes preserva a API do Router real', () => {
  const helpers = { contextFrom: sudoContextFrom, completeSudo, fail };
  const realRouter = () => new RouterFactory().create() as unknown as Router;

  test('group/route/on/where/use atravessam o wrapper sem TypeError', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);
    const handler = async () => 'ok';

    // Cada um destes lançava `TypeError` antes do `bind`/do caso de `route`.
    assert.doesNotThrow(() => {
      wrapped
        .group(() => {
          wrapped.post('/account/confirm/custom', handler);
        })
        .prefix('/sudo');
    });
    assert.doesNotThrow(() => wrapped.route('/account/confirm/rt', ['POST'], handler));
    assert.doesNotThrow(() => wrapped.on('/account/confirm/on'));
    assert.doesNotThrow(() => wrapped.where('id', /^[0-9]+$/));
    assert.doesNotThrow(() => wrapped.use([]));
  });

  test('o retorno real do Router é preservado — .as() encadeia', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);
    const route = wrapped.post('/account/confirm/custom', async () => 'ok').as('custom.confirm');

    assert.equal(route.getName(), 'custom.confirm');
    assert.equal(route.getPattern(), '/account/confirm/custom');
  });

  test('rotas registradas por route() também recebem a barreira', async ({ assert }) => {
    const router = realRouter();
    const wrapped = guardSudoRoutes(router, 'custom', helpers);

    // `route()` tem o handler no TERCEIRO argumento. Enquanto ele não era um
    // caso próprio, embrulhar o SEGUNDO (a lista de métodos) era impossível e
    // a rota saía desguardada — bypass silencioso da barreira.
    const route = wrapped.route('/account/confirm/rt', ['POST'], async (ctx: any) => {
      const c = await helpers.contextFrom(ctx);
      return helpers.completeSudo(c, 'custom');
    });

    // Host restringiu a `password`: o método 'custom' está fora.
    const barrado = fakeCtx({ sudo: { methods: [password()] } });
    await (route.getHandler() as any)(barrado.ctx);

    assert.isUndefined(barrado.session[SUDO_SESSION_KEY]);
    assert.lengthOf(barrado.cfg.audit.records, 0);
    assert.isNotNull(barrado.flashed.confirmError);

    // Contraprova: com o método na config, o MESMO handler concede sudo.
    const liberado = fakeCtx({ sudo: { methods: [{ id: 'custom' }] } });
    await (route.getHandler() as any)(liberado.ctx);

    assert.isNumber(liberado.session[SUDO_SESSION_KEY]);
    assert.lengthOf(liberado.cfg.audit.records, 1);
  });

  test('handlers registrados dentro de um group() também recebem a barreira', async ({
    assert,
  }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);
    let route: any;
    wrapped
      .group(() => {
        route = wrapped.post('/account/confirm/custom', async (ctx: any) => {
          const c = await helpers.contextFrom(ctx);
          return helpers.completeSudo(c, 'custom');
        });
      })
      .prefix('/sudo');

    const barrado = fakeCtx({ sudo: { methods: [password()] } });
    await route.getHandler()(barrado.ctx);

    assert.isUndefined(barrado.session[SUDO_SESSION_KEY]);
    assert.isNotNull(barrado.flashed.confirmError);
  });
});

/**
 * THROTTLE NAS ROTAS DOS MÉTODOS DE SUDO.
 *
 * O POST que emite o magic link de sudo dispara um E-MAIL por chamada. O
 * `accountGuard` na frente só exige uma sessão de conta viva — que o abusador
 * tem, porque é a dele. Sem throttle, uma sessão autenticada manda e-mail em
 * loop.
 *
 * O throttle é aplicado no WRAPPER de registro, não pedido pelo método: um
 * método que pudesse pedir poderia também não pedir, e a cobertura voltaria a
 * depender de quem escreve o método lembrar.
 *
 * O bucket é PRÓPRIO do sudo, não o de login. Mesmos limites, contagem
 * separada — ver `ResolvedRateLimitConfig.sudo`.
 */
test.group('sudo — rotas dos métodos levam o throttle do host', () => {
  /** Router falso que guarda um objeto POR ROTA, registrando as chamadas de `use`. */
  function throttleTrackingRouter() {
    const routes = new Map<string, { uses: unknown[][] }>();
    const groupChain: any = {
      as: () => groupChain,
      prefix: () => groupChain,
      middleware: () => groupChain,
      use: () => groupChain,
    };
    const mk = (verb: string) => (pattern: string) => {
      const entry = { uses: [] as unknown[][] };
      routes.set(`${verb} ${pattern}`, entry);
      const chain: any = {
        as: () => chain,
        middleware: () => chain,
        prefix: () => chain,
        use: (m: unknown[]) => {
          entry.uses.push(m);
          return chain;
        },
      };
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
        return groupChain;
      },
      routes,
    } as any;
  }

  test('o POST que emite o magic link de sudo recebe o throttle de sudo', ({ assert }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      rateLimit: { enabled: true },
      sudoMethods: [magicLink()],
    });

    const emissao = router.routes.get('POST /account/confirm/magic-link');
    assert.lengthOf(emissao.uses, 1);
    assert.isFunction(emissao.uses[0][0]);
    // E NÃO é o middleware do login do console: buckets distintos, para que uma
    // reprova de identidade não gaste o orçamento de login do mesmo IP.
    assert.notEqual(emissao.uses[0][0], router.routes.get('POST /account/login').uses[0][0]);
  });

  test('todas as rotas do método são cobertas, inclusive o GET que consome o token', ({
    assert,
  }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      rateLimit: { enabled: true },
      sudoMethods: [magicLink()],
    });

    assert.lengthOf(router.routes.get('GET /account/confirm/magic-link/:token').uses, 1);
  });

  test('um método CUSTOMIZADO também é coberto — não depende de o autor pedir', ({ assert }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      rateLimit: { enabled: true },
      sudoMethods: [metodoDesatento()],
    });

    assert.lengthOf(router.routes.get('POST /account/confirm/custom').uses, 1);
  });

  test('com rate-limit desligado nada é aplicado (o wrapper não inventa throttle)', ({
    assert,
  }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      rateLimit: { enabled: false },
      sudoMethods: [magicLink()],
    });

    assert.lengthOf(router.routes.get('POST /account/confirm/magic-link').uses, 0);
  });
});

/**
 * O QUE NÃO CABE NA BARREIRA É RECUSADO NO BOOT.
 *
 * `guardSudoRoutes` só sabe embrulhar handler-FUNÇÃO. Uma tupla
 * `[Controller, 'metodo']` — e os atalhos `resource()`/`shallowResource()`, que
 * expandem um controller em N rotas — registrariam rotas que
 * `config.sudo.methods` não desabilita e que alcançam o `completeSudo` público.
 *
 * Antes elas passavam direto, com o argumento "nenhum built-in registra assim".
 * Isso é propriedade dos built-in, não da barreira — e o público-alvo do SPI é
 * exatamente quem não é built-in.
 */
test.group('sudo — handler que não cabe na barreira é recusado no registro', () => {
  const helpers = { contextFrom: sudoContextFrom, completeSudo, fail };
  const realRouter = () => new RouterFactory().create() as unknown as Router;

  class MetodoController {
    async confirm() {
      return 'ok';
    }
  }

  test('tupla [Controller, metodo] num verbo lança no ponto de registro', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);

    assert.throws(
      () => wrapped.post('/account/confirm/custom', [MetodoController, 'confirm'] as any),
      /handler-função/,
    );
  });

  test('tupla em route() também lança (handler no terceiro argumento)', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);

    assert.throws(
      () => wrapped.route('/account/confirm/rt', ['POST'], [MetodoController, 'confirm'] as any),
      /handler-função/,
    );
  });

  test('resource() lança — não há handler-função para embrulhar', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);

    assert.throws(
      () => (wrapped as any).resource('/account/confirm/custom', MetodoController),
      /barreira/,
    );
    assert.throws(
      () => (wrapped as any).shallowResource('/account/confirm/custom', MetodoController),
      /barreira/,
    );
  });

  test('a mensagem nomeia o método e aponta a saída', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'meu-metodo', helpers);

    try {
      wrapped.post('/account/confirm/x', [MetodoController, 'confirm'] as any);
      assert.fail('deveria ter lançado');
    } catch (error: any) {
      assert.include(error.message, 'meu-metodo');
      assert.include(error.message, 'POST /account/confirm/x');
      assert.include(error.message, 'config.sudo.methods');
    }
  });

  test('contraprova: handler-função continua registrando normalmente', ({ assert }) => {
    const wrapped = guardSudoRoutes(realRouter(), 'custom', helpers);

    assert.doesNotThrow(() => wrapped.post('/account/confirm/custom', async () => 'ok'));
    // `on()` não registra handler que possa alcançar `completeSudo` — segue passando.
    assert.doesNotThrow(() => wrapped.on('/account/confirm/on'));
  });

  test('um método que registra por tupla derruba o boot em registerAuthHost', ({ assert }) => {
    const porTupla: SudoMethod = {
      id: 'por-tupla',
      async isAvailable() {
        return true;
      },
      async describe() {
        return {
          labelKey: 'account.confirm.method.password',
          kind: 'action' as const,
          endpoint: '/account/confirm/por-tupla',
        };
      },
      register(router: Router) {
        router.post('/account/confirm/por-tupla', [MetodoController, 'confirm'] as any);
      },
    };

    assert.throws(
      () => registerAuthHost(capturingRouter(), { mountPath: '/oidc', sudoMethods: [porTupla] }),
      /handler-função/,
    );
  });
});

/**
 * A barreira "conta carregada", irmã da barreira "método habilitado".
 *
 * `sudoContextFrom` deixa `account: null` quando `findById` não acha nada —
 * sessão viva de conta apagada/anonimizada. Sem a checagem em `completeSudo`,
 * um método desatento (`contextFrom` → `completeSudo`) concederia sudo sobre
 * uma conta que não existe mais.
 */
test.group('sudo — completeSudo exige conta carregada', () => {
  test('recusa quando c.account é null, mesmo com o método habilitado', async ({ assert }) => {
    const router = capturingRouter();
    registerAuthHost(router, { mountPath: '/oidc', sudoMethods: [metodoDesatento()] });

    // Sessão viva apontando para uma conta que o store não acha mais.
    const h = fakeCtx({
      accountStore: {
        async findById() {
          return null;
        },
      },
    });
    await router.routes.get('POST /account/confirm/custom')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
    assert.isNotNull(h.flashed.confirmError);
  });
});

/**
 * OS DOIS BUCKETS SÃO INDEPENDENTES.
 *
 * Os testes acima provam que a rota de sudo leva um middleware DIFERENTE do
 * login. Isso é a fiação; o que importa de verdade é a consequência: estourar
 * um bucket não pode consumir nem bloquear o outro.
 *
 * Por que separar. `login` mede um usuário ANÔNIMO adivinhando credenciais.
 * `sudo` mede um usuário JÁ AUTENTICADO reprovando a própria identidade na tela
 * de confirmação. Compartilhando o bucket, os dois se contaminam nos dois
 * sentidos: quem erra a senha três vezes no `/account/confirm` fica sem
 * conseguir logar em outra aba, e um ataque de credencial contra o login tranca
 * a confirmação de quem está legitimamente logado atrás do mesmo NAT.
 *
 * Os limites continuam iguais (10/min): o ponto é separar a CONTAGEM, não
 * afrouxar o teto.
 */
test.group('sudo — bucket próprio, independente do de login', (group) => {
  group.each.teardown(() => {
    __setLimiterLoaderForTests(undefined);
  });

  /**
   * Limiter fake mínimo: conta por bucket (nome do `define` + key) e "bloqueia"
   * — não chama `next` — ao passar dos pontos. Reproduz o namespacing por NOME
   * do `@adonisjs/limiter`, que é justamente o que mantém os buckets separados.
   */
  function fakeLimiter() {
    const counts = new Map<string, number>();
    const limiter = {
      allowRequests(points: number) {
        const chain: any = {
          points,
          _key: undefined as string | undefined,
          every: () => chain,
          store: () => chain,
          usingKey(k: string) {
            chain._key = k;
            return chain;
          },
        };
        return chain;
      },
      define(name: string, fn: (ctx: any) => any) {
        return async (ctx: any, next: () => Promise<void>) => {
          const chain = fn(ctx);
          // Sem `usingKey`, o HttpLimiter real keya por IP — reproduzimos isso.
          const bucketKey = `${name}:${chain._key ?? ctx.request.ip()}`;
          const used = (counts.get(bucketKey) ?? 0) + 1;
          counts.set(bucketKey, used);
          if (used > chain.points) {
            ctx.__throttled = true;
            return;
          }
          return next();
        };
      },
    };
    return limiter;
  }

  const ctxDo = (ip: string) => ({ request: { ip: () => ip, header: () => undefined } }) as any;

  /** Bate `n` vezes no throttle a partir do MESMO IP; devolve quantas passaram. */
  async function gastar(throttle: any, ip: string, n: number): Promise<number> {
    let passaram = 0;
    for (let i = 0; i < n; i++) {
      const ctx = ctxDo(ip);
      await throttle(ctx, async () => {
        passaram++;
      });
    }
    return passaram;
  }

  test('estourar o bucket de sudo NÃO consome o de login (mesmo IP)', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => fakeLimiter());
    const cfg = resolveRateLimit({ enabled: true });
    const throttles = createAuthThrottles(cfg)!;

    // Queima o bucket de sudo INTEIRO e mais um pouco, do mesmo IP.
    const passaramSudo = await gastar(throttles.sudo, '1.2.3.4', cfg.sudo.points + 5);
    assert.equal(passaramSudo, cfg.sudo.points, 'o bucket de sudo deve ter travado no teto');

    // O login do MESMO IP continua com o orçamento intacto.
    const passaramLogin = await gastar(throttles.login, '1.2.3.4', cfg.login.points);
    assert.equal(
      passaramLogin,
      cfg.login.points,
      'o login não pode ter sido consumido pelas reprovas de identidade',
    );
  });

  test('estourar o bucket de login NÃO tranca o de sudo (mesmo IP)', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => fakeLimiter());
    const cfg = resolveRateLimit({ enabled: true });
    const throttles = createAuthThrottles(cfg)!;

    const passaramLogin = await gastar(throttles.login, '5.6.7.8', cfg.login.points + 5);
    assert.equal(passaramLogin, cfg.login.points, 'o bucket de login deve ter travado no teto');

    const passaramSudo = await gastar(throttles.sudo, '5.6.7.8', cfg.sudo.points);
    assert.equal(
      passaramSudo,
      cfg.sudo.points,
      'quem já está logado não pode perder a confirmação por causa de um ataque ao login',
    );
  });

  test('separar a contagem não afrouxa o teto: sudo tem os mesmos limites do login', ({
    assert,
  }) => {
    const cfg = resolveRateLimit({ enabled: true });
    assert.deepEqual(cfg.sudo, cfg.login);
  });

  test('o bucket de sudo continua keyed por IP — outro IP não é afetado', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => fakeLimiter());
    const cfg = resolveRateLimit({ enabled: true });
    const throttles = createAuthThrottles(cfg)!;

    await gastar(throttles.sudo, '1.1.1.1', cfg.sudo.points + 5);

    const outroIp = await gastar(throttles.sudo, '2.2.2.2', cfg.sudo.points);
    assert.equal(outroIp, cfg.sudo.points);
  });
});
