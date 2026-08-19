import type { AuthkitClientManager } from './providers/authkit_client_provider.js';

/**
 * SINGLE SOURCE of this package's container bindings.
 *
 * Deliberately separate from `types.ts`. `types.ts` augments
 * `HttpContext.auth`, and that augmentation is the HOST'S to choose: an app that
 * types its own `auth: Authenticator<AppUser>` cannot also receive the library's
 * non-parameterised `auth: Authenticator` without the two merging into a
 * conflict — one that `skipLibCheck` (on in every AdonisJS app) hides, leaving
 * whichever declaration wins by include order.
 *
 * The container binding has no such problem: it names a key only this package
 * owns. So it lives here, where the provider and the middleware can pull it in
 * without dragging `HttpContext.auth` into the consumer's program.
 *
 * If you add an augmentation here, ask first whether a host could legitimately
 * want to declare it differently. If yes, it belongs in `types.ts`, behind the
 * host's explicit opt-in.
 */
declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'authkit.client': AuthkitClientManager;
  }
}

export type { AuthkitClientManager };
