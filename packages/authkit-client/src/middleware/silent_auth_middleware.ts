import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { ctxAuth } from '../host/ctx_auth.js';

/**
 * Resolve a identidade da sessão (popula `ctx.auth`) SEM exigir login — útil em
 * rotas públicas que mostram estado logado/deslogado. Nunca redireciona.
 *
 * ```ts
 * silentAuth: () => import('@adonis-agora/authkit-client/silent_auth_middleware'),
 * ```
 */
export default class AuthkitSilentAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await ctxAuth(ctx).check();
    return next();
  }
}
