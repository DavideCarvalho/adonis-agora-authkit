/**
 * Inbound half of calls between apps: a request carrying a service token for THIS app
 * (`aud` = `urn:agora:app:<service.name>`) is verified and its caller exposed as
 * `ctx.agora.caller`. Every other request (users, user tokens, anonymous) is untouched.
 *
 * A caller is an app, never a user: `ctx.authkit` / `ctx.auth` are not bound for it, so
 * user gates (`auth` middleware, `authkitDashboardAuthorize`) keep refusing it. Routes
 * meant for other apps use {@link authkitService}.
 */

import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { decodeJwt } from 'jose';
import { type DiscoverOptions } from '../discovery.js';
import { AuthkitTenantVerifier } from '../tenant_verifier.js';
import { appResource } from './config.js';

/** The app that made the request, read from its verified service token. */
export interface AgoraCaller {
  /** The calling app (the token's `partition`). */
  app: string;
  /** What the calling app was granted on this app (the token's `capabilities`). */
  capabilities: string[];
  /** The calling app's environment, when its token has one. */
  environment?: string;
  /** The service-tenant client of the calling app. */
  clientId: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

/** `ctx.agora`: what the Agora libs put on a request. */
export interface AgoraRequestContext {
  /** The app that called, when the request carries a valid service token for this app. */
  caller?: AgoraCaller;
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Set by the Agora libs. `caller`: the app that made this request (calls between apps). */
    agora?: AgoraRequestContext;
  }
}

/** The app that made this request, or `undefined` (a user, or no valid service token). */
export function getAgoraCaller(ctx: HttpContext): AgoraCaller | undefined {
  return (ctx as { agora?: AgoraRequestContext }).agora?.caller;
}

/** `Bearer <token>` of a request, or `undefined`. */
function bearerOf(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** `true` when the (unverified) token is addressed to `audience`; never throws. */
function addressedTo(token: string, audience: string): boolean {
  try {
    const aud = decodeJwt(token).aud;
    return aud === audience || (Array.isArray(aud) && aud.includes(audience));
  } catch {
    return false;
  }
}

/** Verifies service tokens addressed to this app. */
export class AppCallerVerifier {
  readonly audience: string;
  #verifier: AuthkitTenantVerifier;

  constructor(options: {
    issuer: string;
    name: string;
    environment?: string;
    discovery?: Pick<DiscoverOptions, 'fetchImpl' | 'cacheTtlMs' | 'resilience' | 'overrides'>;
  }) {
    this.audience = appResource(options.name);
    this.#verifier = new AuthkitTenantVerifier({
      issuer: options.issuer,
      resource: this.audience,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.discovery ? { discovery: options.discovery } : {}),
    });
  }

  /**
   * `undefined` when the request carries no token for this app (leave it alone); `null`
   * when it does but the token does not verify; the caller otherwise.
   */
  async callerOf(ctx: HttpContext): Promise<AgoraCaller | null | undefined> {
    const token = bearerOf(ctx);
    if (!token || !addressedTo(token, this.audience)) return undefined;
    const verified = await this.#verifier.verify({ token });
    if (!verified) return null;
    return {
      app: verified.partition,
      capabilities: verified.capabilities,
      ...(verified.environment ? { environment: verified.environment } : {}),
      clientId: verified.clientId,
      expiresAt: verified.expiresAt,
    };
  }
}

interface LoggerLike {
  warn(obj: unknown, msg?: string): void;
}

/** Marker for a request whose service token for this app did not verify. */
const REJECTED = Symbol('agora.caller.rejected');

/**
 * Runs the inbound check on one request (the server middleware's body): sets
 * `ctx.agora.caller` for a valid service token addressed to this app; leaves every other
 * request alone.
 */
export async function resolveAppCaller(
  ctx: HttpContext,
  verifier: AppCallerVerifier,
  logger?: LoggerLike,
): Promise<void> {
  let caller: AgoraCaller | null | undefined;
  try {
    caller = await verifier.callerOf(ctx);
  } catch (error) {
    // Issuer unreachable: no caller (protected routes refuse), the request goes on.
    logger?.warn({ err: error }, 'authkit: could not verify a service token');
    caller = null;
  }
  if (caller === undefined) return;
  const holder = ctx as { agora?: AgoraRequestContext } & { [REJECTED]?: true };
  if (caller === null) {
    holder[REJECTED] = true;
    return;
  }
  holder.agora = { ...holder.agora, caller };
}

/** Options of {@link authkitService}. */
export interface AuthkitServiceOptions {
  /** Every one of these must be in the caller's capabilities. Default: none. */
  capabilities?: string[];
  /** Only these apps may call. Default: any app holding a valid token for this one. */
  apps?: string[];
}

/**
 * Route middleware for routes only other apps may call:
 *
 * ```ts
 * import { authkitService } from '@adonis-agora/authkit-client'
 *
 * router
 *   .post('/internal/invoices', [InvoicesController, 'store'])
 *   .use(authkitService({ capabilities: ['invoices:write'] }))
 * ```
 *
 * No valid service token for this app → 401; a caller without a required capability or
 * not in `apps` → 403. The caller is `ctx.agora.caller`.
 */
export function authkitService(options: AuthkitServiceOptions = {}) {
  const required = options.capabilities ?? [];
  const apps = options.apps;
  return async function authkitServiceMiddleware(ctx: HttpContext, next: NextFn) {
    const caller = getAgoraCaller(ctx);
    if (!caller) {
      const rejected = (ctx as { [REJECTED]?: true })[REJECTED] === true;
      ctx.response.header(
        'WWW-Authenticate',
        rejected ? 'Bearer realm="agora", error="invalid_token"' : 'Bearer realm="agora"',
      );
      return ctx.response.unauthorized({
        error: rejected ? 'invalid_token' : 'unauthorized',
        message: rejected
          ? 'The service token is invalid or expired.'
          : 'This route only accepts calls from other apps.',
      });
    }
    if (apps && !apps.includes(caller.app)) {
      return ctx.response.forbidden({
        error: 'forbidden',
        message: `${caller.app} may not call this route.`,
      });
    }
    const missing = required.filter((c) => !caller.capabilities.includes(c));
    if (missing.length) {
      ctx.response.header(
        'WWW-Authenticate',
        `Bearer realm="agora", error="insufficient_scope", scope="${missing.join(' ')}"`,
      );
      return ctx.response.forbidden({
        error: 'insufficient_capabilities',
        message: `Missing capabilities: ${missing.join(', ')}.`,
      });
    }
    return next();
  };
}
