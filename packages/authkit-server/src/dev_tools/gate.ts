import type { HttpContext } from '@adonisjs/core/http';
import { supportsAccountStatus } from '../accounts/account_store.js';
import type { ConsoleAuthorizeDecision } from '../console_authorize.js';
import { resolveAccountRoles } from '../host/account_roles.js';
import { adminAuthorizeChecker, appInProduction } from '../host/admin_authorize.js';
import type { DevToolsDecision } from './contract.js';

/** The `ctx.authkit` surface the gate reads (authkit-client's authenticator, or the dev endpoint's bridge). */
interface AuthenticatorLike {
  getIdentity?(): Promise<{ userId?: unknown } | null>;
}

/** Options for {@link authkitDevToolsAuthorize} (tests inject `inProduction`). */
export interface DevToolsGateOptions {
  inProduction?: () => boolean;
}

function fromConsoleDecision(decision: ConsoleAuthorizeDecision): DevToolsDecision {
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    reason: decision.status === 401 ? 'unauthenticated' : 'forbidden',
    ...(decision.redirectTo !== undefined ? { redirectTo: decision.redirectTo } : {}),
  };
}

/** The account signed in on this request through authkit (`ctx.authkit`), or `null`. */
async function signedInAccountId(ctx: HttpContext): Promise<string | null> {
  const authenticator = (ctx as unknown as { authkit?: AuthenticatorLike }).authkit;
  if (typeof authenticator?.getIdentity !== 'function') return null;
  try {
    const identity = await authenticator.getIdentity();
    return typeof identity?.userId === 'string' && identity.userId !== '' ? identity.userId : null;
  } catch {
    return null;
  }
}

/**
 * The gate of authkit's dev tools on the Agora dev MCP endpoint. Never throws.
 *
 * - `admin.enabled: false` → forbidden.
 * - `admin.authorize` set → its verdict alone decides: when it allows the MCP request, `admin.roles`
 *   is NOT checked (an MCP client has no console session; `authorize` is the app's explicit rule).
 * - `admin.authorize` omitted → forbidden in production. Outside production the caller must be
 *   signed in through authkit (MCP OAuth sign-in, or a personal agent granted `agora:dev`) as an
 *   active account holding one of `admin.roles`; signed out → unauthenticated.
 */
export function authkitDevToolsAuthorize(
  options: DevToolsGateOptions = {},
): (ctx: HttpContext) => Promise<DevToolsDecision> {
  const inProduction = options.inProduction ?? appInProduction;
  return async (ctx) => {
    try {
      const service = await ctx.containerResolver.make('authkit.server');
      const cfg = service.config;
      if (!cfg.admin?.enabled) return { allowed: false, reason: 'forbidden' };
      if (cfg.admin.authorize) {
        return fromConsoleDecision(await adminAuthorizeChecker(cfg.admin.authorize)(ctx));
      }
      if (inProduction()) return { allowed: false, reason: 'forbidden' };

      const accountId = await signedInAccountId(ctx);
      if (accountId === null) return { allowed: false, reason: 'unauthenticated' };
      const account = await cfg.accountStore.findById(accountId);
      if (!account) return { allowed: false, reason: 'unauthenticated' };
      const store = cfg.accountStore;
      if (supportsAccountStatus(store) && (await store.isDisabled(accountId))) {
        return { allowed: false, reason: 'forbidden' };
      }
      const allowedRoles = (cfg.admin.roles ?? []) as string[];
      const roles = await resolveAccountRoles(cfg, account);
      return roles.some((role) => allowedRoles.includes(role))
        ? { allowed: true }
        : { allowed: false, reason: 'forbidden' };
    } catch (error) {
      return { allowed: false, reason: 'forbidden', error };
    }
  };
}
