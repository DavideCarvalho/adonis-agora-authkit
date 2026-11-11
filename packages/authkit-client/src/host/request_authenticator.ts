// Side-effect import: carries the `authkit.client` container binding into the emitted
// `.d.ts`, so `containerResolver.make('authkit.client')` is typed in a consumer's program.
import '../../container_bindings.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { Authenticator } from '../authenticator.js';

/**
 * Resolve (uma vez por request) o {@link Authenticator} do authkit e o memoiza
 * em `ctx.authkit`.
 *
 * É o ÚNICO caminho de resolução de sessão da lib: passa pelo
 * `AuthkitClientManager`, então o refresh proativo do token (`maybeRefresh`), o
 * `SessionResolver` configurado, as métricas e a ponte do `@agora/context`
 * continuam valendo — com ou sem o `authkitClientGuard` de `@adonisjs/auth`.
 *
 * Memoiza em `ctx.authkit` de propósito: quando o host registra o
 * `authkit_context_middleware` E o guard, os dois compartilham a MESMA
 * instância, e a sessão é resolvida (e o token renovado) uma vez só.
 */
export async function getAuthkit(ctx: HttpContext): Promise<Authenticator<AuthkitUser>> {
  const existing = (ctx as unknown as { authkit?: Authenticator<AuthkitUser> }).authkit;
  if (existing) return existing;

  const manager = await ctx.containerResolver.make('authkit.client');
  await manager.maybeRefresh(ctx);
  const authenticator = (await manager.createAuthenticator(ctx)) as Authenticator<AuthkitUser>;
  (ctx as unknown as { authkit?: Authenticator<AuthkitUser> }).authkit = authenticator;
  return authenticator;
}

/**
 * Augment this interface to type the user that `ctx.authkit.getUser()` returns
 * (whatever your `resolveUser` produces):
 *
 * ```ts
 * // types/authkit.ts
 * import type AppUser from '#models/app_user'
 *
 * declare module '@adonis-agora/authkit-client' {
 *   interface AuthkitUserType {
 *     user: AppUser
 *   }
 * }
 * ```
 */
export interface AuthkitUserType {}

/** The user type the app declared on {@link AuthkitUserType}, or `unknown`. */
export type AuthkitUser = AuthkitUserType extends { user: infer TUser } ? TUser : unknown;

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /**
     * Superfície específica do authkit (`getIdentity`, `hasGlobalRole`, a
     * `Identity` crua, `getUser`). Populada pelo `authkit_context_middleware` e,
     * no caminho do guard, pelo próprio `authkitClientGuard` ao autenticar.
     * `ctx.auth` fica livre para o `@adonisjs/auth` (via `authkitClientGuard`).
     */
    authkit: Authenticator<AuthkitUser>;
  }
}
