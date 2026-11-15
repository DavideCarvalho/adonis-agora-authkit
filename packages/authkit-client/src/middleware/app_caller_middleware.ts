import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';

interface ManagerLike {
  resolveAppCaller(ctx: HttpContext): Promise<void>;
}

/**
 * Server middleware registered by the provider when `service` is configured: a request
 * carrying a valid service token for this app gets `ctx.agora.caller`. Every other request
 * passes untouched.
 */
export default class AppCallerMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const manager = (await ctx.containerResolver.make('authkit.client')) as unknown as ManagerLike;
    await manager.resolveAppCaller(ctx);
    return next();
  }
}
