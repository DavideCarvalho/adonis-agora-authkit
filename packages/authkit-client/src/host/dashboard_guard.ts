import type { HttpContext } from '@adonisjs/core/http';
import { getAuthkit } from './request_authenticator.js';

/** Global role that counts as "admin" when the caller doesn't override it. Mirrors the default
 *  used across `@adonis-agora/authkit-server`'s own admin console (`admin.roles`, `adminRoles` on
 *  impersonation/token-exchange) — same convention, not a new one. */
const DEFAULT_ADMIN_ROLE = 'ADMIN';

export interface DashboardGuardOptions {
  /** Global role required to pass the gate. Default `'ADMIN'`. */
  role?: string;
  /**
   * The app's login page. When set, a visitor without a session is sent there (a page navigation
   * gets a `302`, an API call a `401` carrying `redirectTo`) instead of a plain `401`.
   */
  loginPath?: string;
}

/** What {@link authkitDashboardAuthorize} answers: the shared console `authorize` result. */
export type DashboardGuardResult =
  | boolean
  | { allowed: false; reason: 'unauthenticated' }
  | { redirectTo: string };

/**
 * Core predicate behind {@link authkitDashboardAuthorize}: authenticated (a resolvable authkit
 * `Identity`) AND holding the configured global role.
 *
 * Resolves the session via {@link getAuthkit} rather than reading `ctx.auth` directly: `ctx.auth`'s
 * TYPE is host-owned, so this module can't assume its shape. `getAuthkit` works with both
 * `authkit_middleware`'s `ctx.auth` and `authkitClientGuard`'s `ctx.authkit`, memoized per request.
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
 * An `authorize` for any `@adonis-agora` console (durable, telescope, media, payments, agent):
 * signed in to authkit AND holding the global role (`ADMIN` by default).
 *
 * - no session → `401` (or the `loginPath` redirect when set);
 * - signed in without the role → `403`;
 * - otherwise allowed.
 *
 * ```ts
 * // config/durable_dashboard.ts
 * import { defineConfig } from '@adonis-agora/durable/dashboard'
 * import { authkitDashboardAuthorize } from '@adonis-agora/authkit-client'
 *
 * export default defineConfig({
 *   authorize: authkitDashboardAuthorize({ loginPath: '/login' }),
 * })
 * ```
 */
export function authkitDashboardAuthorize(
  options: DashboardGuardOptions = {},
): (ctx: HttpContext) => Promise<DashboardGuardResult> {
  return async (ctx) => {
    const authkit = await getAuthkit(ctx);
    if (!(await authkit.check())) {
      return options.loginPath
        ? { redirectTo: options.loginPath }
        : { allowed: false, reason: 'unauthenticated' };
    }
    return authkit.hasGlobalRole(options.role ?? DEFAULT_ADMIN_ROLE);
  };
}
