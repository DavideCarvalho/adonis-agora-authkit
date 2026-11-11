import { Exception } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import { getAccountLoginUrl } from './account_login_url.js';
import { brandFor } from './branding.js';
import type { ScreenRenderProps } from './screen_props.js';

/**
 * Recuperação graciosa da sessão de interaction OIDC perdida.
 *
 * Quando a sessão de interaction do `oidc-provider` está expirada/perdida
 * (cookie velho, F5 tardio depois do TTL, restart do servidor que limpou o
 * store efêmero), `provider.interactionDetails()` lança um `SessionNotFound`
 * — subclasse de `InvalidRequest` (`error: 'invalid_request'`). Sem tratamento
 * isso vaza para o usuário como um erro cru no meio do login.
 *
 * Perder a sessão de interaction é um caso NORMAL, não um bug do host. Por isso
 * o authkit RECUPERA por padrão: renderiza a tela themeável `session-expired`
 * (default) ou redireciona para o login (opt-in via `interactionRecovery`).
 *
 * O ponto de captura é ÚNICO — `createInteractionActions().details/consent`
 * (ver `src/provider/interaction_actions.ts`) embrulham `interactionDetails`
 * e convertem o `SessionNotFound` nesta exceção. TODOS os handlers de
 * interaction (magic link, OTP, identifier, passkeys, MFA, consent…) passam
 * por lá, então nenhum precisa de try/catch próprio.
 */

/**
 * Discriminador ROBUSTO de "sessão de interaction perdida".
 *
 * Não faz match por string de mensagem (frágil). Usa o NOME DA CLASSE do erro:
 * o `oidc-provider` seta `this.name = this.constructor.name` na base
 * `OIDCProviderError`, então toda instância de `SessionNotFound` carrega
 * `name === 'SessionNotFound'`. Outros `invalid_request` legítimos (base
 * `InvalidRequest`) têm `name === 'InvalidRequest'` — nunca colidem.
 */
export function isInteractionSessionLost(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'SessionNotFound') return true;
  // Fallback defensivo: alguns transpilers/minificadores podem mexer no `name`;
  // o nome do construtor é a fonte primária de `name` no oidc-provider.
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return ctorName === 'SessionNotFound';
}

/**
 * Exceção self-handling (contrato do `@adonisjs/http-server`: se o erro tem um
 * método `handle`, o exception handler do host delega para ele). Assim a
 * recuperação roda de forma centralizada, sem depender de o host customizar o
 * `app/exceptions/handler.ts`.
 */
export class InteractionSessionLostException extends Exception {
  static status = 400;
  static code = 'E_AUTHKIT_INTERACTION_SESSION_LOST';

  constructor() {
    super('A sessão de login expirou ou não foi encontrada. Recomece o login.', {
      status: 400,
      code: 'E_AUTHKIT_INTERACTION_SESSION_LOST',
    });
  }

  async handle(_error: this, ctx: HttpContext) {
    return recoverLostInteraction(ctx);
  }
}

/**
 * Executa a estratégia de recuperação configurada em `interactionRecovery`:
 *
 * - `mode: 'screen'` (default): renderiza a view `session-expired` (Edge
 *   built-in, ou a página React do host quando listada no allowlist do
 *   `inertiaRenderer`). Recomeço limpo por um link "voltar ao login".
 * - `mode: 'redirect'`: 302 para `redirectTo` (default: `accountLoginUrl`).
 *
 * NÃO cria loop de redirect: o destino default é o login do console de conta
 * (fluxo separado, com sua própria sessão), nunca uma URL de interaction.
 */
export async function recoverLostInteraction(ctx: HttpContext): Promise<unknown> {
  const service = await (ctx as any).containerResolver.make('authkit.server');
  const cfg = service.config;
  const recovery = cfg.interactionRecovery ?? { mode: 'screen' as const };
  const loginUrl = recovery.redirectTo ?? getAccountLoginUrl();

  if (recovery.mode === 'redirect') {
    return ctx.response.redirect(loginUrl);
  }

  // mode === 'screen': tela themeável. Brand best-effort — a sessão perdida não
  // carrega o client_id, então usamos o brand default (sem cliente).
  const render = cfg.render;
  const brand = cfg.branding ? brandFor(cfg.branding, undefined, undefined) : undefined;
  if (!render) {
    // Sem renderer configurado — degrada para redirect (nunca 500).
    return ctx.response.redirect(loginUrl);
  }
  ctx.response.status(400);
  const body = await render(ctx, 'session-expired', {
    loginUrl,
    brand,
  } satisfies ScreenRenderProps<'session-expired'>);
  // ESCREVE o body na resposta. Diferente do dispatch normal de rota — onde o
  // `useReturnValue`/`canWriteResponseBody` do http-server envia o valor
  // retornado — o caminho de exception handler DESCARTA o retorno de
  // `InteractionSessionLostException.handle()`. Por isso o modo `screen`
  // precisa fazer o `send` ele mesmo, senão o corpo nunca sai (400 vazio).
  //
  // Replica fielmente o contrato `canWriteResponseBody` do http-server
  // (`value !== undefined && !hasLazyBody && value !== ctx.response`): o guard
  // `hasLazyBody` evita double-write se algum renderer já tiver escrito, e
  // cobre os DOIS renderers built-in (Edge via `view.render` e Inertia via
  // `inertia.render`) — ambos RETORNAM o payload em vez de escrever.
  const res = ctx.response as any;
  if (body !== undefined && !res.hasLazyBody && body !== ctx.response) {
    res.send(body);
  }
  // Mantém o `return body` para o caminho de dispatch normal (caso a recuperação
  // seja chamada fora do exception handler); no exception path ele é ignorado.
  return body;
}
