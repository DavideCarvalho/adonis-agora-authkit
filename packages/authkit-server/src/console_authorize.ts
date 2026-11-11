import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a console `authorize` returns. Same shape in every `@adonis-agora` console.
 *
 * - `true` / `{ allowed: true }` → allowed
 * - `false` / `{ allowed: false }` → 403
 * - `{ allowed: false, reason: 'unauthenticated' }` → 401
 * - `{ redirectTo }` → 302 to that path on a page navigation, 401 JSON on an API call
 */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/**
 * Who may open a console: an inline function, an authorizer class, or a lazy
 * import of a module whose default export is an authorizer class.
 */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** The normalized outcome of a `ConsoleAuthorize` call. */
export type ConsoleAuthorizeDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; redirectTo?: string };

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function isLazyModule(value: unknown): value is { default: ConsoleAuthorizerClass } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    isAuthorizerClass((value as { default: unknown }).default)
  );
}

export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  if (result === true) return { allowed: true };
  if (typeof result === 'object' && result !== null) {
    const r = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
    if (typeof r.redirectTo === 'string' && r.redirectTo.length > 0) {
      return { allowed: false, status: 401, redirectTo: r.redirectTo };
    }
    if (r.allowed === true) return { allowed: true };
    if (r.allowed === false && r.reason === 'unauthenticated') {
      return { allowed: false, status: 401 };
    }
  }
  // `false`, `{ allowed: false }` and anything unrecognized deny.
  return { allowed: false, status: 403 };
}

async function runClass(Authorizer: ConsoleAuthorizerClass, ctx: HttpContext): Promise<unknown> {
  const instance = (await ctx.containerResolver.make(Authorizer)) as ConsoleAuthorizer;
  return instance.authorize(ctx);
}

/**
 * Turns a `ConsoleAuthorize` into a checker returning a normalized decision.
 * A class is built through the container (so `@inject()` works); a lazy import
 * runs once and its class is remembered. A thrown error is a denial (403).
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
): (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> {
  let lazyClass: ConsoleAuthorizerClass | undefined;
  return async (ctx) => {
    try {
      if (isAuthorizerClass(authorize)) {
        return normalizeConsoleAuthorizeResult(await runClass(authorize, ctx));
      }
      if (lazyClass) return normalizeConsoleAuthorizeResult(await runClass(lazyClass, ctx));
      const result = await (authorize as (ctx: HttpContext) => unknown)(ctx);
      if (isLazyModule(result)) {
        lazyClass = result.default;
        return normalizeConsoleAuthorizeResult(await runClass(lazyClass, ctx));
      }
      return normalizeConsoleAuthorizeResult(result);
    } catch (error) {
      (ctx as { logger?: { warn?: (...args: unknown[]) => void } }).logger?.warn?.(
        { err: error },
        'console authorize threw; access denied',
      );
      return { allowed: false, status: 403 };
    }
  };
}

/**
 * A `ConsoleAuthorize` that lets in requests carrying `Authorization: Bearer <token>`.
 * The comparison is timing-safe. Anything else is `{ allowed: false, reason: 'unauthenticated' }`.
 * Throws when `token` is empty, so a missing env var fails at config time.
 *
 * ```ts
 * authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') })
 * ```
 */
export function authorizeByToken(options: {
  token: string | undefined | null;
}): (ctx: HttpContext) => ConsoleAuthorizeResult {
  const token = options?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('authorizeByToken: `token` is empty. Set it (e.g. env CONSOLE_TOKEN).');
  }
  const expected = createHash('sha256').update(token).digest();
  return (ctx) => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match) {
      const given = createHash('sha256').update(match[1]!).digest();
      if (timingSafeEqual(given, expected)) return { allowed: true };
    }
    return { allowed: false, reason: 'unauthenticated' };
  };
}
