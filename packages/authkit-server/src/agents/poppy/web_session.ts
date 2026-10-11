/**
 * O cookie do site para o navegador de um personal agent (§5): login pela
 * asserção de navegador, e o acompanhamento do estado da Session a cada request.
 */
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../../host/account_session_key.js';
import { syncAdonisAuthLogin, syncAdonisAuthLogout } from '../../host/adonis_auth_sync.js';
import { POPPY_WEB_SESSION_KEY } from '../../host/poppy_session_key.js';
import { personalAgentsFor } from '../runtime.js';
import type { PoppyBrowserSessionResult, PoppySessionState } from './service.js';

export interface PoppyWebSessionMarker {
  sessionId: string;
  clientId: string;
  userId: string;
}

/**
 * Liga o navegador à Session: regenera a sessão do app (session fixation),
 * marca-a como do agente e, se a Session está logada, faz o login com o
 * mecanismo do app — o hook `web.login`, ou a sessão de conta do authkit +
 * `adonisAuth.guard`.
 */
export async function loginPoppyBrowser(httpCtx: HttpContext, result: PoppyBrowserSessionResult) {
  // Sem augmentation no barrel (ver `augmentation_isolation.spec.ts`): a sessão é lida sem tipo.
  const ctx = httpCtx as HttpContext & { session: any };
  const service = await ctx.containerResolver.make('authkit.server');
  const cfg = service.config;
  const login = cfg.personalAgents?.poppy?.web?.login;
  await ctx.session.regenerate();
  ctx.session.forget(ACCOUNT_SESSION_KEY);
  const marker: PoppyWebSessionMarker = {
    sessionId: result.sessionId,
    clientId: result.clientId,
    userId: result.userId,
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
    ctx.session.put(ACCOUNT_SESSION_KEY, result.accountId);
    const account = await cfg.accountStore.findById(result.accountId);
    if (account) await syncAdonisAuthLogin(ctx, cfg, account);
  } else {
    await syncAdonisAuthLogout(ctx, cfg);
  }
}

const states = new WeakMap<HttpContext, PoppySessionState>();

/** Estado da Session Poppy deste navegador (preenchido por {@link poppyWebSession}). *
/** Estado da Session Poppy deste navegador (preenchido por {@link poppyWebSession}). * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
/** Estado da Session Poppy deste navegador (preenchido por {@link poppyWebSession}). *   de forma incompatível fora de majors enquanto ela for draft.
/** Estado da Session Poppy deste navegador (preenchido por {@link poppyWebSession}). */
export function poppyWebSessionOf(ctx: HttpContext): PoppySessionState | null {
  return states.get(ctx) ?? null;
}

/**
 * Middleware do site: um navegador de agente segue o estado ATUAL da Session
 * (§5 — logou/deslogou/mudou de scopes, o próximo request reflete; o cookie não
 * sobrevive à Session). Coloque-o depois do middleware de sessão.
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export function poppyWebSession() {
  return async (httpCtx: HttpContext, next: () => Promise<void>) => {
    const ctx = httpCtx as HttpContext & { session: any };
    const marker = ctx.session?.get(POPPY_WEB_SESSION_KEY) as PoppyWebSessionMarker | undefined;
    if (!marker?.sessionId) return next();
    const runtime = await personalAgentsFor(ctx);
    const state = runtime?.poppy ? await runtime.poppy.sessionState(marker.sessionId) : null;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const login = cfg.personalAgents?.poppy?.web?.login;

    if (!state?.active || state.clientId !== marker.clientId) {
      // A Session terminou: o cookie também.
      ctx.session.forget(POPPY_WEB_SESSION_KEY);
      ctx.session.forget(ACCOUNT_SESSION_KEY);
      await ctx.session.regenerate();
      await syncAdonisAuthLogout(ctx, cfg);
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
    if (state.signedIn && state.accountId && current !== state.accountId) {
      ctx.session.put(ACCOUNT_SESSION_KEY, state.accountId);
      const account = await cfg.accountStore.findById(state.accountId);
      if (account) await syncAdonisAuthLogin(ctx, cfg, account);
    } else if (!state.signedIn && current) {
      ctx.session.forget(ACCOUNT_SESSION_KEY);
      await syncAdonisAuthLogout(ctx, cfg);
    }
    return next();
  };
}
