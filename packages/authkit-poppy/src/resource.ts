/**
 * Lado resource server do Poppy (§4.5, §5.3, §7): verificar o header `Poppy-Session` e o access
 * token de uma request às APIs/conversas do app — e o slot GLOBAL que o `@adonis-agora/agent` usa
 * para autenticar o endpoint de conversas sem importar este pacote (instalado no boot da extension).
 *
 * Contrato do slot (o mesmo padrão do `Symbol.for('@adonis-agora/oauth:resources')`):
 *
 * ```ts
 * const authenticate = globalThis[Symbol.for('@adonis-agora/poppy:authenticate')]
 * const result = await authenticate({ method, url, headers }, { scopes?, signedIn?, resource? })
 * // { ok: true, principal } | { ok: false, status, error, scope?, wwwAuthenticate, body, headers }
 * ```
 *
 * O principal traz a versão negociada (`protocolVersion`, de `Poppy-Version`) e as extensões
 * declaradas (`extensions`, de `Poppy-Extensions`): quem verifica a Session confere a versão
 * (`version_unsupported`), e o endpoint de conversas só manda o que essa versão define (§3.4).
 */
import { ACCOUNT_SESSION_KEY } from '@adonis-agora/authkit-server';
import type { HttpContext } from '@adonisjs/core/http';
import type { PoppyPrincipalBase } from './config.js';
import type {
  PoppyOperationInput,
  PoppyOperationRecord,
  PoppyOperationResult,
} from './operations.js';
import { poppyFor, poppyFromApp } from './runtime.js';
import {
  type PoppyAuthError,
  type PoppyRequestInput,
  PoppyService,
  type PoppySessionState,
  type PoppyVerifyOptions,
} from './service.js';
import {
  POPPY_WEB_SESSION_KEY,
  type PoppyWebSessionMarker,
  poppyWebSessionOf,
} from './web_session.js';

/** Símbolo do slot global de autenticação Poppy. */
export const POPPY_AUTHENTICATE_SLOT = Symbol.for('@adonis-agora/poppy:authenticate');
/** Símbolo do slot global da extensão Operations (só com `poppy({ operations })`). */
export const POPPY_OPERATIONS_SLOT = Symbol.for('@adonis-agora/poppy:operations');

/**
 * O principal de uma request verificada.
 */
export interface PoppyPrincipal extends PoppyPrincipalBase {
  /** O que `poppy({ toActor })` devolveu, quando configurado. */
  actor?: unknown;
}

export type PoppyAuthResult =
  | {
      ok: true;
      principal: PoppyPrincipal;
      /** Headers a devolver na resposta (`Deprecation`/`Sunset` de uma versão em retirada). */
      headers: Record<string, string>;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 429;
      /** `null`: challenge sem código (falta o access token, §7) ou limite de taxa (§5.6). */
      error: PoppyAuthError | null;
      /** Scopes exigidos (challenge e `insufficient_scope`). */
      scope?: string;
      /** Valor pronto do header `WWW-Authenticate`; `null` nos erros com corpo e no 429. */
      wwwAuthenticate: string | null;
      /**
       * Corpo JSON a responder (`invalid_session`, `session_ended`, `version_unsupported`,
       * `extension_required`); `null` nos erros do access token e no 429.
       */
      body: Record<string, string> | null;
      /** Texto para logs/corpo — nunca contém o token. */
      description: string;
      /** Headers extras a devolver (`DPoP-Nonce`, `Retry-After`). */
      headers: Record<string, string>;
    };

/** Request no formato do slot (sem `HttpContext`). */
export interface PoppySlotRequest {
  method: string;
  /** URL pública completa da request (a query é ignorada). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export type PoppyAuthenticate = (
  request: PoppySlotRequest,
  options?: PoppyVerifyOptions,
) => Promise<PoppyAuthResult>;

/** URL pública da request: atrás de proxy TLS, o esquema segue o do issuer. */
export function publicRequestUrl(ctx: HttpContext, poppy: PoppyService): string {
  const url = new URL(ctx.request.completeUrl(false));
  if (new URL(poppy.urls.origin).protocol === 'https:' && url.protocol === 'http:') {
    url.protocol = 'https:';
  }
  return url.toString();
}

function requestFromCtx(ctx: HttpContext, poppy: PoppyService): PoppyRequestInput {
  return {
    method: ctx.request.method(),
    url: publicRequestUrl(ctx, poppy),
    headers: ctx.request.headers() as Record<string, string | string[] | undefined>,
  };
}

const NOT_ENABLED: PoppyAuthResult = {
  ok: false,
  status: 400,
  error: 'invalid_session',
  description: 'Poppy is not enabled',
  wwwAuthenticate: null,
  body: { error: 'invalid_session', error_description: 'Poppy is not enabled' },
  headers: {},
};

async function verifyWith(
  poppy: PoppyService,
  input: PoppyRequestInput,
  options: PoppyVerifyOptions,
): Promise<PoppyAuthResult> {
  const result = await poppy.verifyAccess(input, options);
  if (!result.ok) {
    const { ok: _ok, ...rest } = result;
    return { ok: false, ...rest };
  }
  const principal: PoppyPrincipal = { ...result.principal };
  if (poppy.cfg.toActor) principal.actor = await poppy.cfg.toActor(result.principal);
  return { ok: true, principal, headers: result.headers };
}

/**
 * Verifica o header `Poppy-Session` de uma request e, se houver, o access token. Aceita o
 * `HttpContext` ou `{ method, url, headers }`.
 */
export async function verifyPoppyRequest(
  input: HttpContext | PoppySlotRequest,
  options: PoppyVerifyOptions = {},
): Promise<PoppyAuthResult> {
  if ('request' in input && typeof (input as HttpContext).request?.method === 'function') {
    const ctx = input as HttpContext;
    const poppy = await poppyFor(ctx);
    if (!poppy) return NOT_ENABLED;
    return verifyWith(poppy, requestFromCtx(ctx, poppy), options);
  }
  const poppy = await poppyFromApp();
  if (!poppy) return NOT_ENABLED;
  return verifyWith(poppy, input as PoppySlotRequest, options);
}

/** Escreve a resposta de erro de um {@link PoppyAuthResult} recusado. */
export function writePoppyAuthError(
  ctx: HttpContext,
  result: Extract<PoppyAuthResult, { ok: false }>,
) {
  if (result.wwwAuthenticate) ctx.response.header('WWW-Authenticate', result.wwwAuthenticate);
  for (const [k, v] of Object.entries(result.headers)) ctx.response.header(k, v);
  ctx.response.header('Cache-Control', 'no-store');
  // Erros do access token vão no header, como no OAuth; os da Session, da versão e das extensões
  // vão num corpo JSON (§3.3, §3.4, §7).
  if (!result.body) return ctx.response.status(result.status).send('');
  return ctx.response.status(result.status).json(result.body);
}

/** Guardado fora do `HttpContext` (sem augmentation — ver `augmentation_isolation.spec.ts`). */
const principals = new WeakMap<HttpContext, PoppyPrincipal>();

/**
 * O principal Poppy da request — preenchido por {@link poppyAuth}.
 */
export function poppyOf(ctx: HttpContext): PoppyPrincipal | null {
  return principals.get(ctx) ?? null;
}

/**
 * Middleware das APIs/rotas que usam a Session Poppy.
 *
 * ```ts
 * router.post('/orders/:id/exchanges', [Orders, 'exchange'])
 *   .use(poppyAuth({ scopes: ['orders:write'] }))
 * ```
 *
 * Isente essas rotas do CSRF (são chamadas por agentes, sem navegador).
 */
export function poppyAuth(options: PoppyVerifyOptions = {}) {
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    const result = await verifyPoppyRequest(ctx, options);
    if (!result.ok) return writePoppyAuthError(ctx, result);
    for (const [k, v] of Object.entries(result.headers)) ctx.response.header(k, v);
    principals.set(ctx, result.principal);
    return next();
  };
}

// ─── extensão Operations ────────────────────────────────────────────────────

function isHttpContext(value: unknown): value is HttpContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'request' in value &&
    typeof (value as HttpContext).request?.method === 'function'
  );
}

async function operationsOf(ctx?: HttpContext): Promise<PoppyService> {
  const poppy = ctx ? await poppyFor(ctx) : await poppyFromApp();
  if (!poppy?.operations) {
    throw new Error(
      'authkit-poppy: a extensão Operations não está ligada (poppy({ operations })).',
    );
  }
  return poppy;
}

/** O estado do navegador na Session: do `poppyWebSession()`, ou lido do marcador da sessão. */
async function browserStateOf(
  ctx: HttpContext,
  poppy: PoppyService,
): Promise<PoppySessionState | null> {
  const known = poppyWebSessionOf(ctx);
  if (known) return known;
  const marker = (ctx as HttpContext & { session?: any }).session?.get?.(POPPY_WEB_SESSION_KEY) as
    | PoppyWebSessionMarker
    | undefined;
  if (!marker?.sessionId) return null;
  const state = await poppy.browserState(marker);
  return state?.active && state.clientId === marker.clientId ? state : null;
}

/**
 * Confere a aprovação de uma ação (extensão Operations 3) antes de executá-la.
 *
 * - API: `requirePoppyOperation(ctx, { interface: 'api', action, terms, summary })` — a aprovação
 *   vem do header `Poppy-Approval`; a rota precisa de `poppyAuth()`.
 * - MCP e conversas: passe o principal e a aprovação recebida (`approval`).
 * - Site: `requirePoppyOperation(ctx, { interface: 'website', … })` num navegador na Session
 *   (`poppyWebSession()`): usa uma aprovação gravada, ou devolve 403 com `Poppy-Operation`.
 *
 * `{ ok: true }`: execute a ação e chame {@link markPoppyOperationPerformed}. Senão, responda com
 * {@link writePoppyOperationResult} (ou, numa conversa, mande `operation`/`declined` na mensagem).
 */
export async function requirePoppyOperation(
  input: HttpContext | PoppySlotRequest | null,
  principal: PoppyPrincipalBase | null,
  operation: PoppyOperationInput,
): Promise<PoppyOperationResult>;
export async function requirePoppyOperation(
  ctx: HttpContext,
  operation: PoppyOperationInput,
): Promise<PoppyOperationResult>;
export async function requirePoppyOperation(
  input: HttpContext | PoppySlotRequest | null,
  second: PoppyPrincipalBase | PoppyOperationInput | null,
  third?: PoppyOperationInput,
): Promise<PoppyOperationResult> {
  const operation = (third ?? second) as PoppyOperationInput;
  const given = third ? (second as PoppyPrincipalBase | null) : null;
  const ctx = isHttpContext(input) ? input : undefined;
  const poppy = await operationsOf(ctx);
  const operations = poppy.operations!;
  if (operation.interface === 'website') {
    if (!ctx) throw new Error('authkit-poppy: operações do site precisam do HttpContext.');
    const unsupported: PoppyOperationResult = {
      ok: false,
      kind: 'unsupported',
      status: 0,
      body: null,
      headers: {},
    };
    const state = await browserStateOf(ctx, poppy);
    if (!state) return unsupported;
    // O site atende como a Session só um navegador logado pela entrada, ou deslogado sem login
    // próprio (Operations 3, §4 "Websites"). Um login que a entrada não deu fica com o site.
    const ownLogin =
      !state.signedIn &&
      !poppy.cfg.web?.login &&
      !!(ctx as HttpContext & { session?: any }).session?.get?.(ACCOUNT_SESSION_KEY);
    if (ownLogin) return unsupported;
    return operations.requireWebsite(
      {
        clientId: state.clientId,
        userId: state.userId,
        accountId: state.signedIn ? state.accountId : null,
        signedIn: state.signedIn,
        extensions: state.extensions,
        sid: state.sid,
      },
      operation,
    );
  }
  const principal = given ?? (ctx ? poppyOf(ctx) : null);
  if (!principal) {
    throw new Error(
      'authkit-poppy: requirePoppyOperation precisa do principal (use poppyAuth() na rota).',
    );
  }
  const headers = ctx
    ? (ctx.request.headers() as Record<string, string | string[] | undefined>)
    : ((input as PoppySlotRequest | null)?.headers ?? {});
  const approvalHeader = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'poppy-approval',
  )?.[1];
  return operations.require(PoppyService.operationActor(principal), operation, approvalHeader);
}

/** A ação foi executada: guarda `response` para os retries (Operations 3, §7). */
export async function markPoppyOperationPerformed(
  operationId: string,
  response?: { status: number; body?: unknown; headers?: Record<string, string> },
): Promise<boolean> {
  return (await operationsOf()).operations!.markPerformed(operationId, response);
}

/** A execução falhou sem efeito: a aprovação volta a valer para um retry. */
export async function releasePoppyOperation(operationId: string): Promise<boolean> {
  return (await operationsOf()).operations!.release(operationId);
}

/** Uma operação do mesmo `client_id` + User ID; `null` = não existe ou é de outro. */
export async function getPoppyOperation(
  principal: Pick<PoppyPrincipalBase, 'clientId' | 'userId'>,
  operationId: string,
): Promise<PoppyOperationRecord | null> {
  return (await operationsOf()).operations!.get(principal, operationId);
}

/**
 * Escreve a resposta de um {@link PoppyOperationResult} recusado. No site, um pedido que aceita
 * JSON recebe `{ "error": "approval_required" }`; uma página, a página de espera.
 */
export function writePoppyOperationResult(
  ctx: HttpContext,
  result: Extract<PoppyOperationResult, { ok: false }>,
) {
  if (result.kind === 'unsupported') {
    throw new Error('authkit-poppy: resultado unsupported — o site aprova do próprio jeito.');
  }
  for (const [k, v] of Object.entries(result.headers)) ctx.response.header(k, v);
  if (result.html) {
    const accept = String(ctx.request.header('accept') ?? '');
    if (!accept.includes('application/json') && accept.includes('text/html')) {
      ctx.response.header('Content-Type', 'text/html; charset=utf-8');
      return ctx.response.status(result.status).send(result.html);
    }
  }
  if (result.body === null) return ctx.response.status(result.status).send('');
  return ctx.response.status(result.status).json(result.body);
}

/**
 * O contrato do slot `Symbol.for('@adonis-agora/poppy:operations')`, para quem não importa este
 * pacote (o `@adonis-agora/agent`).
 */
export interface PoppyOperationsSlot {
  /** A versão da extensão Operations. */
  version: '3';
  require: (
    request: HttpContext | PoppySlotRequest | null,
    principal: PoppyPrincipalBase | null,
    operation: PoppyOperationInput,
  ) => Promise<PoppyOperationResult>;
  get: (
    principal: Pick<PoppyPrincipalBase, 'clientId' | 'userId'>,
    operationId: string,
  ) => Promise<PoppyOperationRecord | null>;
  markPerformed: (
    operationId: string,
    response?: { status: number; body?: unknown; headers?: Record<string, string> },
  ) => Promise<boolean>;
  release: (operationId: string) => Promise<boolean>;
}

/**
 * Publica o slot global `Symbol.for('@adonis-agora/poppy:authenticate')` (e
 * `Symbol.for('@adonis-agora/poppy:issuer')`, e `Symbol.for('@adonis-agora/poppy:operations')`
 * com a extensão Operations ligada). Chamado no boot do authkit quando a extension `poppy()` está
 * em `personalAgents.extensions`.
 */
export function installPoppySlots(issuer: string, options: { operations?: boolean } = {}): void {
  const slot = globalThis as Record<symbol, unknown>;
  const authenticate: PoppyAuthenticate = (request, options) =>
    verifyPoppyRequest(
      {
        method: request.method,
        url: request.url,
        headers: request.headers ?? {},
      },
      options,
    );
  slot[POPPY_AUTHENTICATE_SLOT] = authenticate;
  slot[Symbol.for('@adonis-agora/poppy:issuer')] = issuer;
  if (options.operations) {
    const operations: PoppyOperationsSlot = {
      version: '3',
      require: (request, principal, operation) =>
        requirePoppyOperation(request, principal, operation),
      get: getPoppyOperation,
      markPerformed: markPoppyOperationPerformed,
      release: releasePoppyOperation,
    };
    slot[POPPY_OPERATIONS_SLOT] = operations;
  } else {
    delete slot[POPPY_OPERATIONS_SLOT];
  }
}
