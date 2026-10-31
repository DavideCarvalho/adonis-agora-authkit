import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import {
  LOGIN_EMAIL_SESSION_KEY,
  pendingSignupCode,
  SIGNUP_CODE_SESSION_KEY,
  startSignupCode,
  verifySignupCode,
} from '../../src/host/signup_code.js';

function ctxWithSession(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    ctx: {
      session: {
        get: (k: string) => data.get(k),
        put: (k: string, v: unknown) => data.set(k, v),
        forget: (k: string) => data.delete(k),
      },
    } as any,
  };
}

const INPUT = { uid: 'u1', email: 'a@b.c', token: 't', digits: 6, ttlMinutes: 10 };
const pending = (ctx: any) => pendingSignupCode(ctx, 'u1', 'a@b.c')!;

test.group('código do cadastro passwordless', () => {
  test('o código certo vale uma vez; não fica em claro na sessão', ({ assert }) => {
    const { ctx, data } = ctxWithSession();
    const code = startSignupCode(ctx, INPUT);
    assert.match(code, /^\d{6}$/);
    assert.notInclude(JSON.stringify(data.get(SIGNUP_CODE_SESSION_KEY)), code);
    assert.equal(verifySignupCode(ctx, pending(ctx), code, 5), 'ok');
    assert.isNull(pendingSignupCode(ctx, 'u1', 'a@b.c'));
  });

  test('só vale nesta interaction e para o e-mail da sessão', ({ assert }) => {
    const { ctx } = ctxWithSession({ [LOGIN_EMAIL_SESSION_KEY]: 'a@b.c' });
    startSignupCode(ctx, INPUT);
    assert.isNull(pendingSignupCode(ctx, 'outra', 'a@b.c'));
    assert.isNull(pendingSignupCode(ctx, 'u1', 'outro@b.c'));
    assert.isNull(pendingSignupCode(ctx, 'u1', undefined));
  });

  test('errar até o limite trava, e nem o código certo entra', ({ assert }) => {
    const { ctx } = ctxWithSession();
    const code = startSignupCode(ctx, INPUT);
    const wrong = code === '000000' ? '000001' : '000000';
    assert.equal(verifySignupCode(ctx, pending(ctx), wrong, 2), 'invalid');
    assert.equal(verifySignupCode(ctx, pending(ctx), wrong, 2), 'locked');
    assert.equal(verifySignupCode(ctx, pending(ctx), code, 2), 'locked');
  });

  test('código vencido', ({ assert }) => {
    const { ctx } = ctxWithSession();
    const code = startSignupCode(ctx, { ...INPUT, ttlMinutes: -1 });
    assert.equal(verifySignupCode(ctx, pending(ctx), code, 5), 'expired');
  });
});

test.group('código do cadastro passwordless — otp-verify', () => {
  function verify(session: Map<string, unknown>, code: string) {
    const rendered: any[] = [];
    const audit: any[] = [];
    const redirect: any = {
      target: null,
      status: () => redirect,
      toPath: (path: string) => {
        redirect.target = path;
      },
    };
    const store = {
      findByEmail: async () => null,
      issueMagicLinkWithCode: async () => null,
      issueMagicLinkToken: async () => null,
      consumeMagicLinkToken: async () => null,
      verifyLoginCode: async () => {
        throw new Error('o cadastro pendente não passa pelo store');
      },
    };
    const service = {
      config: {
        accountStore: store,
        login: resolveLogin({ otp: { enabled: true } }),
        passwordless: resolvePasswordless({ magicLink: true, signup: true }),
        branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
        messages: {},
        audit: { record: async (event: any) => audit.push(event) },
        render: async (_ctx: any, view: string, props: any) => rendered.push({ view, props }),
      },
      interactions: { details: async () => ({ params: { client_id: 'web' } }) },
    };
    const ctx: any = {
      containerResolver: {
        make: async (key: string) => {
          if (key === 'authkit.server') return service;
          throw new Error('no db');
        },
      },
      request: {
        csrfToken: 'csrf',
        param: () => 'u1',
        ip: () => '1.2.3.4',
        input: (key: string) => (key === 'code' ? code : undefined),
      },
      response: { redirect: () => redirect },
      session: {
        get: (k: string) => session.get(k),
        put: (k: string, v: unknown) => session.set(k, v),
        forget: (k: string) => session.delete(k),
      },
      logger: { error: () => {}, info: () => {}, warn: () => {} },
    };
    return new InteractionController().otpVerify(ctx).then(() => ({ redirect, rendered, audit }));
  }

  function start(maxAttemptsLeft = false) {
    const { ctx, data } = ctxWithSession({ [LOGIN_EMAIL_SESSION_KEY]: 'a@b.c' });
    const code = startSignupCode(ctx, { ...INPUT, token: 'tok/en' });
    if (maxAttemptsLeft) {
      const pendingRow = data.get(SIGNUP_CODE_SESSION_KEY) as any;
      data.set(SIGNUP_CODE_SESSION_KEY, { ...pendingRow, attempts: 99 });
    }
    return { data, code, wrong: code === '000000' ? '000001' : '000000' };
  }

  test('código certo: 303 para o link de confirmação, sem pendente na sessão', async ({
    assert,
  }) => {
    const { data, code } = start();
    const { redirect, rendered } = await verify(data, code);
    assert.equal(redirect.target, '/auth/interaction/u1/signup/confirm?token=tok%2Fen');
    assert.lengthOf(rendered, 0);
    assert.isFalse(data.has(SIGNUP_CODE_SESSION_KEY));
    assert.isFalse(data.has(LOGIN_EMAIL_SESSION_KEY));
  });

  test('código errado e travado: tela com erro, sem redirect', async ({ assert }) => {
    const wrong = start();
    const a = await verify(wrong.data, wrong.wrong);
    assert.isNull(a.redirect.target);
    assert.equal(a.rendered[0].view, 'login');
    assert.equal(a.rendered[0].props.otpError, 'login.otp_invalid');
    assert.equal(a.audit[0].type, 'login.otp_failed');

    const locked = start(true);
    const b = await verify(locked.data, locked.code);
    assert.isNull(b.redirect.target);
    assert.equal(b.rendered[0].props.otpError, 'login.otp_locked');
    assert.equal(b.audit[0].type, 'login.otp_invalidated');
  });
});
