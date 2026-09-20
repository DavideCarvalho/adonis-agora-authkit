import vine from '@vinejs/vine';
import { normalizeEmailIdentifier } from './email_identifier.js';

/**
 * E-mail usado como IDENTIDADE da conta. Normalização ÚNICA e conservadora
 * ({@link normalizeEmailIdentifier}: `trim` + `toLowerCase`) — a MESMA aplicada
 * no passo de identificador do login, para que os dois lados concordem.
 *
 * NÃO use `.normalizeEmail()` do VineJS aqui: ele aplica os defaults do
 * validator.js, que no gmail REMOVEM os pontos e o sub-endereço `+tag` — a
 * conta nascia com um endereço diferente do digitado e a pessoa ficava trancada
 * do lado de fora (ver `host/email_identifier.ts`).
 */
const emailIdentifier = () => vine.string().trim().email().transform(normalizeEmailIdentifier);

/** Cadastro passwordless: só e-mail + nome (sem senha). O login vem por magic link. */
export const passwordlessSignupValidator = vine.compile(
  vine.object({
    email: emailIdentifier(),
    fullName: vine.string().trim().minLength(2).maxLength(255),
  }),
);

export const signupValidator = vine.compile(
  vine.object({
    email: emailIdentifier(),
    fullName: vine.string().trim().minLength(2).maxLength(255),
    password: vine.string().minLength(8).maxLength(255),
  }),
);

export const forgotPasswordValidator = vine.compile(
  vine.object({
    email: emailIdentifier(),
  }),
);

export const resetPasswordValidator = vine.compile(
  vine.object({
    token: vine.string().trim().minLength(1),
    password: vine.string().minLength(8).maxLength(255),
  }),
);

/**
 * Troca de senha no console de conta. A regra da nova senha espelha o
 * signupValidator (min 8, max 255); a senha atual é confirmada à parte via
 * verifyCredentials.
 */
export const changePasswordValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1),
    newPassword: vine.string().minLength(8).maxLength(255),
  }),
);

/**
 * Troca de e-mail no console de conta: senha atual (opcional — pode ser
 * dispensada pela setting `email_change.requirePassword: false`) + o novo e-mail.
 */
export const changeEmailValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1).optional(),
    newEmail: emailIdentifier(),
  }),
);

/**
 * Edição de perfil no console de conta: nome e avatarUrl, ambos opcionais.
 * Campos vazios são normalizados para string vazia (limpa o valor).
 */
export const updateProfileValidator = vine.compile(
  vine.object({
    name: vine.string().trim().maxLength(255).optional(),
    avatarUrl: vine.string().trim().url().maxLength(2048).optional(),
  }),
);

/**
 * Deleção self-service de conta (LGPD). Aceita confirmação por senha atual
 * (`currentPassword`) OU pelo e-mail digitado (`confirmEmail`, p/ contas
 * passwordless). Ambos opcionais aqui; o controller exige que UM deles confirme.
 */
export const deleteAccountValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().optional(),
    confirmEmail: vine.string().trim().optional(),
  }),
);

/** Criação de usuário no console admin (email obrigatório; nome/senha opcionais). */
export const adminCreateUserValidator = vine.compile(
  vine.object({
    email: emailIdentifier(),
    name: vine.string().trim().maxLength(255).optional(),
    password: vine.string().minLength(8).maxLength(255).optional(),
  }),
);
