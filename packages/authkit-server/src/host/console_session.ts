import type { HttpContext } from '@adonisjs/core/http';
import { getAccountLoginUrl } from './account_login_url.js';
import { ACCOUNT_SESSION_KEY } from './account_session_key.js';
import { bearerAccountId } from './bearer_account.js';
import { impersonationState } from './impersonation_session.js';

/**
 * Helpers públicos para integrar a sessão do console do AuthKit com
 * qualquer coisa fora do pacote (ex.: proteger o dashboard do
 * adonis-telescope, rotas administrativas próprias, etc).
 *
 * Use estes helpers em vez de ler `ctx.session` com a key interna —
 * eles são contrato público e continuam funcionando se o mecanismo de
 * sessão mudar.
 */

/**
 * Retorna o id da conta que o request está representando (ou `null` quando não
 * há identidade).
 *
 * Fonte, nesta ordem:
 *   1. a sessão do console (`ACCOUNT_SESSION_KEY`) — o comportamento de sempre;
 *   2. SEM sessão logada: a conta que um `oidcBearerGuard` autenticou NESTA
 *      request via `Authorization: Bearer` (app nativo, SPA, serviço).
 *
 * O fallback (2) só existe depois que o guard bearer RODOU na request (ex.:
 * `middleware.auth({ guards: ['web', 'api'] })` ou `auth.authenticateUsing`);
 * um app que não usa o guard bearer continua exatamente como antes. A sessão
 * sempre ganha: request com cookie de sessão E bearer responde pela sessão.
 *
 * ATENÇÃO: com impersonation ativa isto é a conta PERSONIFICADA, não o admin
 * que a personificou. É o comportamento certo para "como qual conta este
 * request está agindo?" e é a entrada ERRADA para uma checagem de
 * permissão/role — para isso use `realAccountId`.
 */
export function getAccountId(ctx: HttpContext): string | null {
  const accountId = ctx.session?.get(ACCOUNT_SESSION_KEY) as string | undefined;
  return accountId ?? bearerAccountId(ctx);
}

/**
 * Retorna o id do HUMANO real por trás do request — o id que uma decisão de
 * autorização deve usar.
 *
 * ```
 * impersonation ativa  → o id do impersonator (o admin real)
 * sem impersonation    → o id da conta logada
 * sem sessão           → null
 * ```
 *
 * USE ESTE em qualquer checagem de permissão/role ("esta pessoa é admin?",
 * "esta pessoa pode aprovar isto?"). Use `getAccountId` só para responder
 * "como qual conta este request está agindo?" (queries com escopo no alvo,
 * UI, banner de impersonation).
 *
 * POR QUE ISSO EXISTE. Durante uma impersonation, `getAccountId` devolve a
 * conta PERSONIFICADA — é o comportamento correto dele e o resto do app
 * depende disso. Mas ele é, por isso mesmo, a entrada ERRADA para um role
 * check: perguntar "o `getAccountId` é admin?" com impersonation ativa
 * pergunta sobre o usuário personificado e, quando ele por acaso for admin,
 * entrega os privilégios do admin a quem está sendo personificado — e, no
 * sentido inverso, faz o admin real perder o próprio acesso. `realAccountId`
 * ignora a troca de conta e responde sempre sobre quem está de fato dirigindo
 * a sessão.
 *
 * @example
 * // gate de /admin: a pessoa por trás do request é admin?
 * const id = realAccountId(ctx)
 * if (!id || !(await authz.hasRole(id, 'admin'))) throw new Error('forbidden')
 */
export function realAccountId(ctx: HttpContext): string | null {
  // `impersonationState` cobre as duas fontes: a sessão do console e o access
  // token bearer trocado (`act`, ex.: app nativo) — nos dois, o humano real é o
  // impersonator. Sem impersonation, a conta da sessão ou do bearer.
  return impersonationState(ctx).impersonatorId ?? getAccountId(ctx);
}

/**
 * `true` quando o request carrega uma sessão de conta do console. Só a SESSÃO:
 * uma identidade bearer (`oidcBearerGuard`) não conta — use `getAccountId`.
 */
export function hasAccountSession(ctx: HttpContext): boolean {
  return ctx.session?.get(ACCOUNT_SESSION_KEY) != null;
}

/**
 * URL do login do console, com `return_to` opcional de volta ao destino
 * original após autenticar.
 *
 * Respeita a opção `accountLoginUrl` de `registerAuthHost`: quando o host
 * desmontou a tela `account/login` e apontou para a própria rota de login
 * (ex.: `/login`), este helper usa esse destino. Default `/account/login`.
 *
 * @example
 * consoleLoginUrl('/telescope') // => '/account/login?return_to=%2Ftelescope'
 */
export function consoleLoginUrl(returnTo?: string): string {
  const loginUrl = getAccountLoginUrl();
  if (!returnTo) return loginUrl;
  const sep = loginUrl.includes('?') ? '&' : '?';
  return `${loginUrl}${sep}return_to=${encodeURIComponent(returnTo)}`;
}
