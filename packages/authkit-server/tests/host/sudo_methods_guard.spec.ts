/**
 * Barreiras dos handlers dos métodos de sudo.
 *
 * Cobre os achados de segurança do review da Task 4:
 *  - `config.sudo.methods` precisa DESABILITAR de fato o endpoint do método;
 *  - os handlers de passkey precisam exigir `c.account`;
 *  - as rotas dos métodos precisam ficar sob o `accountGuard` (idle timeout);
 *  - em POST, o `return_to` do corpo tem precedência sobre a query string.
 */

import { test } from '@japa/runner';
import { sudoContextFrom } from '../../src/host/controllers/account_confirm_controller.js';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';
import { CONFIRM_PASSKEY_CHALLENGE_KEY, passkey } from '../../src/host/sudo/methods/passkey.js';
import { password } from '../../src/host/sudo/methods/password.js';
import { completeSudo, fail } from '../../src/host/sudo/runtime.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

const ACCOUNT = { id: 'acc-1', email: 'user@example.com' };

/** Captura os handlers registrados pelos métodos built-in, por `"<VERBO> <path>"`. */
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
  const helpers = { contextFrom: sudoContextFrom, completeSudo, fail };
  password().register!(router, helpers);
  passkey().register!(router, helpers);
  return routes;
}

function fakeCtx(
  opts: {
    input?: Record<string, unknown>;
    qs?: Record<string, unknown>;
    method?: string;
    session?: Record<string, unknown>;
    cfg?: Record<string, unknown>;
  } = {},
) {
  const session: Record<string, unknown> = { [ACCOUNT_SESSION_KEY]: ACCOUNT.id, ...opts.session };
  const flashed: Record<string, unknown> = {};
  const redirects: string[] = [];
  const notFounds: unknown[] = [];

  const cfg = {
    messages: { ...DEFAULT_MESSAGES },
    render: async () => ({}),
    accountStore: {
      async findById(id: string) {
        return id === ACCOUNT.id ? ACCOUNT : null;
      },
      async verifyCredentials(email: string, pwd: string) {
        return email === ACCOUNT.email && pwd === 'correta';
      },
      async __getRawRow() {
        return { password: 'hash-existente' };
      },
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
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, opts.input?.[k]])),
      input: (k: string) => opts.input?.[k],
      qs: () => opts.qs ?? {},
      ip: () => '203.0.113.1',
    },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
        return { _redirect: url };
      },
      notFound: (body?: unknown) => {
        notFounds.push(body ?? null);
        return { _notFound: body ?? null };
      },
      unauthorized: (body?: unknown) => ({ _unauthorized: body ?? null }),
    },
    containerResolver: { make: async () => ({ config: cfg }) },
  } as any;

  return { ctx, cfg, session, flashed, redirects, notFounds };
}

/** AccountStore "discoverable/usernameless": resolve a credencial pelo rawId, não pela conta. */
const discoverableStore = {
  async findById() {
    return null;
  },
  listPasskeys: async () => [{ id: 'pk-1' }],
  generatePasskeyAuthenticationOptions: async () => ({ challenge: 'chal-1', options: {} }),
  // Ignora o accountId — é justamente o store de terceiro que o review descreve.
  async verifyPasskeyAuthentication() {
    return true;
  },
};

test.group('sudo — config.sudo.methods desabilita o endpoint (Critical 1)', () => {
  test('senha correta NÃO concede sudo quando password está fora de config.sudo.methods', async ({
    assert,
  }) => {
    const h = fakeCtx({
      input: { password: 'correta' },
      cfg: { sudo: { methods: [passkey()] } },
    });
    await captureHandlers().get('POST /account/confirm')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
  });

  test('senha correta CONTINUA concedendo sudo sem config.sudo.methods (contraprova)', async ({
    assert,
  }) => {
    const h = fakeCtx({ input: { password: 'correta' } });
    await captureHandlers().get('POST /account/confirm')!(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
  });

  test('assertion válida NÃO concede sudo quando passkey está fora de config.sudo.methods', async ({
    assert,
  }) => {
    const h = fakeCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      session: { [CONFIRM_PASSKEY_CHALLENGE_KEY]: 'chal-1' },
      cfg: {
        sudo: { methods: [password()] },
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          listPasskeys: async () => [{ id: 'pk-1' }],
          generatePasskeyAuthenticationOptions: async () => ({ challenge: 'chal-1', options: {} }),
          async verifyPasskeyAuthentication() {
            return true;
          },
        },
      },
    });
    await captureHandlers().get('POST /account/confirm/passkey')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
  });

  test('options de passkey não emite challenge quando passkey está fora de config.sudo.methods', async ({
    assert,
  }) => {
    const h = fakeCtx({
      cfg: {
        sudo: { methods: [password()] },
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          listPasskeys: async () => [{ id: 'pk-1' }],
          generatePasskeyAuthenticationOptions: async () => ({ challenge: 'chal-1', options: {} }),
        },
      },
    });
    await captureHandlers().get('POST /account/confirm/passkey/options')!(h.ctx);

    assert.isUndefined(h.session[CONFIRM_PASSKEY_CHALLENGE_KEY]);
    assert.lengthOf(h.notFounds, 1);
  });
});

test.group('sudo — handlers de passkey exigem a conta (Critical 2)', () => {
  test('assertion válida com conta inexistente NÃO concede sudo', async ({ assert }) => {
    const h = fakeCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      session: { [CONFIRM_PASSKEY_CHALLENGE_KEY]: 'chal-1' },
      cfg: { accountStore: discoverableStore },
    });
    await captureHandlers().get('POST /account/confirm/passkey')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
    assert.isNotNull(h.flashed.confirmError);
  });

  test('options com conta inexistente não emite challenge', async ({ assert }) => {
    const h = fakeCtx({ cfg: { accountStore: discoverableStore } });
    await captureHandlers().get('POST /account/confirm/passkey/options')!(h.ctx);

    assert.isUndefined(h.session[CONFIRM_PASSKEY_CHALLENGE_KEY]);
    assert.lengthOf(h.notFounds, 1);
  });
});

/**
 * VINCULAÇÃO DO CHALLENGE À CONTA EMISSORA.
 *
 * Mesma exposição do pendente do magic link de sudo: a sessão sobrevive ao
 * logout — o `regenerate()` do @adonisjs/session troca o id e MIGRA os dados.
 * Num navegador compartilhado, o challenge pedido por A continua lá depois que
 * B loga, e sem a vinculação a assertion de A é verificada contra a conta de B.
 */
test.group('sudo — challenge de passkey vinculado à conta emissora (Critical)', () => {
  const OUTRA = { id: 'acc-2', email: 'outra@example.com' };

  const duasContas = {
    async findById(id: string) {
      if (id === ACCOUNT.id) return ACCOUNT;
      return id === OUTRA.id ? OUTRA : null;
    },
    listPasskeys: async () => [{ id: 'pk-1' }],
    generatePasskeyAuthenticationOptions: async () => ({ challenge: 'chal-1', options: {} }),
    // Aceita qualquer assertion — isola a barreira sob teste da verificação
    // WebAuthn, e é o comportamento real de um store discoverable/usernameless.
    async verifyPasskeyAuthentication() {
      return true;
    },
  };

  test('challenge pedido por A não concede sudo depois que B loga no mesmo navegador', async ({
    assert,
  }) => {
    const h = fakeCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      cfg: { accountStore: duasContas },
    });
    const routes = captureHandlers();

    await routes.get('POST /account/confirm/passkey/options')!(h.ctx);
    assert.equal(h.session[CONFIRM_PASSKEY_CHALLENGE_KEY], 'chal-1');

    // Logout de A + login de B: o challenge de A CONTINUA na sessão.
    h.session[ACCOUNT_SESSION_KEY] = OUTRA.id;

    await routes.get('POST /account/confirm/passkey')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
    assert.isNotNull(h.flashed.confirmError);
    // A recusa também limpa o par challenge/vinculação.
    assert.isUndefined(h.session[CONFIRM_PASSKEY_CHALLENGE_KEY]);
  });

  test('challenge SEM vinculação não concede sudo (fail-closed)', async ({ assert }) => {
    // Challenge solto na sessão, sem a chave de vinculação — a forma que uma
    // sessão de versão anterior (ou escrita por fora) deixa para trás. Se a
    // checagem tolerasse `undefined`, bastaria apagar a vinculação para anular
    // a barreira; por isso a ausência é recusa, não permissão.
    const h = fakeCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      session: { [CONFIRM_PASSKEY_CHALLENGE_KEY]: 'chal-1' },
      cfg: { accountStore: duasContas },
    });

    await captureHandlers().get('POST /account/confirm/passkey')!(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.lengthOf(h.cfg.audit.records, 0);
    assert.isNotNull(h.flashed.confirmError);
    assert.isUndefined(h.session[CONFIRM_PASSKEY_CHALLENGE_KEY]);
  });

  test('contraprova: sem troca de conta o mesmo fluxo concede sudo', async ({ assert }) => {
    const h = fakeCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      cfg: { accountStore: duasContas },
    });
    const routes = captureHandlers();

    await routes.get('POST /account/confirm/passkey/options')!(h.ctx);
    await routes.get('POST /account/confirm/passkey')!(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
  });
});

test.group('sudo — return_to em POST: corpo tem precedência (Minor 4)', () => {
  test('o corpo vence a query string no POST', async ({ assert }) => {
    const h = fakeCtx({
      method: 'POST',
      input: { password: 'correta', return_to: '/account/security' },
      qs: { return_to: '/account/tokens' },
    });
    await captureHandlers().get('POST /account/confirm')!(h.ctx);

    assert.deepEqual(h.redirects, ['/account/security']);
  });

  test('a query string ainda vale no POST quando o corpo não traz return_to', async ({
    assert,
  }) => {
    const h = fakeCtx({
      method: 'POST',
      input: { password: 'correta' },
      qs: { return_to: '/account/tokens' },
    });
    await captureHandlers().get('POST /account/confirm')!(h.ctx);

    assert.deepEqual(h.redirects, ['/account/tokens']);
  });
});

/**
 * Router falso que registra a QUAL grupo cada rota pertence. `registerAuthHost`
 * não aninha grupos, então um contador simples basta.
 */
function groupTrackingRouter() {
  const routes: Array<{ key: string; group: number | null }> = [];
  let current: number | null = null;
  let seq = 0;

  const mk = (verb: string) => (pattern: string) => {
    routes.push({ key: `${verb} ${pattern}`, group: current });
    const chain: any = { as: () => chain, middleware: () => chain, use: () => chain };
    return chain;
  };

  const groupChain: any = {
    as: () => groupChain,
    prefix: () => groupChain,
    middleware: () => groupChain,
    use: () => groupChain,
  };

  return {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    delete: mk('DELETE'),
    put: mk('PUT'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      const previous = current;
      current = seq++;
      cb();
      current = previous;
      return groupChain;
    },
    routes,
  } as any;
}

test.group('sudo — rotas dos métodos sob o accountGuard (Important 3)', () => {
  test('POST /account/confirm está no mesmo grupo guardado que /account/tokens', ({ assert }) => {
    const router = groupTrackingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const guarded = router.routes.find((r: any) => r.key === 'GET /account/tokens');
    const confirmPost = router.routes.find((r: any) => r.key === 'POST /account/confirm');
    const passkeyPost = router.routes.find((r: any) => r.key === 'POST /account/confirm/passkey');
    const passkeyOptions = router.routes.find(
      (r: any) => r.key === 'POST /account/confirm/passkey/options',
    );

    assert.isNotNull(guarded.group);
    assert.equal(confirmPost.group, guarded.group);
    assert.equal(passkeyPost.group, guarded.group);
    assert.equal(passkeyOptions.group, guarded.group);
  });
});
