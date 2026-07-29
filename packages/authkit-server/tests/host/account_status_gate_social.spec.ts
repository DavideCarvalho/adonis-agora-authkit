/**
 * Plan 003 — mesma checagem que `account_status_gate.spec.ts`, mas para o
 * callback do login social (`AuthSocialController#callback`). Este era o
 * caminho MAIS desprotegido de todos: nenhuma auditoria de falha existia
 * aqui antes desta mudança (nem para o caso "sem e-mail").
 */

import { test } from '@japa/runner';
import AuthSocialController from '../../src/host/controllers/social_controller.js';

const PROVIDER = 'google';
const ACCOUNT_ID = 'acc-1';
const EMAIL = 'user@example.com';

function makeStore(opts: { disabled?: boolean } = {}) {
  const account = { id: ACCOUNT_ID, email: EMAIL, name: 'Test User', globalRoles: ['USER'] };
  return {
    findById: async (id: string) => (id === account.id ? account : null),
    findByProviderIdentity: async () => account,
    linkProviderIdentity: async () => {},
    disableAccount: async () => {},
    enableAccount: async () => {},
    isDisabled: async () => opts.disabled === true,
  } as any;
}

/**
 * `lucid.db` mínimo servindo a tabela `auth_settings` — mesmo padrão de
 * `tests/host/registration_toggles.spec.ts`. Usado para que o callback social
 * resolva runtime settings pelo caminho REAL (`resolveRuntimeSettings(ctx)`),
 * em vez de receber um `SettingsCapability` fabricado pelo teste.
 */
function fakeSettingsDb(rows: Record<string, any> = {}) {
  const store = new Map<string, string>(
    Object.entries(rows).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  function makeChain(filters: Array<{ col: string; val: string | null }>) {
    return {
      where(col: string, val: string) {
        return makeChain([...filters, { col, val }]);
      },
      whereNull(col: string) {
        return makeChain([...filters, { col, val: null }]);
      },
      async first() {
        const keyFilter = filters.find((f) => f.col === 'key');
        if (!keyFilter?.val) return null;
        const value = store.get(keyFilter.val);
        return value === undefined ? null : { key: keyFilter.val, value };
      },
    };
  }
  return {
    from(...args: any[]) {
      return (this as any).table(...args);
    },
    table(_n: string) {
      return {
        // Probe: select().limit() resolve → tabela considerada presente.
        select(_cols?: string) {
          return { limit: (_n2: number) => Promise.resolve([]) };
        },
        where(col: string, val: string) {
          return makeChain([{ col, val }]);
        },
        whereNull(col: string) {
          return makeChain([{ col, val: null }]);
        },
      };
    },
  };
}

function buildService(store: any, extraConfig: Record<string, unknown> = {}) {
  const completeLoginCalls: any[] = [];
  const config: any = { accountStore: store, ...extraConfig };
  const interactions = {
    completeLogin: async (...args: any[]) => {
      completeLoginCalls.push(args);
    },
  };
  return { service: { config, interactions }, completeLoginCalls };
}

function fakeCtx(
  service: any,
  session: Record<string, unknown> = { authkit_social_uid: 'test-uid' },
  db?: any,
) {
  const redirects: string[] = [];
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        // Sem `db`, `lucid.db` LANÇA — é o host sem tabela de settings, e é
        // exatamente o que os casos pré-existentes exercitam (degradação no-op).
        if (key === 'lucid.db' && db) return db;
        throw new Error(`unknown: ${key}`);
      },
    },
    request: { param: (_k: string) => PROVIDER },
    session: {
      get: (k: string) => session[k],
      forget: (k: string) => {
        delete session[k];
      },
    },
    ally: {
      use: (_name: string) => ({
        accessDenied: () => false,
        stateMisMatch: () => false,
        hasError: () => false,
        user: async () => ({ id: 'provider-uid-1', email: EMAIL, name: 'Test User' }),
      }),
    },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
      },
    },
    __redirects: redirects,
  } as any;
}

test.group('account status gate — social login callback', () => {
  test('conta desabilitada: NÃO completa o login, redireciona de volta ao login', async ({
    assert,
  }) => {
    const store = makeStore({ disabled: true });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, ['/auth/interaction/test-uid']);
  });

  test('conta saudável: completa o login normalmente', async ({ assert }) => {
    const store = makeStore({ disabled: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
    assert.equal(completeLoginCalls[0][1], ACCOUNT_ID);
  });

  test('store sem a capacidade de status: degrada para "allowed" (login prossegue)', async ({
    assert,
  }) => {
    const account = { id: ACCOUNT_ID, email: EMAIL, name: 'Test User', globalRoles: ['USER'] };
    const store = {
      findById: async (id: string) => (id === account.id ? account : null),
      findByProviderIdentity: async () => account,
      linkProviderIdentity: async () => {},
    } as any;
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
  });

  /**
   * Plan 011 — o callback social chamava `assertLoginAllowed` SEM `settings`,
   * e `assertAccountNotExpired` guarda as duas checagens de expiração atrás de
   * `if (settings)`. Resultado: a política `account_expiration` (bloquear conta
   * inativa há mais de `inactiveDays`) era no-op só neste caminho — "Continue
   * with Google" driblava uma política de controle de acesso que o operador
   * acredita estar valendo em todo lugar.
   *
   * O setup de expiração espelha `tests/host/account_status_gate_expiry.spec.ts`
   * (setting `account_expiration` + último `login.success` velho no audit), só
   * que aqui a setting chega pelo caminho de produção (`lucid.db` →
   * `resolveRuntimeSettings`), não injetada direto no gate.
   */
  test('conta expirada por inatividade: NÃO completa o login social', async ({ assert }) => {
    const store = makeStore({ disabled: false });
    const oldLogin = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400 dias atrás
    const recorded: any[] = [];
    const audit = {
      record: async (e: any) => {
        recorded.push(e);
      },
      list: async () => ({ data: [{ createdAt: oldLogin }], total: 1 }),
    };
    const { service, completeLoginCalls } = buildService(store, { audit });
    const db = fakeSettingsDb({ account_expiration: { enabled: true, inactiveDays: 365 } });
    const ctx = fakeCtx(service, { authkit_social_uid: 'test-uid' }, db);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 0, 'login social de conta expirada NÃO pode ser concluído');
    assert.deepEqual(ctx.__redirects, ['/auth/interaction/test-uid']);
    // O mesmo evento que os outros fluxos emitem passa a ser alcançável aqui.
    assert.isTrue(
      recorded.some((e) => e.type === 'account.expired_login_blocked'),
      `esperava account.expired_login_blocked; eventos: ${JSON.stringify(recorded)}`,
    );
  });
});
