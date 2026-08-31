import { test } from '@japa/runner';
import AccountConfirmController, {
  sudoContextFrom,
} from '../../src/host/controllers/account_confirm_controller.js';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import {
  CONFIRM_PASSKEY_CHALLENGE_ACCOUNT_KEY,
  passkey,
} from '../../src/host/sudo/methods/passkey.js';
import { password } from '../../src/host/sudo/methods/password.js';
import { completeSudo, fail, setMountedSudoMethods } from '../../src/host/sudo/runtime.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

const ACCOUNT = { id: 'acc-1', email: 'user@example.com' };

// Global Constraint do plano: o VALOR desta chave de sessão é contratual e
// não pode mudar (quebraria hosts que dependem do comportamento pinado por
// este arquivo). Não virou import porque a constante não é exportada por
// `src/` hoje — o literal fica pinado aqui de propósito.
const CHALLENGE_KEY = 'authkit_confirm_passkey_challenge';

// O emissor do pacote grava SEMPRE o par challenge + conta emissora, e o
// consumidor recusa challenge sem vinculação (fail-closed). As fixtures de
// sessão abaixo montam o par para reproduzir o que o endpoint de options
// realmente escreve; as asserções pinadas seguem intactas. A chave da
// vinculação vem por import de propósito — só o valor de CHALLENGE_KEY é
// contratual e fica pinado como literal.

/**
 * Contexto HTTP mínimo para o controller. Captura o que foi renderizado,
 * redirecionado e flashado, para os testes assertarem sobre isso.
 */
function fakeConfirmCtx(
  opts: {
    input?: Record<string, unknown>;
    qs?: Record<string, unknown>;
    session?: Record<string, unknown>;
    cfg?: Record<string, unknown>;
  } = {},
) {
  // Sem `config.sudo.methods`, a lista da TELA é a lista MONTADA (é assim que
  // os dois lados param de divergir — ver `configuredSudoMethods`). No boot
  // real quem a preenche é `registerAuthHost`; aqui o controller é exercido
  // isolado, então a fixture reproduz o mesmo estado de boot: os defaults.
  // Fica DENTRO da fixture de propósito — outras specs do mesmo processo também
  // montam listas, e o teste não pode depender da ordem dos arquivos.
  setMountedSudoMethods([password(), passkey()]);

  const session: Record<string, unknown> = { [ACCOUNT_SESSION_KEY]: ACCOUNT.id, ...opts.session };
  const flashed: Record<string, unknown> = {};
  const rendered: Array<{ view: string; props: Record<string, unknown> }> = [];
  const redirects: string[] = [];

  const cfg = {
    messages: { ...DEFAULT_MESSAGES },
    render: async (_c: unknown, view: string, props: Record<string, unknown>) => {
      rendered.push({ view, props });
      return { _rendered: view };
    },
    accountStore: {
      async findById(id: string) {
        return id === ACCOUNT.id ? ACCOUNT : null;
      },
      async verifyCredentials(email: string, password: string) {
        return email === ACCOUNT.email && password === 'correta';
      },
      async __getRawRow(_id: string) {
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
      _data: session,
    },
    request: {
      csrfToken: 'csrf-token',
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
      notFound: (body: unknown) => ({ _notFound: body }),
    },
    containerResolver: { make: async (_k: string) => ({ config: cfg }) },
  } as any;

  return { ctx, cfg, session, flashed, rendered, redirects };
}

// ---------------------------------------------------------------------------
// SEAM DE INVOCAÇÃO
//
// Estes três helpers são o ÚNICO ponto deste arquivo que a Task 4 pode editar.
// Hoje chamam os métodos do controller; depois do refactor chamam os handlers
// de rota registrados pelos SudoMethod. As asserções abaixo NUNCA mudam — o que
// está pinado é o comportamento na URL, não a API interna do controller.
// ---------------------------------------------------------------------------

/** Router falso: captura os handlers que os métodos registram, por path. */
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

async function invokeConfirmShow(ctx: any) {
  return new AccountConfirmController().show(ctx);
}

/** Equivale a `POST /account/confirm`. */
async function invokeConfirmPassword(ctx: any) {
  return captureHandlers().get('POST /account/confirm')!(ctx);
}

/** Equivale a `POST /account/confirm/passkey`. */
async function invokeConfirmPasskey(ctx: any) {
  return captureHandlers().get('POST /account/confirm/passkey')!(ctx);
}

test.group('confirmação de identidade — comportamento pinado', () => {
  test('a tela de confirm é renderizada com csrfToken e returnTo', async ({ assert }) => {
    const h = fakeConfirmCtx({ qs: { return_to: '/account/security' } });
    await invokeConfirmShow(h.ctx);

    assert.lengthOf(h.rendered, 1);
    assert.equal(h.rendered[0].view, 'account/confirm');
    assert.equal(h.rendered[0].props.csrfToken, 'csrf-token');
    assert.equal(h.rendered[0].props.returnTo, '/account/security');
  });

  test('a tela rejeita return_to externo (open-redirect)', async ({ assert }) => {
    const h = fakeConfirmCtx({ qs: { return_to: 'https://evil.com' } });
    await invokeConfirmShow(h.ctx);
    assert.isNull(h.rendered[0].props.returnTo);
  });

  test('senha correta concede sudo e redireciona pro returnTo', async ({ assert }) => {
    const h = fakeConfirmCtx({ input: { password: 'correta', return_to: '/account/security' } });
    await invokeConfirmPassword(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
    assert.deepEqual(h.redirects, ['/account/security']);
  });

  test('senha correta é auditada com method=password', async ({ assert }) => {
    const h = fakeConfirmCtx({ input: { password: 'correta' } });
    await invokeConfirmPassword(h.ctx);

    assert.lengthOf(h.cfg.audit.records, 1);
    assert.deepInclude(h.cfg.audit.records[0], { type: 'sudo.confirmed', accountId: ACCOUNT.id });
    assert.deepEqual((h.cfg.audit.records[0] as any).metadata, { method: 'password' });
  });

  test('senha errada NÃO concede sudo, flasha erro e volta pro confirm', async ({ assert }) => {
    const h = fakeConfirmCtx({ input: { password: 'errada', return_to: '/account/security' } });
    await invokeConfirmPassword(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.isNotNull(h.flashed.confirmError);
    assert.deepEqual(h.redirects, ['/account/confirm?return_to=%2Faccount%2Fsecurity']);
  });

  test('senha ausente NÃO concede sudo', async ({ assert }) => {
    const h = fakeConfirmCtx({ input: {} });
    await invokeConfirmPassword(h.ctx);
    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
  });

  test('passkey sem challenge na sessão NÃO concede sudo', async ({ assert }) => {
    const h = fakeConfirmCtx({ input: { response: '{}' } });
    await invokeConfirmPasskey(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.isNotNull(h.flashed.confirmError);
  });

  test('passkey válida concede sudo e é auditada com method=passkey', async ({ assert }) => {
    const h = fakeConfirmCtx({
      input: { response: JSON.stringify({ id: 'cred' }), return_to: '/account/security' },
      session: { [CHALLENGE_KEY]: 'chal-1', [CONFIRM_PASSKEY_CHALLENGE_ACCOUNT_KEY]: ACCOUNT.id },
      cfg: {
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          listPasskeys: async () => [{ id: 'pk-1' }],
          generatePasskeyAuthenticationOptions: async () => ({}),
          async verifyPasskeyAuthentication() {
            return true;
          },
        },
      },
    });
    await invokeConfirmPasskey(h.ctx);

    assert.isNumber(h.session[SUDO_SESSION_KEY]);
    assert.deepEqual((h.cfg.audit.records[0] as any).metadata, { method: 'passkey' });
    // Espelha o teste equivalente de senha: garante que o refactor não desvie
    // o redirect final do fluxo de passkey do returnTo esperado.
    assert.deepEqual(h.redirects, ['/account/security']);
  });

  test('passkey inválida NÃO concede sudo e limpa o challenge', async ({ assert }) => {
    const h = fakeConfirmCtx({
      input: { response: JSON.stringify({ id: 'cred' }) },
      session: { [CHALLENGE_KEY]: 'chal-1', [CONFIRM_PASSKEY_CHALLENGE_ACCOUNT_KEY]: ACCOUNT.id },
      cfg: {
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          listPasskeys: async () => [{ id: 'pk-1' }],
          generatePasskeyAuthenticationOptions: async () => ({}),
          async verifyPasskeyAuthentication() {
            return false;
          },
        },
      },
    });
    await invokeConfirmPasskey(h.ctx);

    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
    assert.isUndefined(h.session[CHALLENGE_KEY]);
  });
});

test.group('AccountConfirmController — SPI de métodos', () => {
  test('show entrega descritores dos métodos disponíveis', async ({ assert }) => {
    const h = fakeConfirmCtx();
    await new AccountConfirmController().show(h.ctx);

    const methods = h.rendered[0].props.methods as Array<{ id: string }>;
    assert.isArray(methods);
    assert.include(
      methods.map((m) => m.id),
      'password',
    );
  });

  test('show omite password quando a conta não tem hash', async ({ assert }) => {
    const h = fakeConfirmCtx({
      cfg: {
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          async __getRawRow() {
            return { password: '' };
          },
        },
      },
    });
    await new AccountConfirmController().show(h.ctx);

    const methods = h.rendered[0].props.methods as Array<{ id: string }>;
    assert.notInclude(
      methods.map((m) => m.id),
      'password',
    );
  });

  test('show sinaliza no_methods quando nada está disponível', async ({ assert }) => {
    const h = fakeConfirmCtx({
      cfg: {
        accountStore: {
          async findById() {
            return ACCOUNT;
          },
          async __getRawRow() {
            return { password: '' };
          },
        },
      },
    });
    await new AccountConfirmController().show(h.ctx);

    assert.lengthOf(h.rendered[0].props.methods as unknown[], 0);
  });
});
