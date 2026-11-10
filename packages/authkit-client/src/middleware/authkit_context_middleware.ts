// Side-effect import: carries the `authkit.client` container binding into the emitted
// `.d.ts` of the middleware an app registers in start/kernel.ts.
import '../../container_bindings.js';
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
 * Sem `@adonisjs/auth`, é ele sozinho que dá a sessão ao app: `ctx.authkit`
 * em qualquer rota, e `auth_middleware` para exigir login.
 */
export default class AuthkitContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await getAuthkit(ctx);
    return next();
  }
}
