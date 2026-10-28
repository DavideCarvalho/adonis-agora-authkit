import { loadEncryptionService } from '../keys/keystore_crypto.js';

/**
 * Token do link de confirmação do cadastro passwordless.
 *
 * O cadastro não cria a conta no POST: guarda e-mail + nome num token cifrado
 * (APP_KEY), com prazo e propósito próprios, e a conta só nasce quando o dono do
 * e-mail abre o link. Assim um envio que falha, ou um e-mail digitado por quem
 * não é o dono, não deixa conta para trás nem dispara `account.created`.
 *
 * Sem estado no banco: a unicidade vem da própria conta — se ela já existe
 * quando o link é aberto, o link é recusado.
 */

const PURPOSE = 'authkit_passwordless_signup';
/** Mesma janela do magic link de login. */
export const SIGNUP_TOKEN_TTL = '15 minutes';

export interface SignupClaim {
  email: string;
  fullName: string | null;
}

/** O serviço de encryption do AdonisJS, com prazo e propósito. */
interface PurposeEncryption {
  encrypt(payload: unknown, expiresIn?: string | number, purpose?: string): string;
  decrypt<T>(value: string, purpose?: string): T | null;
}

async function encryption(): Promise<PurposeEncryption> {
  return (await loadEncryptionService()) as unknown as PurposeEncryption;
}

export async function issueSignupToken(claim: SignupClaim): Promise<string> {
  return (await encryption()).encrypt(claim, SIGNUP_TOKEN_TTL, PURPOSE);
}

/** Claim do token, ou `null` se adulterado, de outro propósito ou vencido. */
export async function readSignupToken(token: string): Promise<SignupClaim | null> {
  const claim = (await encryption()).decrypt<SignupClaim>(token, PURPOSE);
  if (!claim || typeof claim.email !== 'string' || claim.email === '') return null;
  return {
    email: claim.email,
    fullName: typeof claim.fullName === 'string' ? claim.fullName : null,
  };
}
