/**
 * Plan 003 — o gate de status de conta (`isDisabled`/`isPasswordExpired`/
 * `isAccountExpired`) só era checado em `attemptPasswordLogin`. Todo outro
 * jeito de completar o login (magic link, OTP, passkey) chamava
 * `completeLogin` direto, sem consultar o status da conta — um admin que
 * desabilita uma conta acreditava ter revogado o acesso, mas nos deployments
 * passwordless (que esta lib explicitamente suporta) o botão não fazia nada.
 *
 * Estes testes dirigem o InteractionController real (magicLinkConsume,
 * otpVerify, passkeyVerify) com o padrão fake-ctx + render capturado (igual a
 * `otp_login_selector.spec.ts`), substituindo só o accountStore e a sessão.
 *
 * PROVA DE MUTAÇÃO (Step 5 do plano): reverter a chamada do gate no magic link
 * e confirmar que o teste de "disabled" vira vermelho é o que atesta que este
 * teste é load-bearing — feito manualmente fora deste arquivo (ver relatório).
 */

import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';

const EMAIL = 'user@example.com';
const ACCOUNT_ID = 'acc-1';
const MFA_PENDING_KEY = 'authkit_mfa_pending';
const SESSION_KEY = 'authkit_login_email';
const PASSKEY_AUTH_CHALLENGE_KEY = 'authkit_passkey_auth_challenge';

/** DB sem tabela `auth_settings` → RuntimeSettings degrada para os defaults do config. */
function noTableDb() {
  return {
    from() {
      return (this as any).table();
    },
    table() {
      throw new Error('no table');
    },
  };
}

/**
 * `lucid.db` mínimo servindo a tabela `auth_settings` — mesmo shape de
 * `tests/host/account_status_gate_social.spec.ts`. Usado para ligar uma runtime
 * setting pelo caminho REAL (`resolveRuntimeSettings`), sem injetar no gate.
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

type StoreOpts = {
  /** `disableAccount` presente = supportsAccountStatus() true. Omitir → sem a capacidade (degrada p/ "allowed"). */
  statusCapability?: boolean;
  disabled?: boolean;
  /**
   * Presente → o store declara `getPasswordChangedAt` (supportsPasswordExpiration).
   * `null` = a coluna `password_changed_at` é NULL, que é o que uma conta que
   * nunca definiu senha produz.
   */
  passwordChangedAt?: Date | null;
};

function makeStore(opts: StoreOpts = {}) {
  const account = {
    id: ACCOUNT_ID,
    email: EMAIL,
    name: 'Test User',
    avatarUrl: null,
    globalRoles: ['USER'],
  };
  const store: any = {
    findById: async (id: string) => (id === account.id ? account : null),
    findByEmail: async (email: string) => (email === account.email ? account : null),
    verifyCredentials: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    // Magic link
    issueMagicLinkToken: async () => null,
    consumeMagicLinkToken: async (token: string) => (token === 'good-token' ? account : null),
    // OTP
    issueMagicLinkWithCode: async () => null,
    verifyLoginCode: async () => ({ status: 'ok' as const, account }),
    // Passkey (passkey-first: precisa listPasskeys p/ hasPasskeys() achar credenciais)
    listPasskeys: async () => [{ id: 'cred-1' }],
    verifyPasskeyAuthentication: async () => true,
  };
  if (opts.statusCapability) {
    store.disableAccount = async () => {};
    store.enableAccount = async () => {};
    store.isDisabled = async () => opts.disabled === true;
  }
  if ('passwordChangedAt' in opts) {
    store.getPasswordChangedAt = async () => opts.passwordChangedAt ?? null;
  }
  return store;
}

function buildService(store: any) {
  const rendered: Array<{ view: string; props: Record<string, any> }> = [];
  const auditEvents: any[] = [];
  const completeLoginCalls: any[] = [];
  const config: any = {
    render: async (_ctx: any, view: string, props: Record<string, any>) => {
      rendered.push({ view, props });
      return { view, props };
    },
    messages: {},
    branding: {
      default: { appName: 'Acme', logoUrl: null },
      clients: {},
      firstParty: [],
      company: undefined,
    },
    botProtection: undefined,
    passwordless: resolvePasswordless({ magicLink: true, passkeyFirst: true }),
    login: resolveLogin({ otp: { enabled: true } }),
    registration: { enabled: true },
    social: undefined,
    authMethods: undefined,
    accountStore: store,
    audit: { record: async (e: any) => auditEvents.push(e) },
    notifications: { newLoginEmail: false, newDeviceEmail: false },
    trustedDevices: { enabled: false, days: 30 },
  };
  const interactions = {
    details: async () => ({
      uid: 'test-uid',
      params: { client_id: 'web' },
      prompt: { name: 'login' },
    }),
    completeLogin: async (...args: any[]) => {
      completeLoginCalls.push(args);
    },
  };
  return { service: { config, interactions }, rendered, auditEvents, completeLoginCalls };
}

function fakeCtx(
  service: any,
  session: Record<string, unknown>,
  opts: {
    input?: (k: string, def?: any) => any;
    qs?: () => Record<string, any>;
    /** Sem `db`, cai no `noTableDb()` (settings degradam para os defaults do config). */
    db?: any;
  } = {},
) {
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return opts.db ?? noTableDb();
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: (_k: string) => 'test-uid',
      only: () => ({}),
      input: opts.input ?? ((_k: string, def?: any) => def),
      qs: opts.qs ?? (() => ({})),
      ip: () => '1.2.3.4',
      header: () => undefined,
    },
    session: {
      get: (k: string) => session[k],
      put: (k: string, v: unknown) => {
        session[k] = v;
      },
      forget: (k: string) => {
        delete session[k];
      },
    },
    response: { redirect: (_url: string) => undefined },
  } as any;
}

test.group('account status gate — magic link (magicLinkConsume)', () => {
  test('conta desabilitada: NÃO completa o login, re-renderiza com erro', async ({ assert }) => {
    const store = makeStore({ statusCapability: true, disabled: true });
    const { service, rendered, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, {}, { qs: () => ({ token: 'good-token' }) });

    await new InteractionController().magicLinkConsume(ctx);

    assert.lengthOf(completeLoginCalls, 0, 'completeLogin não deveria ter sido chamado');
    assert.equal(rendered[0]?.view, 'login');
    assert.equal(rendered[0]?.props.error, 'errors.account_disabled');
  });

  test('conta saudável: completa o login normalmente', async ({ assert }) => {
    const store = makeStore({ statusCapability: true, disabled: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, {}, { qs: () => ({ token: 'good-token' }) });

    await new InteractionController().magicLinkConsume(ctx);

    assert.lengthOf(completeLoginCalls, 1);
    assert.equal(completeLoginCalls[0][1], ACCOUNT_ID);
  });

  test('store sem a capacidade de status: degrada para "allowed" (login prossegue)', async ({
    assert,
  }) => {
    const store = makeStore({ statusCapability: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, {}, { qs: () => ({ token: 'good-token' }) });

    await new InteractionController().magicLinkConsume(ctx);

    assert.lengthOf(completeLoginCalls, 1, 'sem supportsAccountStatus, o login deve prosseguir');
  });

  /**
   * Plan 012, Step 4 — o mesmo defeito do callback social vale aqui. O magic
   * link é um fluxo SEM senha: a conta pode nunca ter definido uma (conta
   * importada via `importAccount`, que não escreve `password_changed_at`; conta
   * anterior à migração da coluna; provisionamento próprio do host), e
   * `isPasswordExpired` trata a coluna NULL como "vencida".
   *
   * O re-render de `login` com `step: 'password'` NÃO é uma saída para essa
   * conta: o único caminho até a troca obrigatória (`step: 'password_expired'`)
   * passa por `attemptPasswordLogin`, que exige a senha CORRETA antes de
   * classificar a expiração. Sem senha, o usuário só pode pedir outro magic
   * link — e cai no mesmo bloqueio. Loop permanente, igual ao social.
   */
  test('conta sem senha + password_expiration ligada: COMPLETA o login (fluxo passwordless)', async ({
    assert,
  }) => {
    const store = makeStore({ statusCapability: true, disabled: false, passwordChangedAt: null });
    const { service, completeLoginCalls, auditEvents } = buildService(store);
    const ctx = fakeCtx(
      service,
      {},
      {
        qs: () => ({ token: 'good-token' }),
        db: fakeSettingsDb({ password_expiration: { enabled: true, maxAgeDays: 90 } }),
      },
    );

    await new InteractionController().magicLinkConsume(ctx);

    assert.lengthOf(
      completeLoginCalls,
      1,
      'conta sem senha não pode ser bloqueada por senha vencida no magic link',
    );
    assert.isFalse(
      auditEvents.some((e) => e.type === 'password.expired_change_forced'),
      `magic link não pode forçar troca de senha; eventos: ${JSON.stringify(auditEvents)}`,
    );
  });
});

test.group('account status gate — OTP (otpVerify)', () => {
  test('conta desabilitada: NÃO completa o login, re-renderiza com erro', async ({ assert }) => {
    const store = makeStore({ statusCapability: true, disabled: true });
    const { service, rendered, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: EMAIL },
      { input: (k: string, def?: any) => (k === 'code' ? '123456' : def) },
    );

    await new InteractionController().otpVerify(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.props.error, 'errors.account_disabled');
  });

  test('conta saudável: completa o login normalmente', async ({ assert }) => {
    const store = makeStore({ statusCapability: true, disabled: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: EMAIL },
      { input: (k: string, def?: any) => (k === 'code' ? '123456' : def) },
    );

    await new InteractionController().otpVerify(ctx);

    assert.lengthOf(completeLoginCalls, 1);
  });
});

test.group('account status gate — passkey (passkeyVerify, passkey-first)', () => {
  test('conta desabilitada: NÃO completa o login, re-renderiza mfa-challenge com erro', async ({
    assert,
  }) => {
    const store = makeStore({ statusCapability: true, disabled: true });
    const { service, rendered, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: EMAIL, [PASSKEY_AUTH_CHALLENGE_KEY]: 'chal-1' },
      {
        input: (k: string, def?: any) =>
          k === 'response' ? JSON.stringify({ id: 'cred-1' }) : def,
      },
    );

    await new InteractionController().passkeyVerify(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
    assert.equal(rendered[0]?.props.error, 'errors.account_disabled');
  });

  test('conta saudável: completa o login normalmente', async ({ assert }) => {
    const store = makeStore({ statusCapability: true, disabled: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: EMAIL, [PASSKEY_AUTH_CHALLENGE_KEY]: 'chal-1' },
      {
        input: (k: string, def?: any) =>
          k === 'response' ? JSON.stringify({ id: 'cred-1' }) : def,
      },
    );

    await new InteractionController().passkeyVerify(ctx);

    assert.lengthOf(completeLoginCalls, 1);
    assert.equal(completeLoginCalls[0][1], ACCOUNT_ID);
  });
});
