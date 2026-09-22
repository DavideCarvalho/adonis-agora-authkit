/**
 * O `amr` de um login que passou pelo desafio do 2º fator.
 *
 * Antes, `mfaVerify` (e a passkey como 2º fator) só passava acr/amr ao
 * `completeLogin` no STEP-UP. Fora dele o id_token saía sem `amr` nenhum — o RP
 * não tinha como saber que houve MFA — e o fator primário (senha `pwd` ou e-mail
 * `email`) se perdia até no step-up (`['mfa', 'totp']`).
 *
 * Agora o `secondFactorGate` — ponto de entrada comum dos quatro caminhos (senha,
 * link mágico, código por e-mail, troca forçada de senha) — guarda o fator
 * primário na sessão junto do `MFA_PENDING_KEY`, e quem completa o desafio monta
 * `amr: [primário, 'mfa', método]`. O step-up continua carimbando o `acr`.
 *
 * Os testes dirigem o controller real em DUAS requests na mesma sessão (o login
 * primário que desafia e o POST do 2º fator), no padrão fake-ctx de
 * `mfa_gate_passwordless.spec.ts`.
 */

import { test } from '@japa/runner';
import { resolveLockout, resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';

const EMAIL = 'user@example.com';
const PASSWORD = 'correct horse battery staple';
const ACCOUNT_ID = 'acc-1';
const SESSION_KEY = 'authkit_login_email';
const MFA_PENDING_KEY = 'authkit_mfa_pending';
const MFA_PRIMARY_KEY = 'authkit_mfa_primary';
const PASSKEY_AUTH_CHALLENGE_KEY = 'authkit_passkey_auth_challenge';
const STEP_UP = { mfaAcr: 'urn:acme:mfa' };

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

/** Conta com TOTP confirmado + passkey: todo login primário cai no desafio. */
function makeStore() {
  const account = {
    id: ACCOUNT_ID,
    email: EMAIL,
    name: 'Test User',
    avatarUrl: null,
    globalRoles: ['USER'],
  };
  return {
    findById: async (id: string) => (id === account.id ? account : null),
    findByEmail: async (email: string) => (email === account.email ? account : null),
    verifyCredentials: async (email: string, password: string) =>
      email === EMAIL && password === PASSWORD ? account : null,
    create: async () => {
      throw new Error('not used');
    },
    issueMagicLinkToken: async () => null,
    consumeMagicLinkToken: async (token: string) => (token === 'good-token' ? account : null),
    issueMagicLinkWithCode: async () => null,
    verifyLoginCode: async () => ({ status: 'ok' as const, account }),
    listPasskeys: async () => [{ id: 'cred-1' }],
    verifyPasskeyAuthentication: async () => true,
    getMfaState: async () => ({ enabled: true, enabledAt: 1, totp: true }),
    startTotpEnrollment: async () => null,
    confirmTotpEnrollment: async () => false,
    verifyTotp: async (_id: string, code: string) => code === '123456',
    consumeRecoveryCode: async (_id: string, code: string) => code === 'rc-1',
    disableMfa: async () => {},
    // Troca forçada de senha (supportsAccountSecurity).
    changePassword: async () => {},
  } as any;
}

function buildService(opts: { acrValues?: string } = {}) {
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
    accountStore: makeStore(),
    audit: { record: async () => {} },
    notifications: { newLoginEmail: false, newDeviceEmail: false },
    trustedDevices: { enabled: false, days: 30 },
    lockout: resolveLockout(),
    stepUp: STEP_UP,
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

/** Uma request. `inputs` alimenta `input()` e `only()`; `qs` o query string. */
function fakeCtx(
  service: any,
  session: Record<string, unknown>,
  opts: { inputs?: Record<string, unknown>; qs?: Record<string, unknown> } = {},
) {
  const inputs = opts.inputs ?? {};
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
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, inputs[k]])),
      input: (k: string, def?: any) => inputs[k] ?? def,
      qs: () => opts.qs ?? {},
      ip: () => '1.2.3.4',
      header: () => undefined,
      encryptedCookie: () => undefined,
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
    response: {
      redirect: (_url: string) => undefined,
      encryptedCookie: () => undefined,
      cookie: () => undefined,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as any;
}

// ─── Fatores primários: cada um termina no desafio, com o primário na sessão ──

async function passwordLogin(service: any, session: Record<string, unknown>) {
  session[SESSION_KEY] = EMAIL;
  await new InteractionController().login(
    fakeCtx(service, session, { inputs: { password: PASSWORD } }),
  );
}

async function magicLinkLogin(service: any, session: Record<string, unknown>) {
  await new InteractionController().magicLinkConsume(
    fakeCtx(service, session, { qs: { token: 'good-token' } }),
  );
}

async function emailCodeLogin(service: any, session: Record<string, unknown>) {
  session[SESSION_KEY] = EMAIL;
  await new InteractionController().otpVerify(
    fakeCtx(service, session, { inputs: { code: '654321' } }),
  );
}

async function expiredPasswordChange(service: any, session: Record<string, unknown>) {
  session['authkit_password_expired'] = ACCOUNT_ID;
  await new InteractionController().changeExpiredPassword(
    fakeCtx(service, session, { inputs: { newPassword: 'a brand new passphrase' } }),
  );
}

// ─── Segundos fatores ────────────────────────────────────────────────────────

async function totp(service: any, session: Record<string, unknown>) {
  await new InteractionController().mfaVerify(
    fakeCtx(service, session, { inputs: { code: '123456' } }),
  );
}

async function recovery(service: any, session: Record<string, unknown>) {
  await new InteractionController().mfaVerify(
    fakeCtx(service, session, { inputs: { recoveryCode: 'rc-1' } }),
  );
}

async function passkey(service: any, session: Record<string, unknown>) {
  session[PASSKEY_AUTH_CHALLENGE_KEY] = 'chal-1';
  await new InteractionController().passkeyVerify(
    fakeCtx(service, session, { inputs: { response: JSON.stringify({ id: 'cred-1' }) } }),
  );
}

test.group('amr depois do 2º fator — [primário, mfa, método]', () => {
  test('senha + TOTP: amr = [pwd, mfa, totp], sem acr', async ({ assert }) => {
    const { service, rendered, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await passwordLogin(service, session);
    assert.equal(rendered.at(-1)?.view, 'mfa-challenge', 'a senha tem de cair no desafio');
    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(session[MFA_PRIMARY_KEY], 'pwd', 'o gate guarda o fator primário');

    await totp(service, session);
    assert.lengthOf(completeLoginCalls, 1);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['pwd', 'mfa', 'totp'] });
  });

  test('link mágico + recovery code: amr = [email, mfa, recovery]', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await magicLinkLogin(service, session);
    assert.equal(session[MFA_PRIMARY_KEY], 'email');

    await recovery(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email', 'mfa', 'recovery'] });
  });

  test('código por e-mail + passkey como 2º fator: amr = [email, mfa, webauthn]', async ({
    assert,
  }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await emailCodeLogin(service, session);
    assert.equal(session[MFA_PENDING_KEY], ACCOUNT_ID);
    assert.equal(session[MFA_PRIMARY_KEY], 'email');

    await passkey(service, session);
    assert.lengthOf(completeLoginCalls, 1);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email', 'mfa', 'webauthn'] });
  });

  test('troca forçada de senha + TOTP: amr = [pwd, mfa, totp]', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await expiredPasswordChange(service, session);
    assert.lengthOf(completeLoginCalls, 0, 'a senha nova não dispensa o 2º fator');
    assert.equal(session[MFA_PRIMARY_KEY], 'pwd');

    await totp(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['pwd', 'mfa', 'totp'] });
  });

  test('senha + passkey como 2º fator: amr = [pwd, mfa, webauthn]', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await passwordLogin(service, session);
    await passkey(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['pwd', 'mfa', 'webauthn'] });
  });

  test('completar o desafio esquece o pendente E o primário', async ({ assert }) => {
    const { service } = buildService();
    const session: Record<string, unknown> = {};

    await passwordLogin(service, session);
    await totp(service, session);
    assert.notProperty(session, MFA_PENDING_KEY);
    assert.notProperty(session, MFA_PRIMARY_KEY, 'um primário sobrando colaria no próximo login');
  });

  test('código errado NÃO consome o primário (a próxima tentativa ainda o tem)', async ({
    assert,
  }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {};

    await magicLinkLogin(service, session);
    await new InteractionController().mfaVerify(
      fakeCtx(service, session, { inputs: { code: '000000' } }),
    );
    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(session[MFA_PRIMARY_KEY], 'email');

    await totp(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['email', 'mfa', 'totp'] });
  });
});

test.group('amr depois do 2º fator — step-up continua carimbando o acr', () => {
  test('senha + TOTP com acr_values=mfaAcr: acr + amr = [pwd, mfa, totp]', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService({ acrValues: STEP_UP.mfaAcr });
    const session: Record<string, unknown> = {};

    await passwordLogin(service, session);
    await totp(service, session);
    assert.deepEqual(completeLoginCalls[0][2], {
      acr: STEP_UP.mfaAcr,
      amr: ['pwd', 'mfa', 'totp'],
    });
  });

  test('link mágico + passkey com step-up: acr + amr = [email, mfa, webauthn]', async ({
    assert,
  }) => {
    const { service, completeLoginCalls } = buildService({ acrValues: STEP_UP.mfaAcr });
    const session: Record<string, unknown> = {};

    await magicLinkLogin(service, session);
    await passkey(service, session);
    assert.deepEqual(completeLoginCalls[0][2], {
      acr: STEP_UP.mfaAcr,
      amr: ['email', 'mfa', 'webauthn'],
    });
  });
});

test.group('amr depois do 2º fator — bordas', () => {
  test('passkey-first (sem desafio pendente): a passkey É o login, amr = [webauthn]', async ({
    assert,
  }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = { [SESSION_KEY]: EMAIL };

    await passkey(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['webauthn'] });
  });

  test('sessão sem primário (gravada antes desta versão): amr sem o primário, sem inventar', async ({
    assert,
  }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = { [MFA_PENDING_KEY]: ACCOUNT_ID };

    await totp(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['mfa', 'totp'] });
  });

  test('primário adulterado na sessão é ignorado', async ({ assert }) => {
    const { service, completeLoginCalls } = buildService();
    const session: Record<string, unknown> = {
      [MFA_PENDING_KEY]: ACCOUNT_ID,
      [MFA_PRIMARY_KEY]: 'hwk',
    };

    await totp(service, session);
    assert.deepEqual(completeLoginCalls[0][2], { amr: ['mfa', 'totp'] });
  });
});
