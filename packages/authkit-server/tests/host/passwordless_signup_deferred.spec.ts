/**
 * O cadastro passwordless criava a conta ANTES de enviar o link. Se o envio
 * falhava, a conta ficava para trás; e qualquer um criava conta (e disparava
 * `account.created`) para o e-mail de outra pessoa.
 *
 * Agora o POST só envia um link com e-mail + nome num token cifrado (APP_KEY,
 * prazo e propósito próprios). A conta nasce em `signupConfirm`, quando o dono do
 * e-mail abre o link, e o login segue pelo magic link de sempre.
 *
 * No cadastro com senha, uma conta recém-criada cujo login falha é desfeita.
 */

import { drivers, Encryption } from '@adonisjs/core/encryption';
import { test } from '@japa/runner';
import { resolvePasswordless } from '../../src/define_config.js';
import AuthRegistrationController from '../../src/host/controllers/registration_controller.js';
import { issueSignupToken } from '../../src/host/signup_token.js';
import { __setEncryptionServiceForTests } from '../../src/keys/keystore_crypto.js';

const UID = 'test-uid';
const EMAIL = 'nova@example.com';

async function realEncryption() {
  const driver = await drivers
    .aes256gcm({ id: 'test', keys: ['k'.repeat(32)] })
    .resolver(undefined as never);
  return new Encryption(driver);
}

function makeStore(opts: { existing?: boolean } = {}) {
  const accounts = new Map<string, any>();
  if (opts.existing) accounts.set(EMAIL, { id: 'acc-old', email: EMAIL });
  const calls = { created: [] as any[], deleted: [] as string[], magicIssued: [] as string[] };
  const store: any = {
    findByEmail: async (email: string) => accounts.get(email) ?? null,
    create: async (input: any) => {
      if (accounts.has(input.email)) throw new Error('unique violation');
      const acc = { id: `acc-${calls.created.length + 1}`, email: input.email };
      accounts.set(input.email, acc);
      calls.created.push(input);
      return acc;
    },
    deleteAccount: async (id: string) => {
      calls.deleted.push(id);
      return true;
    },
    issueMagicLinkToken: async (email: string) => {
      calls.magicIssued.push(email);
      const account = accounts.get(email);
      return account ? { token: `magic-${email}`, account } : null;
    },
    consumeMagicLinkToken: async () => null,
  };
  return { store, calls };
}

function buildService(store: any, extra: Record<string, unknown> = {}) {
  const mails: any[] = [];
  const config: any = {
    render: async (_ctx: any, view: string, data: any) => ({ view, data }),
    messages: {},
    branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
    botProtection: undefined,
    registration: { enabled: true },
    passwordless: resolvePasswordless({ magicLink: true, signup: true }),
    accountStore: store,
    audit: { record: async () => {} },
    issuer: 'https://auth.example.com/oidc',
    mail: {
      onMagicLink: async (data: any) => {
        mails.push(data);
      },
    },
    ...extra,
  };
  const interactions = {
    details: async () => ({ uid: UID, params: { client_id: 'web' }, prompt: { name: 'signup' } }),
    login: async () => ({ ok: true }),
  };
  return { service: { config, interactions }, mails };
}

function fakeCtx(
  service: any,
  opts: { body?: Record<string, string>; qs?: Record<string, string> } = {},
) {
  const redirects: string[] = [];
  const errors: unknown[] = [];
  const ctx = {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        // Sem tabela de settings: os toggles caem no config.
        if (key === 'lucid.db') throw new Error('no db');
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: () => UID,
      qs: () => opts.qs ?? {},
      input: (k: string) => opts.body?.[k] ?? '',
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, opts.body?.[k] ?? ''])),
      validateUsing: async () => opts.body ?? {},
      ip: () => '1.2.3.4',
    },
    session: { get: () => undefined, put: () => {}, forget: () => {} },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
      },
    },
    logger: { error: (e: unknown) => errors.push(e), info: () => {}, warn: () => {} },
  } as any;
  return { ctx, redirects, errors };
}

const signup = (service: any, body = { email: EMAIL, fullName: 'Nova Pessoa' }) => {
  const { ctx } = fakeCtx(service, { body });
  return new AuthRegistrationController().signup(ctx);
};

test.group('cadastro passwordless — a conta só nasce ao abrir o link', (group) => {
  group.each.setup(async () => {
    __setEncryptionServiceForTests((await realEncryption()) as any);
    return () => __setEncryptionServiceForTests(undefined);
  });

  test('POST com e-mail novo: envia o link de confirmação e NÃO cria conta', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service, mails } = buildService(store);

    const result: any = await signup(service);

    assert.lengthOf(calls.created, 0);
    assert.isTrue(result.data.magicLinkSent);
    assert.lengthOf(mails, 1);
    assert.equal(mails[0].kind, 'signup');
    assert.include(mails[0].magicUrl, `/auth/interaction/${UID}/signup/confirm?token=`);
  });

  test('com OTP ligado: conta nova e conta existente recebem código, na mesma resposta', async ({
    assert,
  }) => {
    const otp = { login: { otp: { enabled: true, digits: 6, ttlMinutes: 10, maxAttempts: 5 } } };
    const otpMethods = {
      issueMagicLinkWithCode: async (email: string) => ({
        token: `magic-${email}`,
        code: '123456',
        account: { id: 'acc-old', email },
      }),
      verifyLoginCode: async () => ({ status: 'invalid' }),
    };

    const fresh = makeStore();
    const novo = buildService({ ...fresh.store, ...otpMethods }, otp);
    const a: any = await signup(novo.service);
    assert.lengthOf(fresh.calls.created, 0);
    assert.match(novo.mails[0].code, /^\d{6}$/);
    assert.equal(novo.mails[0].kind, 'signup');

    const old = makeStore({ existing: true });
    const velho = buildService({ ...old.store, ...otpMethods }, otp);
    const b: any = await signup(velho.service);
    assert.equal(velho.mails[0].code, '123456');
    assert.deepEqual(a.data, b.data, 'resposta igual: não revela se a conta existe');
    assert.isTrue(a.data.otpEnabled);
  });

  test('envio que falha não deixa conta para trás', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store, {
      mail: {
        onMagicLink: async () => {
          throw new Error('smtp down');
        },
      },
    });

    await assert.rejects(() => signup(service), /smtp down/);
    assert.lengthOf(calls.created, 0);
  });

  test('POST com e-mail que já tem conta: manda magic link de login, sem criar', async ({
    assert,
  }) => {
    const { store, calls } = makeStore({ existing: true });
    const { service, mails } = buildService(store);

    const result: any = await signup(service);

    assert.isTrue(result.data.magicLinkSent, 'resposta igual: não revela se a conta existe');
    assert.lengthOf(calls.created, 0);
    assert.isUndefined(mails[0].kind);
    assert.include(mails[0].magicUrl, `/auth/interaction/${UID}/magic?token=`);
  });

  test('abrir o link cria a conta verificada e segue pelo magic link', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store);
    const token = await issueSignupToken({ email: EMAIL, fullName: 'Nova Pessoa' });
    const { ctx, redirects } = fakeCtx(service, { qs: { token } });

    await new AuthRegistrationController().signupConfirm(ctx);

    assert.lengthOf(calls.created, 1);
    assert.include(calls.created[0], {
      email: EMAIL,
      fullName: 'Nova Pessoa',
      emailVerified: true,
    });
    assert.deepEqual(redirects, [
      `/auth/interaction/${UID}/magic?token=${encodeURIComponent(`magic-${EMAIL}`)}`,
    ]);
  });

  test('o link vale uma vez: com a conta já criada, volta ao login', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store);
    const token = await issueSignupToken({ email: EMAIL, fullName: 'Nova Pessoa' });

    await new AuthRegistrationController().signupConfirm(fakeCtx(service, { qs: { token } }).ctx);
    const second = fakeCtx(service, { qs: { token } });
    await new AuthRegistrationController().signupConfirm(second.ctx);

    assert.lengthOf(calls.created, 1);
    assert.deepEqual(second.redirects, [`/auth/interaction/${UID}`]);
  });

  test('token adulterado ou de outro propósito: não cria nada', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store);
    const enc = await realEncryption();
    const otherPurpose = enc.encrypt({ email: EMAIL, fullName: 'x' }, '15 minutes', 'outro');
    const valid = await issueSignupToken({ email: EMAIL, fullName: 'x' });

    for (const token of [otherPurpose, `${valid}x`, 'lixo']) {
      const { ctx, redirects } = fakeCtx(service, { qs: { token } });
      await new AuthRegistrationController().signupConfirm(ctx);
      assert.deepEqual(redirects, [`/auth/interaction/${UID}`]);
    }
    assert.lengthOf(calls.created, 0);
  });

  test('cadastro desligado depois do envio: o link não cria a conta', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store, { registration: { enabled: false } });
    const token = await issueSignupToken({ email: EMAIL, fullName: 'x' });

    await new AuthRegistrationController().signupConfirm(fakeCtx(service, { qs: { token } }).ctx);

    assert.lengthOf(calls.created, 0);
  });
});

test.group('cadastro com senha — login que falha desfaz a conta', () => {
  test('login falhou logo após criar: a conta é apagada', async ({ assert }) => {
    const { store, calls } = makeStore();
    const { service } = buildService(store, { passwordless: resolvePasswordless({}) });
    service.interactions.login = async () => ({ ok: false });

    const result: any = await signup(service, {
      email: EMAIL,
      fullName: 'Nova Pessoa',
      password: 'uma senha longa',
    } as any);

    assert.equal(result.view, 'signup');
    assert.lengthOf(calls.created, 1);
    assert.deepEqual(calls.deleted, ['acc-1']);
  });
});
