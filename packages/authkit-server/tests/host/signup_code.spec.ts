import { test } from '@japa/runner';
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
