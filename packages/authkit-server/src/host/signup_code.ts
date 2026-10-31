import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * Código digitado do cadastro passwordless.
 *
 * Quem abre o link do e-mail noutro navegador termina logado longe de onde começou (um convite
 * aberto dentro do WhatsApp, por exemplo). Com o código, a pessoa conclui no mesmo navegador e na
 * mesma interaction. A conta ainda não existe, então não há slot no store: o pendente fica na sessão
 * deste navegador, e o código correto só libera o mesmo link de confirmação que foi por e-mail.
 *
 * As tentativas ficam na sessão. Num driver de cookie dá para repetir um cookie antigo e zerá-las,
 * e o limite que sobra é o throttle da rota `otp-verify`.
 */
export const SIGNUP_CODE_SESSION_KEY = 'authkit_signup_code';
/** Onde o login guarda o e-mail da interaction: é o que o `otp-verify` lê. */
export const LOGIN_EMAIL_SESSION_KEY = 'authkit_login_email';

export interface PendingSignupCode {
  uid: string;
  email: string;
  /** O token do link de confirmação (já cifrado). */
  token: string;
  codeHash: string;
  /** Epoch em ms. */
  expiresAt: number;
  attempts: number;
}

export type SignupCodeResult = 'ok' | 'invalid' | 'expired' | 'locked';

function hashCode(uid: string, token: string, code: string): string {
  return createHash('sha256').update(`${uid}\u0000${token}\u0000${code}`).digest('hex');
}

/** Gera o código e o guarda na sessão, presos à interaction e ao token. Devolve o código. */
export function startSignupCode(
  ctx: HttpContext,
  input: { uid: string; email: string; token: string; digits: number; ttlMinutes: number },
): string {
  const code = String(randomInt(0, 10 ** input.digits)).padStart(input.digits, '0');
  const pending: PendingSignupCode = {
    uid: input.uid,
    email: input.email,
    token: input.token,
    codeHash: hashCode(input.uid, input.token, code),
    expiresAt: Date.now() + input.ttlMinutes * 60_000,
    attempts: 0,
  };
  ctx.session.put(SIGNUP_CODE_SESSION_KEY, pending);
  return code;
}

/**
 * O cadastro pendente desta interaction. Se a pessoa voltou e digitou outro e-mail no login, o
 * e-mail da sessão muda e o código que vale é o do login.
 */
export function pendingSignupCode(
  ctx: HttpContext,
  uid: string,
  sessionEmail: string | undefined,
): PendingSignupCode | null {
  const pending = ctx.session.get(SIGNUP_CODE_SESSION_KEY) as PendingSignupCode | undefined;
  return pending?.uid === uid && pending.email === sessionEmail ? pending : null;
}

/** Confere o código e conta a tentativa. Ao travar, nem o código certo entra; o link continua. */
export function verifySignupCode(
  ctx: HttpContext,
  pending: PendingSignupCode,
  code: string,
  maxAttempts: number,
): SignupCodeResult {
  if (pending.attempts >= maxAttempts) return 'locked';
  if (Date.now() >= pending.expiresAt) return 'expired';
  const expected = Buffer.from(pending.codeHash);
  const given = Buffer.from(hashCode(pending.uid, pending.token, code));
  if (expected.length === given.length && timingSafeEqual(expected, given)) {
    ctx.session.forget(SIGNUP_CODE_SESSION_KEY);
    return 'ok';
  }
  const attempts = pending.attempts + 1;
  ctx.session.put(SIGNUP_CODE_SESSION_KEY, { ...pending, attempts });
  return attempts >= maxAttempts ? 'locked' : 'invalid';
}
