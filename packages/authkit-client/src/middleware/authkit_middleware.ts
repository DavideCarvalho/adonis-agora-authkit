// Side-effect import: carries this package's `ContainerBindings` declaration into
// the emitted `.d.ts`, so `containerResolver.make('authkit.client')` is typed in a
// consumer's program. It must be a bare side-effect import — the
// `import type {} from` form is erased from the declaration output.
//
// It points at `container_bindings.js`, NOT at the root `types.js`. `types.js`
// also augments `HttpContext.auth`, and importing it here pushed that
// augmentation into every app that registers this middleware, where it collided
// with the app's own `auth: Authenticator<AppUser>`. `skipLibCheck` hid the
// conflict and the library's non-parameterised declaration won, collapsing
// `auth.getUser()` to `unknown` across the consumer's codebase. Typing `ctx.auth`
// is the host's decision, taken by importing
// `@adonis-agora/authkit-client/types`; it is not this middleware's to impose.
import '../../container_bindings.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { setCtxAuth } from '../host/ctx_auth.js';

export default class AuthkitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const manager = await ctx.containerResolver.make('authkit.client');
    // Renova proativamente o TokenSet (rotação de refresh token) antes de resolver.
    await manager.maybeRefresh(ctx);
    setCtxAuth(ctx, await manager.createAuthenticator(ctx));
    return next();
  }
}
