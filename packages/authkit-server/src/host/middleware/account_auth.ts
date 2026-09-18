import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getAccountLoginUrl } from '../account_login_url.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { ensureConsoleSession } from '../idp_session_bridge.js';

export { ACCOUNT_SESSION_KEY };

export default class AccountAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    // Sessão do console — ou, com `accountSession.acceptIdpSession`, a do IdP (SSO).
    if (!(await ensureConsoleSession(ctx))) {
      // Destino configurável (`accountLoginUrl`): default `/account/login`.
      return ctx.response.redirect(getAccountLoginUrl());
    }
    return next();
  }
}
