/**
 * Passo pendente entre o callback social e o 2º fator, compartilhado pelo
 * `AuthSocialController` (grava) e pelo `AuthInteractionController` (consome).
 */

/**
 * Login social que passou pelo provider mas ainda deve o 2º fator da conta.
 * Lido (uma vez) por `AuthInteractionController#socialContinue`.
 */
export const SOCIAL_PENDING_KEY = 'authkit_social_pending';
/** Validade do passo pendente: o desafio do 2º fator vem logo em seguida. */
export const SOCIAL_PENDING_TTL_MS = 5 * 60 * 1000;

export interface SocialPendingLogin {
  accountId: string;
  uid: string;
  required: boolean;
  at: number;
}
