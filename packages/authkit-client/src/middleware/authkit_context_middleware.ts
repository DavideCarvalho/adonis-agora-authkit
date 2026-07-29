import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getAuthkit } from '../host/request_authenticator.js';

/**
 * Popula `ctx.authkit` (o `Authenticator` do authkit) e renova o token
 * proativamente — SEM tocar em `ctx.auth`.
 *
 * É o par do `authkitClientGuard`: quem adota o guard entrega `ctx.auth` ao
 * `@adonisjs/auth` (via `@adonisjs/auth/initialize_auth_middleware`) e registra
 * ESTE middleware para continuar alcançando a superfície específica do authkit
 * (`hasGlobalRole`, a `Identity` crua, `toSharedProps`) em qualquer rota,
 * inclusive nas públicas.
 *
 * ```ts
 * // start/kernel.ts
 * router.use([
 *   () => import('@adonisjs/auth/initialize_auth_middleware'),
 *   () => import('@adonis-agora/authkit-client/authkit_context_middleware'),
 * ])
 * ```
 *
 * Não substitui o `authkit_middleware`: quem NÃO usa `@adonisjs/auth` continua
 * com o `authkit_middleware`, que segue colocando o `Authenticator` em
 * `ctx.auth` como sempre. Registrar os dois não faz sentido (e resolveria a
 * sessão duas vezes em objetos distintos).
 */
export default class AuthkitContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await getAuthkit(ctx);
    return next();
  }
}
