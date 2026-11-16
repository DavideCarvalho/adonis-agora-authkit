/**
 * The identity pages this server serves, published in its discovery document so relying
 * parties (authkit-client's `registerOidcClient`) can send old links there:
 *
 * - `authkit_account_uri` — account console base (`accountRoutes.prefix`, default `/account`);
 * - `authkit_account_home_uri` — account console landing page (`accountHome`);
 * - `authkit_admin_uri` — admin console (`admin.prefix`), only when it is mounted and enabled;
 * - `authkit_forgot_password_uri`, `authkit_reset_password_uri` — password recovery.
 *
 * Absolute URLs on the issuer origin, read per request (the prefixes are set when
 * `registerAuthHost` mounts the routes, after the provider is built).
 */
import { accountHome } from '../host/account_home.js';
import { accountPrefix } from '../host/account_paths.js';
import { getAdminPrefix, isAdminConsoleMounted } from '../host/admin_prefix.js';

export const FORGOT_PASSWORD_PATH = '/auth/forgot-password';
export const RESET_PASSWORD_PATH = '/auth/reset-password';

/** The `authkit_*_uri` discovery fields for an issuer. */
export function identityPages(
  issuer: string,
  cfg: { accountHome?: string; admin?: { enabled?: boolean } },
): Record<string, string> {
  const origin = new URL(issuer).origin;
  const abs = (path: string) => new URL(path, origin).toString();
  return {
    authkit_account_uri: abs(accountPrefix()),
    authkit_account_home_uri: abs(accountHome(cfg)),
    ...(isAdminConsoleMounted() && cfg.admin?.enabled === true
      ? { authkit_admin_uri: abs(getAdminPrefix()) }
      : {}),
    authkit_forgot_password_uri: abs(FORGOT_PASSWORD_PATH),
    authkit_reset_password_uri: abs(RESET_PASSWORD_PATH),
  };
}

/** Provider (Koa) middleware adding {@link identityPages} to the discovery document. */
export function identityPagesMiddleware(
  issuer: string,
  cfg: { accountHome?: string; admin?: { enabled?: boolean } },
) {
  return async (ctx: any, next: () => Promise<void>) => {
    await next();
    if (ctx.method !== 'GET') return;
    const path = String(ctx.path ?? '').replace(/\/+$/, '');
    if (path !== '/.well-known/openid-configuration') return;
    if (!ctx.body || typeof ctx.body !== 'object') return;
    Object.assign(ctx.body, identityPages(issuer, cfg));
  };
}
