import { randomUUID } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import type { AuditSink } from '../audit/audit_sink.js';
import { ACCOUNT_SESSION_KEY } from './account_session_key.js';

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
 * Keys de sessão do registro da impersonation (id + tempos + prova do
 * exchange). Internas pelo mesmo motivo da key do impersonator: o contrato
 * público é `impersonationState` / o retorno de `startImpersonation`.
 */
const IMPERSONATION_ID_SESSION_KEY = 'impersonation_id';
const IMPERSONATION_STARTED_AT_SESSION_KEY = 'impersonation_started_at';
const IMPERSONATION_EXPIRES_AT_SESSION_KEY = 'impersonation_expires_at';
const IMPERSONATION_ACT_SESSION_KEY = 'impersonation_act_sub';
const IMPERSONATION_EXCHANGE_EXPIRES_IN_SESSION_KEY = 'impersonation_exchange_expires_in';

/**
 * Key de sessão que guarda o access token do admin, necessário como
 * `subject_token` do token-exchange. Interna: NÃO exporte o literal.
 */
const ADMIN_ACCESS_TOKEN_SESSION_KEY = 'admin_access_token';

/**
 * Key de sessão que guarda o refresh token do admin (do `offline_access`),
 * usado para renovar o access token expirado antes do token-exchange. Interna:
 * NÃO exporte o literal.
 */
const ADMIN_REFRESH_TOKEN_SESSION_KEY = 'admin_refresh_token';

const REFRESH_TOKEN_GRANT = 'refresh_token';

/**
 * Guarda o access token do admin na sessão (chame no callback OIDC do RP, logo
 * após o login). Necessário porque o token-exchange exige o access token do admin
 * como `subject_token`, e o RP normalmente descarta os tokens após o login.
 *
 * Access tokens são curtos: se expirar, `startImpersonation` renova via refresh
 * token (`rememberRefreshToken`) e tenta de novo — o admin não precisa relogar.
 */
export function rememberAccessToken(ctx: HttpContext, accessToken: string): void {
  ctx.session.put(ADMIN_ACCESS_TOKEN_SESSION_KEY, accessToken);
}

/**
 * Guarda o refresh token do admin (do scope `offline_access`), usado para
 * renovar o access token expirado antes do token-exchange. Chame no callback
 * OIDC do RP junto com `rememberAccessToken`.
 */
export function rememberRefreshToken(ctx: HttpContext, refreshToken: string): void {
  ctx.session.put(ADMIN_REFRESH_TOKEN_SESSION_KEY, refreshToken);
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
  /**
   * Vida máxima da impersonation em SEGUNDOS, contada do start. Quando
   * definido, `impersonationState().active` passa a `false` após o prazo
   * (expiração preguiçosa — nenhum timer roda; a leitura decide) e o stop
   * continua restaurando o admin normalmente.
   *
   * OPCIONAL e ausente por default: sem ele a impersonation dura até o stop
   * explícito / logout / fim da sessão (comportamento histórico — um default
   * com prazo faria a impersonation "parar sozinha" para quem não configurou
   * nada). Deve ser > 0.
   */
  maxAge?: number;
}

export interface ImpersonationState {
  active: boolean;
  /** = `account_user_id` atual, quando `active`. */
  targetId?: string;
  /** O admin real (impersonator), quando `active`. */
  impersonatorId?: string;
  /** Id único desta impersonation (gerado no start). */
  impersonationId?: string;
  /** Epoch ms do start. */
  startedAt?: number;
  /** Epoch ms da expiração — só quando `maxAge` foi configurado. */
  expiresAt?: number;
  /**
   * `act.sub` devolvido pelo token-exchange (o ator PROVADO pelo IdP, que
   * deve coincidir com `impersonatorId`).
   */
  actSub?: string;
  /**
   * `expires_in` (segundos) do token trocado — INFORMATIVO: é a vida do token
   * do lado do IdP, NÃO impõe expiração na sessão (só `maxAge` faz isso).
   */
  exchangeExpiresIn?: number;
}

/** Metadados aproveitados da resposta do token-exchange (só o que não é segredo). */
export interface TokenExchangeResult {
  /** `expires_in` (s) do token trocado, quando o IdP informa. */
  expiresIn?: number;
  /** `act.sub` (ator provado pelo IdP), quando o IdP informa. */
  actSub?: string;
}

/**
 * POST inline do RFC 8693 token-exchange. Inline (em vez de depender de
 * `@adonis-agora/authkit-client`) porque o client NÃO é dependência do server e
 * adicioná-la inverteria a direção do grafo de pacotes (server = IdP toolkit). São
 * ~12 linhas; testável via `fetchImpl`. Lança se o IdP não responder 2xx (é o
 * gatekeeper: não-admin / token expirado ⇒ erro ⇒ a sessão não é tocada).
 *
 * Em sucesso devolve os metadados NÃO-secretos da resposta (`expires_in` e
 * `act.sub`) — o access token trocado é DESCARTADO de propósito: é uma
 * credencial bearer do alvo e nada no fluxo o consome depois do start
 * (o app age como o alvo via troca de sessão, não via bearer). NUNCA guarde
 * esse token na sessão. O parse do corpo é tolerante: IdP que responde 2xx
 * sem JSON válido ainda conta como exchange OK, só sem metadados.
 */
async function requestTokenExchange(
  params: StartImpersonationParams,
  subjectToken: string,
): Promise<TokenExchangeResult> {
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

  const result: TokenExchangeResult = {};
  try {
    const data = (await res.json()) as {
      expires_in?: unknown;
      act?: unknown;
    };
    if (typeof data?.expires_in === 'number' && Number.isFinite(data.expires_in)) {
      result.expiresIn = data.expires_in;
    }
    const act = data?.act as { sub?: unknown } | undefined;
    if (act && typeof act.sub === 'string' && act.sub.length > 0) {
      result.actSub = act.sub;
    }
  } catch {
    // Corpo fora do JSON esperado: exchange valeu, metadados ficam ausentes.
  }
  return result;
}

/**
 * Renova o access token do admin via refresh grant (RFC 6749 §6), usando o
 * refresh token guardado por `rememberRefreshToken`. Retorna o novo access
 * token (e o refresh token rotacionado, se o IdP emitir outro), ou null se não
 * houver refresh token / o refresh falhar.
 *
 * O IdP deste pacote roda `refresh_token` grant por default
 * (`build_provider.ts`: `grant_types: ['authorization_code', 'refresh_token']`),
 * então o refresh é válido na configuração padrão.
 */
export async function refreshAccessToken(
  ctx: HttpContext,
  params: Pick<
    StartImpersonationParams,
    'issuer' | 'clientId' | 'clientSecret' | 'tokenEndpoint' | 'fetchImpl'
  >,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  const refreshToken = ctx.session.get(ADMIN_REFRESH_TOKEN_SESSION_KEY) as string | undefined;
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: REFRESH_TOKEN_GRANT,
    refresh_token: refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(params.tokenEndpoint ?? `${params.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) return null;

  const result: { accessToken: string; refreshToken?: string } = { accessToken: data.access_token };
  if (data.refresh_token) result.refreshToken = data.refresh_token;
  return result;
}

/**
 * Inicia a impersonation: lê o access token do admin da sessão, chama o
 * token-exchange (o IdP valida a role admin e audita) e SÓ em sucesso guarda o
 * impersonator (= `account_user_id` atual), regenera a sessão (anti-fixation) e
 * seta `account_user_id = targetId`.
 *
 * Além da troca de identidade, registra a impersonation: um id único
 * (`impersonationId`), o instante do start e — só com `maxAge` configurado —
 * a expiração, mais os metadados não-secretos do exchange (`actSub`,
 * `exchangeExpiresIn`). Devolve o estado criado (o mesmo shape de
 * `impersonationState`).
 *
 * - Se o exchange falhar, LANÇA e NÃO troca NADA na sessão.
 * - Recusa (lança) se já houver impersonation ativa (pare a atual antes) —
 *   inclusive expirada pelo prazo: expirar só apaga o `active` da leitura,
 *   encerrar continua explícito via `stopImpersonation`.
 * - Recusa (lança) se não houver access token do admin na sessão.
 * - Recusa (lança) `maxAge` não-positivo (fail-fast de misconfiguração).
 */
export async function startImpersonation(
  ctx: HttpContext,
  params: StartImpersonationParams,
): Promise<ImpersonationState> {
  if (ctx.session.get(IMPERSONATOR_SESSION_KEY)) {
    throw new Error('Impersonation already active; stop the current one before starting another');
  }

  if (params.maxAge !== undefined && !(params.maxAge > 0)) {
    throw new Error('Invalid maxAge: must be a positive number of seconds');
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
  let exchange: TokenExchangeResult;
  try {
    exchange = await requestTokenExchange(params, adminAccessToken);
  } catch (err) {
    // Access token expirado (4xx do exchange): renova via refresh token e tenta
    // de novo. Sem refresh token / refresh falho → propaga o erro original.
    if (!(err instanceof Error) || !/exchange failed: 4\d\d/.test(err.message)) throw err;
    const refreshed = await refreshAccessToken(ctx, params);
    if (!refreshed) throw err;
    rememberAccessToken(ctx, refreshed.accessToken);
    if (refreshed.refreshToken) rememberRefreshToken(ctx, refreshed.refreshToken);
    exchange = await requestTokenExchange(params, refreshed.accessToken);
  }

  // Anti-fixation: rotaciona o id da sessão (mantém os dados) antes de gravar a
  // nova identidade. Mesmo padrão do consumidor real no RP.
  await ctx.session.regenerate();

  const impersonationId = randomUUID();
  const startedAt = Date.now();
  const expiresAt = params.maxAge !== undefined ? startedAt + params.maxAge * 1000 : undefined;

  // ESCALAÇÃO DE PRIVILÉGIO (fechada por vinculação): trocar a conta aqui NÃO
  // pode carregar junto o sudo que o admin confirmou sobre a PRÓPRIA conta —
  // senão ele entraria personificando já com a graça aberta sobre a conta
  // alheia (exportar/excluir dados, MFA, PATs). Não limpamos a marca aqui: ela
  // é vinculada à conta que a confirmou (`SUDO_ACCOUNT_SESSION_KEY`), então
  // `isSudoActive` a recusa sozinho assim que `ACCOUNT_SESSION_KEY` muda. A
  // garantia é estrutural — vale para qualquer troca de conta futura, sem
  // depender de um `forget` lembrado em cada nova transição.
  ctx.session.put(IMPERSONATION_ID_SESSION_KEY, impersonationId);
  ctx.session.put(IMPERSONATION_STARTED_AT_SESSION_KEY, startedAt);
  if (expiresAt !== undefined) ctx.session.put(IMPERSONATION_EXPIRES_AT_SESSION_KEY, expiresAt);
  if (exchange.actSub) ctx.session.put(IMPERSONATION_ACT_SESSION_KEY, exchange.actSub);
  if (exchange.expiresIn !== undefined) {
    ctx.session.put(IMPERSONATION_EXCHANGE_EXPIRES_IN_SESSION_KEY, exchange.expiresIn);
  }
  ctx.session.put(IMPERSONATOR_SESSION_KEY, impersonatorId);
  ctx.session.put(ACCOUNT_SESSION_KEY, params.targetId);

  return impersonationState(ctx);
}

/**
 * Estado da impersonation pra UI (ex.: banner). `active` quando há um impersonator
 * guardado na sessão E a impersonation não expirou (expiração preguiçosa: com
 * `maxAge` configurado no start, passado o prazo a leitura devolve
 * `active: false` — mas os dados seguem na sessão até o `stopImpersonation`
 * explícito, que continua restaurando o admin normalmente).
 *
 * O shape evita keys com valor `undefined` (construção condicional): `{ active:
 * false }` puro quando nunca houve impersonation.
 */
export function impersonationState(ctx: HttpContext): ImpersonationState {
  const impersonatorId = ctx.session.get(IMPERSONATOR_SESSION_KEY) as string | undefined;
  if (!impersonatorId) return { active: false };
  const targetId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
  const state: ImpersonationState = { active: true, targetId, impersonatorId };

  const impersonationId = ctx.session.get(IMPERSONATION_ID_SESSION_KEY) as string | undefined;
  if (impersonationId) state.impersonationId = impersonationId;
  const startedAt = ctx.session.get(IMPERSONATION_STARTED_AT_SESSION_KEY) as number | undefined;
  if (typeof startedAt === 'number') state.startedAt = startedAt;
  const expiresAt = ctx.session.get(IMPERSONATION_EXPIRES_AT_SESSION_KEY) as number | undefined;
  if (typeof expiresAt === 'number') state.expiresAt = expiresAt;
  const actSub = ctx.session.get(IMPERSONATION_ACT_SESSION_KEY) as string | undefined;
  if (actSub) state.actSub = actSub;
  const exchangeExpiresIn = ctx.session.get(IMPERSONATION_EXCHANGE_EXPIRES_IN_SESSION_KEY) as
    | number
    | undefined;
  if (typeof exchangeExpiresIn === 'number') state.exchangeExpiresIn = exchangeExpiresIn;

  if (state.expiresAt !== undefined && Date.now() > state.expiresAt) {
    state.active = false;
  }
  return state;
}

/** Opções do `stopImpersonation`. */
export interface StopImpersonationOptions {
  /**
   * Sink para auditar o encerramento (`impersonation.stopped`, com o
   * `impersonationId`). Sem ele, o stop só mexe na sessão — o start segue
   * auditado pelo IdP, mas o fim da impersonation não aparece na trilha.
   */
  audit?: AuditSink;
  /** IP a registrar no evento de auditoria (o helper não lê o request). */
  ip?: string | null;
}

/**
 * Encerra a impersonation: restaura `account_user_id = impersonator`, remove
 * TODAS as keys de sessão de impersonation (id, tempos, prova do exchange) e
 * regenera a sessão (anti-fixation). Devolve o estado encerrado (com o
 * `impersonationId`, mesmo que já expirado pelo prazo) ou `null` quando não
 * havia nenhuma ativa (no-op — sem audit, sem regenerate).
 *
 * O `admin_access_token` (a credencial do ADMIN usada como `subject_token` do
 * token-exchange) é PRESERVADO: ele é do admin — não do alvo — e o admin segue
 * logado após o stop. Removê-lo forçava um relogin a cada vez que o admin
 * personificava, saía e tentava personificar de novo (No admin access token in
 * session). O token segue curto (TTL do access token do RP) e o logout do app
 * (`ctx.session.clear()` em `AuthRpController.logout`) continua limpando tudo.
 */
export async function stopImpersonation(
  ctx: HttpContext,
  options?: StopImpersonationOptions,
): Promise<ImpersonationState | null> {
  const stopped = impersonationState(ctx);
  if (!stopped.impersonatorId) return null;

  await ctx.session.regenerate();

  // Simétrico ao `startImpersonation`: o sudo obtido ENQUANTO personificava
  // ficaria valendo sobre a conta do admin ao voltar. A vinculação corta isso —
  // aquela marca aponta para a conta personificada e morre com a volta.
  //
  // Nota: se o admin tinha sudo sobre a própria conta ANTES de personificar e a
  // graça ainda não venceu, ele volta valendo. Correto e intencional: é a
  // confirmação dele, sobre a conta dele, dentro da janela dele.
  ctx.session.put(ACCOUNT_SESSION_KEY, stopped.impersonatorId);
  ctx.session.forget(IMPERSONATOR_SESSION_KEY);
  ctx.session.forget(IMPERSONATION_ID_SESSION_KEY);
  ctx.session.forget(IMPERSONATION_STARTED_AT_SESSION_KEY);
  ctx.session.forget(IMPERSONATION_EXPIRES_AT_SESSION_KEY);
  ctx.session.forget(IMPERSONATION_ACT_SESSION_KEY);
  ctx.session.forget(IMPERSONATION_EXCHANGE_EXPIRES_IN_SESSION_KEY);

  await options?.audit?.record({
    type: 'impersonation.stopped',
    accountId: stopped.targetId ?? null,
    actorId: stopped.impersonatorId,
    ip: options?.ip ?? null,
    metadata: {
      impersonationId: stopped.impersonationId ?? null,
      startedAt: stopped.startedAt ?? null,
      stoppedAt: Date.now(),
      expired: !stopped.active,
    },
  });

  return stopped;
}
