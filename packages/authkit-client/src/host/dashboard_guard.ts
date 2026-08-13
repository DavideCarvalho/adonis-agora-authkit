import type { HttpContext } from '@adonisjs/core/http';
import { getAuthkit } from './request_authenticator.js';

/** Global role that counts as "admin" when the caller doesn't override it. Mirrors the default
 *  used across `@adonis-agora/authkit-server`'s own admin console (`admin.roles`, `adminRoles` on
 *  impersonation/token-exchange) — same convention, not a new one. */
const DEFAULT_ADMIN_ROLE = 'ADMIN';

export interface DashboardGuardOptions {
  /** Global role required to pass the gate. Default `'ADMIN'`. */
  role?: string;
}

/**
 * Core predicate behind {@link authkitDashboardAuthorize} and
 * {@link authkitDashboardMiddleware}: authenticated (a resolvable authkit `Identity`) AND holding
 * the configured global role — `ctx.auth.hasGlobalRole('ADMIN')`, the pattern hosts already
 * hand-roll per embedded admin dashboard (durable/media/agent/telescope).
 *
 * Resolves the session via {@link getAuthkit} rather than reading `ctx.auth` directly: `ctx.auth`'s
 * TYPE is host-owned (each app augments `HttpContext.auth` for its own user model, or leaves it to
 * `@adonisjs/auth`'s guard), so this module — shipped from the library, with no visibility into
 * that augmentation — can't assume its shape. `getAuthkit` is the one session-resolution path that
 * works either way (legacy `authkit_middleware`'s `ctx.auth` or the newer `authkitClientGuard`'s
 * `ctx.authkit`), memoizing so a second call in the same request is free.
 */
export async function isAuthkitAdmin(
  ctx: HttpContext,
  options: DashboardGuardOptions = {},
): Promise<boolean> {
  const authkit = await getAuthkit(ctx);
  if (!(await authkit.check())) return false;
  return authkit.hasGlobalRole(options.role ?? DEFAULT_ADMIN_ROLE);
}

/**
 * Adapter for the `authorize: (ctx) => boolean` shape that `@adonis-agora/durable`,
 * `@adonis-agora/agent` and `@adonis-agora/telescope` dashboard configs expect. A `false` return
 * makes the provider reply `403 { error: 'forbidden' }` — the provider's own behavior, unchanged
 * here.
 *
 * ```ts
 * // config/durable_dashboard.ts
 * import { defineConfig } from '@adonis-agora/durable/dashboard'
 * import { authkitDashboardAuthorize } from '@adonis-agora/authkit-client'
 *
 * export default defineConfig({
 *   authorize: authkitDashboardAuthorize(),
 * })
 * ```
 */
export function authkitDashboardAuthorize(
  options: DashboardGuardOptions = {},
): (ctx: HttpContext) => Promise<boolean> {
  return (ctx) => isAuthkitAdmin(ctx, options);
}

/**
 * Adapter for the `middleware: (ctx, next) => Promise<void>` shape that
 * `@adonis-agora/media`'s dashboard config expects. Mirrors the hand-rolled `requireAdmin` apps
 * wrote themselves: no session -> `401`; session without the role -> `403`; otherwise `next()`.
 *
 * ```ts
 * // config/media_dashboard.ts
 * import { defineConfig } from '@adonis-agora/media/dashboard'
 * import { authkitDashboardMiddleware } from '@adonis-agora/authkit-client'
 *
 * export default defineConfig({
 *   middleware: authkitDashboardMiddleware(),
 * })
 * ```
 */
export function authkitDashboardMiddleware(
  options: DashboardGuardOptions = {},
): (ctx: HttpContext, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const authkit = await getAuthkit(ctx);
    if (!(await authkit.check())) {
      ctx.response.unauthorized({ message: 'Authentication required' });
      return;
    }
    if (!authkit.hasGlobalRole(options.role ?? DEFAULT_ADMIN_ROLE)) {
      ctx.response.forbidden({ message: 'Admin access required' });
      return;
    }
    await next();
  };
}
