/**
 * O gate do segundo fator só existia no login por SENHA. Link mágico e código
 * por e-mail chamavam `completeLogin(..., { amr: ['email'] })` direto, então uma
 * conta com TOTP confirmado ou passkey registrada entrava apresentando só o
 * e-mail — quem tinha ligado o 2º fator achava que tinha endurecido a conta e
 * na prática o link continuava sendo uma porta de fator único.
 *
 * `secondFactorGate` passou a ser o caminho único dos quatro fluxos (senha,
 * link, código, troca forçada de senha). Estes testes dirigem o controller real
 * com o mesmo padrão fake-ctx + render capturado de `account_status_gate.spec.ts`.
 *
 * O outro defeito coberto aqui: a decisão era `mfa.enabled`, que LIGA ao
 * registrar uma passkey e NÃO desliga ao remover a última. Quem registrava uma
 * passkey e depois a removia, sem nunca enrolar TOTP, caía num desafio de código
 * de 6 dígitos que não tinha como responder. A pergunta certa é se sobrou um
 * fator UTILIZÁVEL: `mfa.totp` (app autenticador confirmado) ou uma passkey.
 */

import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import { TRUSTED_DEVICE_COOKIE } from '../../src/host/trusted_device.js';

const EMAIL = 'user@example.com';
const ACCOUNT_ID = 'acc-1';
const SESSION_KEY = 'authkit_login_email';
const MFA_PENDING_KEY = 'authkit_mfa_pending';

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

type StoreOpts = {
  /** Estado devolvido por `getMfaState`. Ausente = store SEM a capacidade de MFA. */
  mfa?: { enabled: boolean; enabledAt?: number | null; totp?: boolean };
  /** Conta com ao menos uma passkey registrada. */
  passkeys?: boolean;
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
    issueMagicLinkToken: async () => null,
    consumeMagicLinkToken: async (token: string) => (token === 'good-token' ? account : null),
    issueMagicLinkWithCode: async () => null,
    verifyLoginCode: async () => ({ status: 'ok' as const, account }),
    listPasskeys: async () => (opts.passkeys ? [{ id: 'cred-1' }] : []),
    verifyPasskeyAuthentication: async () => true,
  };
  if (opts.mfa) {
    store.getMfaState = async () => opts.mfa;
    store.startTotpEnrollment = async () => null;
    store.confirmTotpEnrollment = async () => false;
    store.verifyTotp = async () => false;
    store.consumeRecoveryCode = async () => false;
    store.disableMfa = async () => {};
  }
  return store;
}

/** Cookie de confiança válido para a conta (mesmo shape de `buildTrustedDevicePayload`). */
function trustedCookie(now = Date.now()) {
  return { a: ACCOUNT_ID, d: 'device-1', iat: now, exp: now + 7 * 24 * 60 * 60 * 1000 };
}

function buildService(
  store: any,
  trustedDevices = { enabled: false, days: 30 },
  opts: { acrValues?: string; stepUp?: { mfaAcr: string } } = {},
) {
  const rendered: Array<{ view: string; props: Record<string, any> }> = [];
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
    audit: { record: async () => {} },
    notifications: { newLoginEmail: false, newDeviceEmail: false },
    trustedDevices,
    stepUp: opts.stepUp,
  };
  const interactions = {
    details: async () => ({
      uid: 'test-uid',
      params: {
        client_id: 'web',
        ...(opts.acrValues ? { acr_values: opts.acrValues } : {}),
      },
      prompt: { name: 'login' },
    }),
    completeLogin: async (...args: any[]) => {
      completeLoginCalls.push(args);
    },
  };
  return { service: { config, interactions }, rendered, completeLoginCalls };
}

function fakeCtx(
  service: any,
  session: Record<string, unknown>,
  opts: {
    input?: (k: string, def?: any) => any;
    qs?: () => Record<string, any>;
    /** Payload devolvido por `request.encryptedCookie(TRUSTED_DEVICE_COOKIE)`. */
    trusted?: unknown;
  } = {},
) {
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return noTableDb();
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
      encryptedCookie: (name: string) =>
        name === TRUSTED_DEVICE_COOKIE ? opts.trusted : undefined,
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

const magicCtx = (service: any, session: Record<string, unknown> = {}, trusted?: unknown) =>
  fakeCtx(service, session, { qs: () => ({ token: 'good-token' }), trusted });

const otpCtx = (service: any, trusted?: unknown) =>
  fakeCtx(
    service,
    { [SESSION_KEY]: EMAIL },
    { input: (k: string, def?: any) => (k === 'code' ? '123456' : def), trusted },
  );

test.group('gate do 2º fator — link mágico', () => {
  test('conta com TOTP confirmado: DESAFIA em vez de completar o login', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store);
    const session: Record<string, unknown> = {};

    await new InteractionController().magicLinkConsume(magicCtx(service, session));

    assert.lengthOf(completeLoginCalls, 0, 'o link não pode completar o login sozinho');
    assert.equal(rendered[0]?.view, 'mfa-challenge');
    assert.isTrue(rendered[0]?.props.totpAvailable);
    assert.equal(session[MFA_PENDING_KEY], ACCOUNT_ID, 'o accountId fica pendente para o desafio');
  });

  test('conta só com passkey: desafia, e sem campo de código', async ({ assert }) => {
    // `enabled` true sem `totp`: exatamente o que registrar uma passkey produz.
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: false }, passkeys: true });
    const { service, rendered, completeLoginCalls } = buildService(store);

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
    assert.isTrue(rendered[0]?.props.passkeyAvailable);
    assert.isFalse(rendered[0]?.props.totpAvailable, 'sem TOTP, a tela não pede código');
  });

  test('sem 2º fator: completa o login com amr `email`', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: false } });
    const { service, completeLoginCalls } = buildService(store);

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 1);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email'] });
  });

  test('passkey removida e nunca houve TOTP: login segue em vez de travar', async ({ assert }) => {
    // `mfa.enabled` continua true (remover a última passkey não o desliga); não
    // há fator utilizável, então desafiar seria trancar a conta para fora.
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: false }, passkeys: false });
    const { service, rendered, completeLoginCalls } = buildService(store);

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 1, `renderizou ${rendered[0]?.view} em vez de completar`);
  });

  test('store sem a capacidade de MFA: nada muda (login segue)', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService(makeStore());

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 1);
  });

  test('store que não reporta `totp`: cai no `enabled` e desafia', async ({ assert }) => {
    // A chave é opcional na MfaCapability. Assumir "sem TOTP" por omissão
    // deixaria de desafiar justamente quem tem o fator.
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1 } });
    const { service, rendered, completeLoginCalls } = buildService(store);

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });
});

test.group('gate do 2º fator — código por e-mail', () => {
  test('conta com TOTP confirmado: DESAFIA em vez de completar o login', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store);

    await new InteractionController().otpVerify(otpCtx(service));

    assert.lengthOf(completeLoginCalls, 0, 'o código do e-mail é 1 fator, não 2');
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });

  test('sem 2º fator: completa o login com amr `email`', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: false } });
    const { service, completeLoginCalls } = buildService(store);

    await new InteractionController().otpVerify(otpCtx(service));

    assert.lengthOf(completeLoginCalls, 1);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email'] });
  });
});

/**
 * Trusted device e step-up eram cobertos só pelo caminho da senha. Como o gate
 * agora é compartilhado, estes testes provam que as duas mecânicas valem também
 * no link e no código — e, no caso do step-up, que a confiança NÃO vence um
 * `acr_values` que exige MFA.
 */
test.group('gate do 2º fator — dispositivo confiável (link e código)', () => {
  test('link mágico: cookie válido pula o desafio e completa com amr `email`', async ({
    assert,
  }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store, {
      enabled: true,
      days: 7,
    });

    await new InteractionController().magicLinkConsume(magicCtx(service, {}, trustedCookie()));

    assert.lengthOf(completeLoginCalls, 1, `renderizou ${rendered[0]?.view} em vez de completar`);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email'] }, 'o fator primário foi o e-mail');
  });

  test('link mágico: cookie de OUTRA conta não pula o desafio', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store, {
      enabled: true,
      days: 7,
    });
    const alheio = { ...trustedCookie(), a: 'outra-conta' };

    await new InteractionController().magicLinkConsume(magicCtx(service, {}, alheio));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });

  test('link mágico: trustedDevices desligado ignora o cookie', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store, {
      enabled: false,
      days: 7,
    });

    await new InteractionController().magicLinkConsume(magicCtx(service, {}, trustedCookie()));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });

  test('código por e-mail: cookie válido pula o desafio', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(store, {
      enabled: true,
      days: 7,
    });

    await new InteractionController().otpVerify(otpCtx(service, trustedCookie()));

    assert.lengthOf(completeLoginCalls, 1, `renderizou ${rendered[0]?.view} em vez de completar`);
  });
});

test.group('gate do 2º fator — step-up via acr_values (link e código)', () => {
  const stepUp = { mfaAcr: 'urn:acme:mfa' };

  test('link mágico: acr exigindo MFA desafia mesmo com dispositivo confiável', async ({
    assert,
  }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(
      store,
      { enabled: true, days: 7 },
      { acrValues: stepUp.mfaAcr, stepUp },
    );

    await new InteractionController().magicLinkConsume(magicCtx(service, {}, trustedCookie()));

    assert.lengthOf(completeLoginCalls, 0, 'step-up não aceita confiança de ontem');
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });

  test('link mágico: acr exigindo MFA numa conta SEM fator bloqueia com a instrução', async ({
    assert,
  }) => {
    const store = makeStore({ mfa: { enabled: false } });
    const { service, rendered, completeLoginCalls } = buildService(
      store,
      { enabled: false, days: 7 },
      { acrValues: stepUp.mfaAcr, stepUp },
    );

    await new InteractionController().magicLinkConsume(magicCtx(service));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
    assert.isTrue(rendered[0]?.props.noEnrollment);
  });

  test('código por e-mail: acr exigindo MFA desafia', async ({ assert }) => {
    const store = makeStore({ mfa: { enabled: true, enabledAt: 1, totp: true } });
    const { service, rendered, completeLoginCalls } = buildService(
      store,
      { enabled: true, days: 7 },
      { acrValues: stepUp.mfaAcr, stepUp },
    );

    await new InteractionController().otpVerify(otpCtx(service, trustedCookie()));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
  });
});
