import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from './middleware/account_auth.js';

/**
 * Ergonômico de SESSÃO de browser no RP para "personificar" (impersonate) um
 * usuário e navegar como ele — roteado pelo token-exchange RFC 8693 que o IdP já
 * expõe (`provider/token_exchange.ts`). Assim a impersonation herda o AUDIT
 * central do IdP + o claim `act` no token, em vez de o app colar isso na mão.
 *
 * INVARIANTE DE SEGURANÇA: este helper é só glue de sessão — a AUTORIZAÇÃO é do
 * IdP. O token-exchange REJEITA um `subject_token` que não seja de um admin, então
 * `startImpersonation` só troca a sessão quando o exchange retorna 2xx. NÃO
 * reimplementamos checagem de role aqui.
 *
 * A troca acontece na MESMA key de sessão que a identidade da conta do console
 * (`account_user_id`, via `ACCOUNT_SESSION_KEY`) — o resto do app (middleware,
 * `getAccountId`) continua funcionando sem saber que há impersonation ativa.
 */

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * Key de sessão que guarda o admin REAL (o impersonator) enquanto há uma
 * impersonation ativa. Interna: NÃO exporte o literal — é contrato de
 * implementação, leia via `impersonationState`.
 */
const IMPERSONATOR_SESSION_KEY = 'impersonator_user_id';

/**
 * Key de sessão que guarda o access token do admin, necessário como
 * `subject_token` do token-exchange. Interna: NÃO exporte o literal.
 */
const ADMIN_ACCESS_TOKEN_SESSION_KEY = 'admin_access_token';

/**
 * Guarda o access token do admin na sessão (chame no callback OIDC do RP, logo
 * após o login). Necessário porque o token-exchange exige o access token do admin
 * como `subject_token`, e o RP normalmente descarta os tokens após o login.
 *
 * Access tokens são curtos: se expirar, `startImpersonation` falha e o admin
 * re-loga (aceitável; refresh fica pra depois — YAGNI).
 */
export function rememberAccessToken(ctx: HttpContext, accessToken: string): void {
  ctx.session.put(ADMIN_ACCESS_TOKEN_SESSION_KEY, accessToken);
}

export interface StartImpersonationParams {
  /** Id do usuário-alvo a personificar. */
  targetId: string;
  /** Issuer do IdP (ex.: http://localhost:3333/oidc). */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Token endpoint do IdP (via `discoverEndpoints`). Default: `${issuer}/token`. */
  tokenEndpoint?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}

export interface ImpersonationState {
  active: boolean;
  /** = `account_user_id` atual, quando `active`. */
  targetId?: string;
  /** O admin real (impersonator), quando `active`. */
  impersonatorId?: string;
}

/**
 * POST inline do RFC 8693 token-exchange. Inline (em vez de depender de
 * `@adonis-agora/authkit-client`) porque o client NÃO é dependência do server e
 * adicioná-la inverteria a direção do grafo de pacotes (server = IdP toolkit). São
 * ~12 linhas; testável via `fetchImpl`. Lança se o IdP não responder 2xx (é o
 * gatekeeper: não-admin / token expirado ⇒ erro ⇒ a sessão não é tocada).
 */
async function requestTokenExchange(
  params: StartImpersonationParams,
  subjectToken: string,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subjectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_subject: params.targetId,
    client_id: params.clientId,
  });
  if (params.scope) body.set('scope', params.scope);
  if (params.clientSecret) body.set('client_secret', params.clientSecret);

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(params.tokenEndpoint ?? `${params.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    // NUNCA logamos tokens nem o corpo (pode ecoar segredos). Só o status.
    throw new Error(`Token exchange failed: ${res.status}`);
  }
}

/**
 * Inicia a impersonation: lê o access token do admin da sessão, chama o
 * token-exchange (o IdP valida a role admin e audita) e SÓ em sucesso guarda o
 * impersonator (= `account_user_id` atual), regenera a sessão (anti-fixation) e
 * seta `account_user_id = targetId`.
 *
 * - Se o exchange falhar, LANÇA e NÃO troca NADA na sessão.
 * - Recusa (lança) se já houver impersonation ativa (pare a atual antes).
 * - Recusa (lança) se não houver access token do admin na sessão.
 */
export async function startImpersonation(
  ctx: HttpContext,
  params: StartImpersonationParams,
): Promise<void> {
  if (ctx.session.get(IMPERSONATOR_SESSION_KEY)) {
    throw new Error('Impersonation already active; stop the current one before starting another');
  }

  const adminAccessToken = ctx.session.get(ADMIN_ACCESS_TOKEN_SESSION_KEY) as string | undefined;
  if (!adminAccessToken) {
    throw new Error('No admin access token in session; call rememberAccessToken after login');
  }

  const impersonatorId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
  if (!impersonatorId) {
    // Não há admin logado para impersonar como — sem identidade para restaurar
    // depois. Recusa antes de qualquer chamada/mutação.
    throw new Error('No account session; log in as the admin before impersonating');
  }

  // O IdP é o gatekeeper: lança se o admin não puder personificar. Chamado ANTES
  // de qualquer mutação de sessão — em caso de erro nada é trocado.
  await requestTokenExchange(params, adminAccessToken);

  // Anti-fixation: rotaciona o id da sessão (mantém os dados) antes de gravar a
  // nova identidade. Mesmo padrão do consumidor real no RP.
  await ctx.session.regenerate();

  // ESCALAÇÃO DE PRIVILÉGIO (fechada por vinculação): trocar a conta aqui NÃO
  // pode carregar junto o sudo que o admin confirmou sobre a PRÓPRIA conta —
  // senão ele entraria personificando já com a graça aberta sobre a conta
  // alheia (exportar/excluir dados, MFA, PATs). Não limpamos a marca aqui: ela
  // é vinculada à conta que a confirmou (`SUDO_ACCOUNT_SESSION_KEY`), então
  // `isSudoActive` a recusa sozinho assim que `ACCOUNT_SESSION_KEY` muda. A
  // garantia é estrutural — vale para qualquer troca de conta futura, sem
  // depender de um `forget` lembrado em cada nova transição.
  ctx.session.put(IMPERSONATOR_SESSION_KEY, impersonatorId);
  ctx.session.put(ACCOUNT_SESSION_KEY, params.targetId);
}

/**
 * Estado da impersonation pra UI (ex.: banner). `active` quando há um impersonator
 * guardado na sessão.
 */
export function impersonationState(ctx: HttpContext): ImpersonationState {
  const impersonatorId = ctx.session.get(IMPERSONATOR_SESSION_KEY) as string | undefined;
  if (!impersonatorId) return { active: false };
  const targetId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
  return { active: true, targetId, impersonatorId };
}

/**
 * Encerra a impersonation: restaura `account_user_id = impersonator`, remove a
 * key de impersonation e regenera a sessão (anti-fixation). No-op quando não há
 * impersonation ativa.
 *
 * O `admin_access_token` (a credencial do ADMIN usada como `subject_token` do
 * token-exchange) é PRESERVADO: ele é do admin — não do alvo — e o admin segue
 * logado após o stop. Removê-lo forçava um relogin a cada vez que o admin
 * personificava, saía e tentava personificar de novo (No admin access token in
 * session). O token segue curto (TTL do access token do RP) e o logout do app
 * (`ctx.session.clear()` em `AuthRpController.logout`) continua limpando tudo.
 */
export async function stopImpersonation(ctx: HttpContext): Promise<void> {
  const impersonatorId = ctx.session.get(IMPERSONATOR_SESSION_KEY) as string | undefined;
  if (!impersonatorId) return;

  await ctx.session.regenerate();

  // Simétrico ao `startImpersonation`: o sudo obtido ENQUANTO personificava
  // ficaria valendo sobre a conta do admin ao voltar. A vinculação corta isso —
  // aquela marca aponta para a conta personificada e morre com a volta.
  //
  // Nota: se o admin tinha sudo sobre a própria conta ANTES de personificar e a
  // graça ainda não venceu, ele volta valendo. Correto e intencional: é a
  // confirmação dele, sobre a conta dele, dentro da janela dele.
  ctx.session.put(ACCOUNT_SESSION_KEY, impersonatorId);
  ctx.session.forget(IMPERSONATOR_SESSION_KEY);
}
