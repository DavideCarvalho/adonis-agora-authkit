/**
 * Lado resource server do Poppy (§4.3, §6): verificar o Session Token de uma
 * request às APIs/conversas do app — e o slot GLOBAL que o `@adonis-agora/agent`
 * usa para autenticar o endpoint de conversas sem importar este pacote.
 *
 * Contrato do slot (o mesmo padrão do `Symbol.for('@adonis-agora/oauth:resources')`):
 *
 * ```ts
 * const authenticate = globalThis[Symbol.for('@adonis-agora/poppy:authenticate')]
 * const result = await authenticate({ method, url, headers }, { scopes?, signedIn?, resource? })
 * // { ok: true, principal } | { ok: false, status, error, scope?, wwwAuthenticate, headers }
 * ```
 */
import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../../services/booted_app.js';
import { buildPersonalAgentsRuntime, personalAgentsFor } from '../runtime.js';
import type { PoppyPrincipalBase } from './config.js';
import type {
  PoppyAuthError,
  PoppyRequestInput,
  PoppyService,
  PoppyVerifyOptions,
} from './service.js';

/** Símbolo do slot global de autenticação Poppy. */
export const POPPY_AUTHENTICATE_SLOT = Symbol.for('@adonis-agora/poppy:authenticate');

/** O principal de um Session Token válido. *
/** O principal de um Session Token válido. * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
/** O principal de um Session Token válido. *   de forma incompatível fora de majors enquanto ela for draft.
/** O principal de um Session Token válido. */
export interface PoppyPrincipal extends PoppyPrincipalBase {
  /** O que `personalAgents.poppy.toActor` devolveu, quando configurado. */
  actor?: unknown;
}

/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — pode mudar de forma incompatível enquanto a spec for draft.
 */
export type PoppyAuthResult =
  | { ok: true; principal: PoppyPrincipal }
  | {
      ok: false;
      status: 401 | 403;
      error: PoppyAuthError;
      /** Scopes exigidos (`insufficient_scope`). */
      scope?: string;
      /** Valor pronto do header `WWW-Authenticate`. */
      wwwAuthenticate: string;
      /** Texto para logs/corpo — nunca contém o token. */
      description: string;
      /** Headers extras a devolver (`DPoP-Nonce`). */
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
  status: 401,
  error: 'invalid_token',
  description: 'Poppy is not enabled',
  wwwAuthenticate: 'DPoP error="invalid_token"',
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
  return { ok: true, principal };
}

async function poppyFromBootedApp(): Promise<PoppyService | null> {
  const app = getBootedApp();
  const service = await app.container.make('authkit.server' as any);
  const runtime = await buildPersonalAgentsRuntime(
    service as any,
    () => app.container.make('lucid.db' as any),
    { make: (binding) => app.container.make(binding as any) },
  );
  return runtime?.poppy ?? null;
}

/**
 * Verifica o Session Token de uma request (DPoP; Bearer só no MCP para o qual
 * foi emitido). Aceita o `HttpContext` ou `{ method, url, headers }`.
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export async function verifyPoppyRequest(
  input: HttpContext | PoppySlotRequest,
  options: PoppyVerifyOptions = {},
): Promise<PoppyAuthResult> {
  if ('request' in input && typeof (input as HttpContext).request?.method === 'function') {
    const ctx = input as HttpContext;
    const poppy = (await personalAgentsFor(ctx))?.poppy;
    if (!poppy) return NOT_ENABLED;
    return verifyWith(poppy, requestFromCtx(ctx, poppy), options);
  }
  const poppy = await poppyFromBootedApp();
  if (!poppy) return NOT_ENABLED;
  return verifyWith(poppy, input as PoppySlotRequest, options);
}

/** Escreve a resposta de erro de um {@link PoppyAuthResult} recusado. */
export function writePoppyAuthError(
  ctx: HttpContext,
  result: Extract<PoppyAuthResult, { ok: false }>,
) {
  ctx.response.header('WWW-Authenticate', result.wwwAuthenticate);
  for (const [k, v] of Object.entries(result.headers)) ctx.response.header(k, v);
  ctx.response.header('Cache-Control', 'no-store');
  return ctx.response.status(result.status).json({
    error: result.error,
    error_description: result.description,
    ...(result.scope ? { scope: result.scope } : {}),
  });
}

/** Guardado fora do `HttpContext` (sem augmentation — ver `augmentation_isolation.spec.ts`). */
const principals = new WeakMap<HttpContext, PoppyPrincipal>();

/** O principal Poppy da request — preenchido por {@link poppyAuth}. *
/** O principal Poppy da request — preenchido por {@link poppyAuth}. * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
/** O principal Poppy da request — preenchido por {@link poppyAuth}. *   de forma incompatível fora de majors enquanto ela for draft.
/** O principal Poppy da request — preenchido por {@link poppyAuth}. */
export function poppyOf(ctx: HttpContext): PoppyPrincipal | null {
  return principals.get(ctx) ?? null;
}

/**
 * Middleware das APIs/rotas que aceitam Session Tokens Poppy.
 *
 * ```ts
 * router.post('/orders/:id/exchanges', [Orders, 'exchange'])
 *   .use(poppyAuth({ scopes: ['poppy:write'] }))
 * ```
 *
 * Isente essas rotas do CSRF (são chamadas por agentes, sem navegador).
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export function poppyAuth(options: PoppyVerifyOptions = {}) {
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    const result = await verifyPoppyRequest(ctx, options);
    if (!result.ok) return writePoppyAuthError(ctx, result);
    principals.set(ctx, result.principal);
    return next();
  };
}

/**
 * Publica o slot global `Symbol.for('@adonis-agora/poppy:authenticate')` (e
 * `Symbol.for('@adonis-agora/poppy:issuer')`). Chamado no boot do provider
 * quando `personalAgents.poppy` está no config.
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export function installPoppySlots(issuer: string): void {
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
}
