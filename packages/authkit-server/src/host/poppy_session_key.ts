/**
 * Session key que marca a sessão do navegador de um personal agent Poppy (§5):
 * `{ sessionId, clientId, userId }`. Import-free (o barrel a reexporta — ver
 * `account_session_key.ts`).
 *
 * Uma sessão marcada é do AGENTE, não do usuário: o console de conta, o admin e
 * as telas de consentimento a recusam.
 */
export const POPPY_WEB_SESSION_KEY = 'authkit_poppy_session';
