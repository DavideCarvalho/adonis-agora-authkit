// Side-effect import: pulls the `HttpContext.auth` module augmentation (declared
// in the package root `types.ts`) into this module's declaration graph, so an app
// that registers this middleware gets `ctx.auth` typed as AuthKit's `Authenticator`.
// It lives here — and not in `index.ts` — because this middleware is what actually
// assigns `ctx.auth`. Apps that instead hand `ctx.auth` to `@adonisjs/auth` via
// `authkitClientGuard` never register this middleware, so the two owners of
// `ctx.auth` can never collide. Same pattern as `@adonisjs/auth`, which augments
// `HttpContext` from its own `initialize_auth_middleware`.
// It must be a bare side-effect import, not `import type {} from`: the type-only form
// is erased from the emitted `.d.ts` as well, which would drop the augmentation again.
// The runtime cost is nil — `build/types.js` is this package's own file and compiles
// down to `export {}`.
import '../../types.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';

export default class AuthkitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const manager = await ctx.containerResolver.make('authkit.client');
    // Renova proativamente o TokenSet (rotação de refresh token) antes de resolver.
    await manager.maybeRefresh(ctx);
    ctx.auth = await manager.createAuthenticator(ctx);
    return next();
  }
}
