import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { accountHome } from '../account_home.js';
import { getAccountLoginUrl } from '../account_login_url.js';
import {
  authorizationPath,
  CONSOLE_SSO_CALLBACK_PATH,
  CONSOLE_SSO_CLIENT_ID,
  CONSOLE_SSO_STATE_KEY,
  type ConsoleSsoState,
  newConsoleSsoState,
} from '../console_sso.js';
import { ensureConsoleSession } from '../idp_session_bridge.js';
import { redirectExact } from '../redirect_exact.js';
import { validateReturnTo } from './account_session_controller.js';

/**
 * Login do console pelo IdP (ver `console_sso.ts`).
 *
 *   GET /auth/console/sso?return_to=…   → authorize do client interno
 *   GET /auth/console/callback?state=…  → valida o state, abre o console pela ponte
 */
export default class ConsoleSsoController {
  async start(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const returnTo = validateReturnTo(
      (ctx.request as any).qs?.()?.return_to ?? ctx.request.input?.('return_to'),
    );

    // SSO desligado (`acceptIdpSession: false`): o console só tem o login próprio.
    if (cfg.accountSession?.acceptIdpSession !== true) {
      const login = getAccountLoginUrl();
      const sep = login.includes('?') ? '&' : '?';
      return redirectExact(
        ctx.response,
        returnTo ? `${login}${sep}return_to=${encodeURIComponent(returnTo)}` : login,
      );
    }

    // Já tem sessão (de console ou do IdP): não precisa passar pelo IdP.
    if (await ensureConsoleSession(ctx)) {
      return redirectExact(ctx.response, returnTo ?? accountHome(cfg));
    }

    const state = newConsoleSsoState();
    ctx.session.put(CONSOLE_SSO_STATE_KEY, { state, returnTo } satisfies ConsoleSsoState);

    const origin = new URL(cfg.issuer).origin;
    const query = new URLSearchParams({
      client_id: CONSOLE_SSO_CLIENT_ID,
      response_type: 'none',
      scope: 'openid',
      redirect_uri: `${origin}${CONSOLE_SSO_CALLBACK_PATH}`,
      state,
    });
    return redirectExact(
      ctx.response,
      `${authorizationPath(cfg.issuer, service.provider)}?${query.toString()}`,
    );
  }

  async callback(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const pending = ctx.session.get(CONSOLE_SSO_STATE_KEY) as ConsoleSsoState | undefined;
    ctx.session.forget(CONSOLE_SSO_STATE_KEY);
    const qs = ((ctx.request as any).qs?.() ?? {}) as Record<string, unknown>;

    // `state` amarra o callback ao navegador que iniciou o login (anti-CSRF de login).
    if (!pending || typeof qs.state !== 'string' || qs.state !== pending.state) {
      return ctx.response.status(400).send('Invalid or expired sign-in request.');
    }

    // O IdP recusou (o usuário cancelou, conta desabilitada, …): sem console.
    // Vai para a raiz, e não de volta ao console, para não entrar em loop.
    if (typeof qs.error === 'string') {
      return redirectExact(ctx.response, '/');
    }

    if (!(await ensureConsoleSession(ctx))) {
      return redirectExact(ctx.response, '/');
    }
    return redirectExact(ctx.response, pending.returnTo ?? accountHome(cfg));
  }
}
