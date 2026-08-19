import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getAccountLoginUrl } from '../account_login_url.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';

export { ACCOUNT_SESSION_KEY };

export default class AccountAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!userId) {
      // Destino configurável (`accountLoginUrl`): default `/account/login`.
      return ctx.response.redirect(getAccountLoginUrl());
    }
    return next();
  }
}
