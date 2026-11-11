/**
 * Login do console pelo IdP (SSO), o jeito padrão de entrar em `/account/*` e no
 * console admin.
 *
 * O console é tratado como mais um app do IdP, como o Keycloak faz com o
 * `account-console` e o `security-admin-console`: sem sessão, o visitante vai
 * para a tela de login do IdP (a mesma interaction de qualquer client: senha,
 * magic link, OTP, passkey, social), volta, e a ponte de
 * `idp_session_bridge.ts` abre o console para a conta da sessão do IdP.
 *
 * Para isso existe um client interno, `authkit-console`, injetado como client
 * ESTÁTICO do provider (não fica no adapter, então não aparece na lista de
 * clients do console nem pode ser editado):
 *
 *   - `response_types: ['none']`: o authorize não emite code nem token. O client
 *     só usa o IdP para autenticar; o que abre o console é a sessão do IdP que o
 *     login criou, lida pela ponte. Não há segredo, PKCE ou troca de code.
 *   - o consent é concedido automaticamente (é a própria lib).
 *   - a única `redirect_uri` é `/auth/console/callback`, no MESMO host do issuer.
 *
 * Só existe com `accountSession.acceptIdpSession` ligado (o default).
 */
import { randomBytes } from 'node:crypto';

/** `client_id` do client interno do console. Reservado: não pode ser cadastrado. */
export const CONSOLE_SSO_CLIENT_ID = 'authkit-console';

/** Rota que inicia o login do console pelo IdP. */
export const CONSOLE_SSO_START_PATH = '/auth/console/sso';

/** `redirect_uri` do client interno: valida o `state` e abre o console. */
export const CONSOLE_SSO_CALLBACK_PATH = '/auth/console/callback';

/** Chave da sessão Adonis com o `state` e o destino de um login em andamento. */
export const CONSOLE_SSO_STATE_KEY = 'authkit_console_sso';

/** O que fica na sessão entre o início e o callback. */
export interface ConsoleSsoState {
  state: string;
  returnTo: string | null;
}

/** Metadata do client interno para o `clients` estático do oidc-provider. */
export function consoleSsoClientMetadata(issuer: string): Record<string, unknown> {
  const origin = new URL(issuer).origin;
  return {
    client_id: CONSOLE_SSO_CLIENT_ID,
    client_name: 'Account console',
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    response_types: ['none'],
    grant_types: [],
    redirect_uris: [`${origin}${CONSOLE_SSO_CALLBACK_PATH}`],
  };
}

/** Novo `state` opaco para um login do console. */
export function newConsoleSsoState(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Path do authorize do provider. O issuer termina no `mountPath` (garantido por
 * `registerAuthHost`), então o mount é o path do issuer.
 */
export function authorizationPath(issuer: string, provider?: any): string {
  const mount = new URL(issuer).pathname.replace(/\/+$/, '');
  if (provider && typeof provider.pathFor === 'function') {
    try {
      return provider.pathFor('authorization', { mountPath: mount });
    } catch {
      // cai no default do oidc-provider abaixo
    }
  }
  return `${mount}/auth`;
}

/** URL do login do console pelo IdP, preservando o destino como `return_to`. */
export function consoleSsoUrl(returnTo?: string | null): string {
  if (!returnTo) return CONSOLE_SSO_START_PATH;
  return `${CONSOLE_SSO_START_PATH}?return_to=${encodeURIComponent(returnTo)}`;
}
