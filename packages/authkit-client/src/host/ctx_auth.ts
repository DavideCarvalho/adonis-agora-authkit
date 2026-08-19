import type { HttpContext } from '@adonisjs/core/http';
import type { Authenticator } from '../authenticator.js';

/**
 * A LOCAL view of `ctx.auth`, for the library's own middleware.
 *
 * The middleware needs to read and write `ctx.auth`, but it must not make its
 * consumers inherit a declaration for it. A `declare module` here would travel
 * with the emitted `.d.ts` into every app that registers the middleware and
 * collide with the app's own `auth: Authenticator<AppUser>` — silently, since
 * `skipLibCheck` hides conflicts between merged declarations.
 *
 * A cast keeps the knowledge inside this package. Hosts that want the property
 * typed opt in through `@adonis-agora/authkit-client/types`; hosts that declare
 * their own parameterised version are left alone.
 */
type ContextWithAuth = HttpContext & { auth: Authenticator };

/** Read the authenticator the middleware placed on the context. */
export function ctxAuth(ctx: HttpContext): Authenticator {
  return (ctx as ContextWithAuth).auth;
}

/** Place the authenticator on the context. */
export function setCtxAuth(ctx: HttpContext, authenticator: Authenticator): void {
  (ctx as ContextWithAuth).auth = authenticator;
}
