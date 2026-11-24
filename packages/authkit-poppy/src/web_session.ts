/**
 * O cookie do site para o navegador de um personal agent (§6): a entrada na Session, e o
 * acompanhamento do acesso à conta autorizado nela a cada request.
 */
import {
  ACCOUNT_SESSION_KEY,
  signInAccountSession,
  signOutAccountSession,
} from '@adonis-agora/authkit-server';
import type { HttpContext } from '@adonisjs/core/http';
import { poppyFor } from './runtime.js';
import type { PoppyBrowserJoin, PoppyService, PoppySessionState } from './service.js';

/**
 * Session key que marca a sessão do navegador de um personal agent Poppy (§6): o console de conta,
 * o admin e as telas de consentimento recusam essa sessão (`isAgentBrowser`). O mesmo valor de
 * quando o Poppy morava no authkit-server — sessões abertas continuam valendo.
 */
export const POPPY_WEB_SESSION_KEY = 'authkit_poppy_session';

/** A sessão é do navegador de um personal agent Poppy? */
export function isPoppyBrowser(ctx: HttpContext): boolean {
  const marker = (ctx as HttpContext & { session?: any }).session?.get?.(POPPY_WEB_SESSION_KEY);
  return typeof marker === 'object' && marker !== null && typeof marker.sessionId === 'string';
}

export interface PoppyWebSessionMarker {
  sessionId: string;
  clientId: string;
  userId: string;
  /** Conta, grant e scopes autorizados na entrada (§6, passo 2); `null` = entrada deslogada. */
  accountId: string | null;
  grantId: string | null;
  scopes: string[];
  /**
   * As extensões que o passo 2 da entrada declarou (§6): as das requests deste navegador
   * (Operations, Browser Control). Ausente num marcador de antes do campo.
   */
  extensions?: Record<string, string>;
}

/**
 * Liga o navegador à Session (§6, passo 3): regenera a sessão do app (session fixation) e a marca
 * como do agente. Uma entrada com access token faz o login na conta autorizada, no lugar de qualquer
 * outro, com o mecanismo do app — o hook `web.login`, ou a sessão de conta do authkit +
 * `adonisAuth.guard`. Uma entrada sem access token não mexe no login do navegador — a não ser que
 * uma entrada anterior o tenha logado: aí o sign-in dela termina aqui.
 */
export async function loginPoppyBrowser(
  httpCtx: HttpContext,
  poppy: PoppyService,
  result: PoppyBrowserJoin,
) {
  // Sem augmentation no barrel: a sessão é lida sem tipo.
  const ctx = httpCtx as HttpContext & { session: any };
  const login = poppy.cfg.web?.login;
  const previous = ctx.session.get(POPPY_WEB_SESSION_KEY) as PoppyWebSessionMarker | undefined;
  await ctx.session.regenerate();
  const marker: PoppyWebSessionMarker = {
    sessionId: result.sessionId,
    clientId: result.clientId,
    userId: result.userId,
    accountId: result.accountId,
    grantId: result.grantId,
    scopes: result.scopes,
    extensions: result.extensions,
  };
  ctx.session.put(POPPY_WEB_SESSION_KEY, marker);
  if (login) {
    await login(ctx, {
      sessionId: result.sessionId,
      clientId: result.clientId,
      userId: result.userId,
      accountId: result.accountId,
      scopes: result.scopes,
    });
    return;
  }
  if (result.accountId) {
    await signInAccountSession(ctx, result.accountId);
  } else if (previous?.accountId) {
    await signOutAccountSession(ctx);
  }
}

const states = new WeakMap<HttpContext, PoppySessionState>();

/**
 * Estado da Session Poppy deste navegador (preenchido por {@link poppyWebSession}).
 */
export function poppyWebSessionOf(ctx: HttpContext): PoppySessionState | null {
  return states.get(ctx) ?? null;
}

/**
 * Middleware do site: o cookie age pela conta e pelos scopes autorizados na entrada e deixa de agir
 * quando o sign-in termina (sign-out, agente desconectado); não sobrevive à Session (§6). Um login
 * antigo não volta. Coloque-o depois do middleware de sessão.
 */
export function poppyWebSession() {
  return async (httpCtx: HttpContext, next: () => Promise<void>) => {
    const ctx = httpCtx as HttpContext & { session: any };
    const marker = ctx.session?.get(POPPY_WEB_SESSION_KEY) as PoppyWebSessionMarker | undefined;
    if (!marker?.sessionId) return next();
    const poppy = await poppyFor(ctx);
    const state = poppy ? await poppy.browserState(marker) : null;
    const login = poppy?.cfg.web?.login;

    if (!state?.active || state.clientId !== marker.clientId) {
      // A Session terminou: o cookie também — e o login dela, não o do próprio navegador.
      ctx.session.forget(POPPY_WEB_SESSION_KEY);
      if (marker.accountId) await signOutAccountSession(ctx);
      await ctx.session.regenerate();
      return next();
    }
    states.set(ctx, state);
    if (login) {
      await login(ctx, {
        sessionId: state.sessionId,
        clientId: state.clientId,
        userId: state.userId,
        accountId: state.accountId,
        scopes: state.scopes,
      });
      return next();
    }
    const current = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (state.signedIn && state.accountId) {
      if (current !== state.accountId) await signInAccountSession(ctx, state.accountId);
    } else if (marker.accountId) {
      // O sign-in da entrada terminou: o navegador sai, e a Session segue deslogada.
      ctx.session.put(POPPY_WEB_SESSION_KEY, {
        ...marker,
        accountId: null,
        grantId: null,
        scopes: [],
      } satisfies PoppyWebSessionMarker);
      await signOutAccountSession(ctx);
    }
    return next();
  };
}

/**
 * O valor de `data-poppy-user-step` (extensão Browser Control 1): um passo que o usuário dá ele
 * mesmo. `interaction` num controle (ou formulário: os controles e o envio ficam com o usuário);
 * `submission` num formulário (o agente pode preencher, o envio fica com o usuário).
 */
export type PoppyUserStep = 'interaction' | 'submission';

/** O atributo, para JSX/objetos: `<form {...poppyUserStepAttrs('submission')}>`. */
export function poppyUserStepAttrs(step: PoppyUserStep): { 'data-poppy-user-step': PoppyUserStep } {
  if (step !== 'interaction' && step !== 'submission') {
    throw new Error('authkit-poppy: data-poppy-user-step é interaction ou submission.');
  }
  return { 'data-poppy-user-step': step };
}

/**
 * O atributo como HTML, para templates: `<form {{{ poppyUserStep('submission') }}}>` no Edge (o
 * global `poppyUserStep` é registrado no boot quando `browserControl` está ligado).
 */
export function poppyUserStep(step: PoppyUserStep): string {
  const { 'data-poppy-user-step': value } = poppyUserStepAttrs(step);
  return `data-poppy-user-step="${value}"`;
}

/**
 * O navegador desta request declarou Browser Control 1 na entrada (§6)? Então ele lê as marcas e
 * oferece `navigator.poppy.controller` à página.
 */
export function poppyBrowserControlOf(ctx: HttpContext): boolean {
  return poppyWebSessionOf(ctx)?.extensions['browser-control'] === '1';
}

/**
 * O `controller` que a página mandou (`navigator.poppy.controller`): `'user'`, `'agent'` ou
 * `null`. Não é assinado: registre, não confie como garantia (Browser Control 1, §8.2).
 */
export function poppyControllerOf(value: unknown): 'user' | 'agent' | null {
  return value === 'user' || value === 'agent' ? value : null;
}
